import { agencyLanguage, type AgencyLanguage } from "../../i18n/language.js";
import { createRepositories } from "../../db/repositories.js";
import type { SqlDatabase } from "../../db/sql";
import type { Job, NeedsInputQuestion } from "../../../shared/contracts";
import { latestHandedInVersion, productReadyMessage } from "../conveyor/station.js";
import type { IsolatedSendOutcome, IsolatedSendPort } from "../isolated-sdk/send-port.js";
import { isOriginThreadId } from "./origin.js";

export const CLIENT_BOUNCE_MIGRATION = `ALTER TABLE agency_job ADD COLUMN origin_thread_id TEXT;
CREATE TABLE agency_client_bounce (
    wait_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    origin_thread_id TEXT NOT NULL,
    send_state TEXT NOT NULL CHECK(send_state IN ('pending', 'queued', 'confirmed', 'unknown', 'rejected', 'skipped')),
    send_code TEXT,
    send_message TEXT,
    dispatch_claimed INTEGER NOT NULL DEFAULT 0,
    queued_message_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES agency_job(id)
  );
CREATE INDEX agency_client_bounce_origin_idx ON agency_client_bounce(origin_thread_id);
CREATE INDEX agency_client_bounce_pending_idx ON agency_client_bounce(send_state, dispatch_claimed)`;

type BounceRow = {
  wait_id: string;
  job_id: string;
  origin_thread_id: string;
  send_state: string;
  send_code: string | null;
  send_message: string | null;
  dispatch_claimed: number;
  queued_message_id: string | null;
  created_at: string;
  updated_at: string;
};

type ClaimedBounce = { row: BounceRow; sendNow: boolean };

type WaitRow = {
  wait_id: string;
  job_id: string;
  thread_id: string;
  questions_json: string;
  closed_at: string | null;
};

export function clientBounceToken(waitId: string): string {
  return `agency.clientBounce:${waitId}`;
}

export function formatClientBounceText(
  job: { key: string; title: string; id: string },
  questions: readonly NeedsInputQuestion[],
  waitId: string,
  lang: AgencyLanguage = agencyLanguage(),
): string {
  const lines =
    lang === "en"
      ? [
          `Agency factory pause on ${job.key}: ${job.title}.`,
          "The worker needs materials from this chat (the one that commissioned the job). Do not open the Agency card unless this chat cannot answer.",
          "",
          ...questions.map((item, index) => `${index + 1}. ${item.text}`),
          "",
          "A native choice card is opening in this chat. Wait until the owner clicks an option and presses Send — do not paste A/B/C as markdown. If no card appears, call agency_ask_owner. Answers apply to every listed job that asked the same questions.",
          `waitId ${waitId}`,
          clientBounceToken(waitId),
        ]
      : [
          `Пауза завода на ${job.key}: ${job.title}.`,
          "Исполнителю не хватает сырья. Вопрос вернулся в этот чат — тот, откуда ставили задачу. Карточку Агентства открывать не нужно, если можно ответить здесь.",
          "",
          ...questions.map((item, index) => `${index + 1}. ${item.text}`),
          "",
          "Сейчас откроется штатная карточка выбора. Владелец нажимает вариант и Send — не дублируйте опрос A/B/C текстом. Если карточки нет, вызовите agency_ask_owner. Один ответ уйдёт во все задачи с теми же вопросами.",
          `waitId ${waitId}`,
          clientBounceToken(waitId),
        ];
  return lines.join("\n");
}

export function formatPendingClientQuestions(db: SqlDatabase, originThreadId: string, lang: AgencyLanguage = agencyLanguage()): string | null {
  if (!hasBounceTable(db) || !isOriginThreadId(originThreadId)) return null;
  const rows = db
    .prepare(
      `SELECT j.key
       FROM agency_job_needs_input_wait w
       JOIN agency_job j ON j.id = w.job_id
       WHERE j.origin_thread_id = ? AND w.closed_at IS NULL AND j.state = 'waiting_input'
       ORDER BY w.created_at`,
    )
    .all(originThreadId) as Array<{ key: string }>;
  if (rows.length === 0) return null;
  const keys = [...new Set(rows.map((row) => row.key))];
  return lang === "en"
    ? [
        "## Agency is waiting on this chat",
        `${keys.join(", ")}: a native choice card will open. Do not answer in the thread. If the card is missing, call agency_ask_owner.`,
      ].join("\n")
    : [
        "## Агентство ждёт ответ в этом чате",
        `${keys.join(", ")}: откроется штатная карточка выбора. Не отвечайте текстом сообщения. Если карточки нет — agency_ask_owner.`,
      ].join("\n");
}

function hasBounceTable(db: SqlDatabase): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agency_client_bounce'`).get());
}

function readOpenWait(db: SqlDatabase, jobId: string): WaitRow | undefined {
  return db
    .prepare(`SELECT wait_id, job_id, thread_id, questions_json, closed_at FROM agency_job_needs_input_wait WHERE job_id = ? AND closed_at IS NULL`)
    .get(jobId) as WaitRow | undefined;
}

function originOf(job: Pick<Job, "originThreadId"> | { originThreadId?: string | null }): string | null {
  const value = job.originThreadId?.trim() || null;
  return isOriginThreadId(value) ? value : null;
}

/** Queue a send to the commissioning chat. No-op when origin is missing or is the worker thread. */
export function enqueueClientBounce(db: SqlDatabase, job: Job, waitId: string, now: string): boolean {
  if (!hasBounceTable(db)) return false;
  const origin = originOf(job);
  if (!origin) return false;
  const wait = readOpenWait(db, job.id);
  if (!wait || wait.wait_id !== waitId || wait.closed_at) return false;
  if (wait.thread_id === origin) return false;
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO agency_client_bounce (
        wait_id, job_id, origin_thread_id, send_state, send_code, send_message,
        dispatch_claimed, queued_message_id, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', NULL, NULL, 0, NULL, ?, ?)`,
    )
    .run(waitId, job.id, origin, now, now);
  if (result.changes > 0) return true;
  db.prepare(
    `UPDATE agency_client_bounce SET origin_thread_id = ?, updated_at = ?
     WHERE wait_id = ? AND send_state IN ('pending', 'queued', 'unknown')`,
  ).run(origin, now, waitId);
  return false;
}

export function enqueueClientBounceForOpenWait(db: SqlDatabase, job: Job, now: string): boolean {
  const wait = readOpenWait(db, job.id);
  if (!wait) return false;
  return enqueueClientBounce(db, job, wait.wait_id, now);
}

export function productReadyBounceId(jobId: string, hash: string): string {
  return `product:${jobId}:${hash}`;
}

export function productReadyToken(jobId: string, hash: string): string {
  return `agency.productReady:${jobId}:${hash}`;
}

function isProductBounce(waitId: string): boolean {
  return waitId.startsWith("product:");
}

/** Queue «the product is ready» to the commissioning chat. Root jobs only. */
export function enqueueProductReady(db: SqlDatabase, job: Job, now: string): boolean {
  if (!hasBounceTable(db)) return false;
  if (job.state !== "done" || job.parentJobId) return false;
  const origin = originOf(job);
  if (!origin) return false;
  const version = latestHandedInVersion(db, job.id);
  if (!version) return false;
  const waitId = productReadyBounceId(job.id, version.hash);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO agency_client_bounce (
        wait_id, job_id, origin_thread_id, send_state, send_code, send_message,
        dispatch_claimed, queued_message_id, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', NULL, NULL, 0, NULL, ?, ?)`,
    )
    .run(waitId, job.id, origin, now, now);
  if (result.changes > 0) return true;
  db.prepare(
    `UPDATE agency_client_bounce SET origin_thread_id = ?, updated_at = ?
     WHERE wait_id = ? AND send_state IN ('pending', 'queued', 'unknown')`,
  ).run(origin, now, waitId);
  return false;
}

export function recoverClientBouncesFromOpenWaits(db: SqlDatabase, now: string): number {
  if (!hasBounceTable(db)) return 0;
  const repos = createRepositories(db);
  const rows = db
    .prepare(
      `SELECT job_id FROM agency_job_needs_input_wait WHERE closed_at IS NULL`,
    )
    .all() as Array<{ job_id: string }>;
  let inserted = 0;
  for (const row of rows) {
    const job = repos.job.get(row.job_id);
    if (!job || job.state !== "waiting_input") continue;
    if (enqueueClientBounceForOpenWait(db, job, now)) inserted += 1;
  }
  return inserted;
}

function readBounce(db: SqlDatabase, waitId: string): BounceRow | undefined {
  return db.prepare(`SELECT * FROM agency_client_bounce WHERE wait_id = ?`).get(waitId) as BounceRow | undefined;
}

function bounceStillOpen(db: SqlDatabase, row: BounceRow): boolean {
  const job = createRepositories(db).job.get(row.job_id);
  if (!job) return false;
  const origin = originOf(job);
  if (!origin || origin !== row.origin_thread_id) return false;
  if (isProductBounce(row.wait_id)) {
    return job.state === "done" && !job.parentJobId;
  }
  const wait = readOpenWait(db, row.job_id);
  if (!wait || wait.wait_id !== row.wait_id) return false;
  return job.state === "waiting_input" && wait.thread_id !== origin;
}

function claimPending(db: SqlDatabase, now: string): ClaimedBounce[] {
  const pending = db
    .prepare(
      `SELECT * FROM agency_client_bounce
       WHERE send_state IN ('pending', 'queued', 'unknown')
       ORDER BY created_at`,
    )
    .all() as BounceRow[];
  const claimed: ClaimedBounce[] = [];
  for (const row of pending) {
    if (row.send_state === "pending" && row.dispatch_claimed === 0) {
      const updated = db
        .prepare(
          `UPDATE agency_client_bounce SET dispatch_claimed = 1, updated_at = ?
           WHERE wait_id = ? AND dispatch_claimed = 0 AND send_state = 'pending'`,
        )
        .run(now, row.wait_id);
      if (updated.changes > 0) claimed.push({ row: { ...row, dispatch_claimed: 1 }, sendNow: true });
      continue;
    }
    if (row.send_state === "queued" || row.send_state === "unknown") {
      claimed.push({ row, sendNow: false });
    }
  }
  return claimed;
}

function markSkipped(db: SqlDatabase, row: BounceRow, now: string, code: string, message: string): void {
  db.prepare(
    `UPDATE agency_client_bounce SET send_state = 'skipped', send_code = ?, send_message = ?, updated_at = ?
     WHERE wait_id = ?`,
  ).run(code, message, now, row.wait_id);
}

function writeOutcome(
  db: SqlDatabase,
  row: BounceRow,
  outcome: IsolatedSendOutcome | { kind: "recovered" },
  now: string,
): void {
  if (outcome.kind === "recovered") {
    db.prepare(
      `UPDATE agency_client_bounce SET send_state = 'confirmed', send_code = NULL, send_message = NULL, updated_at = ?
       WHERE wait_id = ?`,
    ).run(now, row.wait_id);
    return;
  }
  if (outcome.kind === "confirmed") {
    if (outcome.delivery === "queued") {
      db.prepare(
        `UPDATE agency_client_bounce SET send_state = 'queued', queued_message_id = ?, send_code = NULL, send_message = NULL, updated_at = ?
         WHERE wait_id = ?`,
      ).run(outcome.queuedMessageId ?? null, now, row.wait_id);
      return;
    }
    db.prepare(
      `UPDATE agency_client_bounce SET send_state = 'confirmed', queued_message_id = NULL, send_code = NULL, send_message = NULL, updated_at = ?
       WHERE wait_id = ?`,
    ).run(now, row.wait_id);
    return;
  }
  if (outcome.kind === "unknown") {
    db.prepare(
      `UPDATE agency_client_bounce SET send_state = 'unknown', send_code = ?, send_message = ?, updated_at = ?
       WHERE wait_id = ?`,
    ).run(outcome.code, outcome.message, now, row.wait_id);
    return;
  }
  db.prepare(
    `UPDATE agency_client_bounce SET send_state = 'rejected', send_code = ?, send_message = ?, updated_at = ?
     WHERE wait_id = ?`,
  ).run(outcome.code, outcome.message, now, row.wait_id);
}

export async function flushClientBounces(deps: {
  db: SqlDatabase;
  send: IsolatedSendPort;
  now: string;
}): Promise<void> {
  if (!hasBounceTable(deps.db)) return;
  const claimed = deps.db.transaction(() => claimPending(deps.db, deps.now))();
  for (const item of claimed) {
    const live = deps.db.transaction(() => {
      const row = readBounce(deps.db, item.row.wait_id) ?? item.row;
      if (!bounceStillOpen(deps.db, row)) {
        markSkipped(deps.db, row, deps.now, "wait_closed", "open wait or origin no longer matches");
        return { ok: false as const };
      }
      const job = createRepositories(deps.db).job.get(row.job_id);
      if (!job) {
        markSkipped(deps.db, row, deps.now, "wait_closed", "job missing");
        return { ok: false as const };
      }
      if (!isProductBounce(row.wait_id)) {
        markSkipped(deps.db, row, deps.now, "card_only", "native choice card, not a chat turn");
        return { ok: false as const };
      }
      const version = latestHandedInVersion(deps.db, job.id);
      if (!version) {
        markSkipped(deps.db, row, deps.now, "wait_closed", "accepted version missing");
        return { ok: false as const };
      }
      const message = productReadyMessage(deps.db, job, version);
      return {
        ok: true as const,
        row,
        text: `${message.text}\n${productReadyToken(job.id, version.hash)}`,
        token: productReadyToken(job.id, version.hash),
      };
    })();
    if (!live.ok) continue;
    const text = live.text;
    let outcome: IsolatedSendOutcome | { kind: "recovered" };
    try {
      if (item.sendNow) {
        outcome = await deps.send.send({ threadId: live.row.origin_thread_id, text });
      } else {
        const presence = await deps.send.recoverContinuation(
          live.row.origin_thread_id,
          live.token,
          live.row.queued_message_id,
        );
        if (presence === "present") outcome = { kind: "recovered" };
        else if (presence === "queued") {
          outcome = { kind: "confirmed", delivery: "queued", queuedMessageId: live.row.queued_message_id ?? undefined };
        } else {
          continue;
        }
      }
    } catch {
      outcome = { kind: "unknown", code: "send_transport", message: item.sendNow ? "send failed" : "recover failed" };
    }
    deps.db.transaction(() => writeOutcome(deps.db, live.row, outcome, deps.now))();
  }
}
