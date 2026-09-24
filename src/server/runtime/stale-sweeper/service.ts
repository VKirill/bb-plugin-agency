import { completionWaitingDependencies } from "../completion-reminder/service";
import type { DomainResult } from "../../../domain";
import type { Job, WorkRules } from "../../../shared/contracts";
import { batchId, nudgeId, staleBatchToken, staleNudgeToken } from "../../../shared/contracts/stale-nudge";
import type { SqlDatabase } from "../../db/sql";
import { dependencyLinks } from "../../flow/service.js";
import { agencyLanguage, type AgencyLanguage } from "../../i18n/language.js";
import { recordOwnerMessage as defaultRecordOwnerMessage, type OwnerMessage } from "../../owner-messages/service.js";
import { isOriginThreadId } from "../client-bounce/origin.js";
import type { IsolatedSendOutcome, IsolatedSendPort } from "../isolated-sdk/send-port.js";

export const STALE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
export const STALE_BATCH_SIZE = 10;
export const STALE_ORIGIN_HOUR_MS = 60 * 60 * 1000;

const LIVE_ATTEMPT_STATES = ["prepared", "launching", "running", "waiting_input", "unknown"] as const;
const OPEN_SEND = ["pending", "queued", "unknown"] as const;

export type StaleRules = Pick<
  WorkRules,
  "staleHoursBlocked" | "staleHoursRunning" | "staleRepeatHours" | "staleMaxAttempts"
>;

export type StaleNudgeRow = {
  nudge_id: string;
  batch_id: string | null;
  job_id: string;
  origin_thread_id: string;
  state_since: string;
  attempt: number;
  send_state: string;
  dispatch_claimed: number;
  queued_message_id: string | null;
  revision_at_send: number | null;
  next_check_at: string | null;
  decision: string | null;
  reason_code: string | null;
  created_at: string;
};

export type RecordOwnerMessageFn = (
  db: SqlDatabase,
  input: { text: string; level?: "info" | "warning"; jobId?: string | null; dedupeKey?: string },
  source: string,
  now: string,
) => DomainResult<{ message: OwnerMessage; duplicate: boolean }>;

export type StaleSweepPorts = {
  isActive?: () => boolean;
  db: SqlDatabase;
  getJob: (id: string) => Job | undefined;
  /** register.ts uses this name; keep it so that file stays untouched. */
  rulesFor?: (departmentId: string) => StaleRules;
  rulesForDepartment?: (departmentId: string) => StaleRules;
  comment?: (job: Job, text: string) => boolean;
  addSystemComment?: (job: Job, text: string) => boolean;
  recordOwnerMessage?: RecordOwnerMessageFn;
  send: IsolatedSendPort;
  now: () => Date;
  lang?: AgencyLanguage;
  /** Official thread status (`idle`, `active`, …). Null = could not read. */
  observeThread?: (threadId: string) => Promise<string | null>;
};

/** Statuses run-watch still owns. Idle is the completion reminder; the sweeper may take it. */
const RUN_WATCH_OWNED_STATUSES = new Set(["active", "stopping", "pending", "starting", "error"]);

export function isRunWatchOwnedStatus(status: string | null | undefined): boolean {
  return Boolean(status && RUN_WATCH_OWNED_STATUSES.has(status));
}

export type StaleCandidateOpts = {
  /** False when the leftover attempt is idle/gone. Omit or true = treat as watched. */
  liveAttemptWatched?: boolean;
};

function rulesOf(ports: StaleSweepPorts, departmentId: string): StaleRules {
  const read = ports.rulesFor ?? ports.rulesForDepartment;
  if (!read) throw new Error("stale-sweeper: rulesForDepartment is required");
  return read(departmentId);
}

function commentOf(ports: StaleSweepPorts, job: Job, text: string): boolean {
  const write = ports.comment ?? ports.addSystemComment;
  return write ? write(job, text) : false;
}

function recordOf(ports: StaleSweepPorts): RecordOwnerMessageFn {
  return ports.recordOwnerMessage ?? defaultRecordOwnerMessage;
}

export type StaleSweepStats = {
  candidates: number;
  inserted: number;
  sent: number;
  commented: number;
  escalated: number;
};

function hasTable(db: SqlDatabase): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agency_stale_nudge'`).get());
}

function hoursMs(hours: number): number {
  return hours * 3_600_000;
}

function iso(now: Date): string {
  return now.toISOString();
}

export function lastMovementAt(db: SqlDatabase, job: Pick<Job, "id" | "updatedAt">): string {
  const row = db
    .prepare(
      `SELECT MAX(ts) AS ts FROM (
         SELECT updated_at AS ts FROM agency_job WHERE id = ?
         UNION ALL
         SELECT timestamp AS ts FROM agency_activity
          WHERE job_id = ? AND kind = 'comment' AND comment IS NOT NULL
            AND actor NOT LIKE '%"kind":"system"%'
         UNION ALL
         SELECT created_at AS ts FROM agency_run_attempt WHERE job_id = ?
       )`,
    )
    .get(job.id, job.id, job.id) as { ts: string | null } | undefined;
  return row?.ts ?? job.updatedAt;
}

export function stateSinceOf(db: SqlDatabase, job: Pick<Job, "id" | "state" | "updatedAt">): string {
  const rows = db
    .prepare(
      `SELECT timestamp, references_json FROM agency_activity
       WHERE job_id = ? AND kind = 'job_transitioned' ORDER BY timestamp DESC`,
    )
    .all(job.id) as Array<{ timestamp: string; references_json: string }>;
  for (const row of rows) {
    try {
      const refs = JSON.parse(row.references_json) as Array<{ type?: string; id?: string }>;
      if (refs.some((item) => item.type === "job_state" && item.id === job.state)) return row.timestamp;
    } catch {
      /* stored text */
    }
  }
  return job.updatedAt;
}

export function hasLiveAttempt(db: SqlDatabase, jobId: string): boolean {
  const placeholders = LIVE_ATTEMPT_STATES.map(() => "?").join(", ");
  return Boolean(
    db.prepare(`SELECT 1 FROM agency_run_attempt WHERE job_id = ? AND state IN (${placeholders}) LIMIT 1`).get(jobId, ...LIVE_ATTEMPT_STATES),
  );
}

export function liveAttemptThreadId(db: SqlDatabase, jobId: string): string | null {
  const placeholders = LIVE_ATTEMPT_STATES.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT thread_id FROM agency_run_attempt WHERE job_id = ? AND state IN (${placeholders}) AND thread_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(jobId, ...LIVE_ATTEMPT_STATES) as { thread_id: string } | undefined;
  return row?.thread_id ?? null;
}

export async function liveAttemptIsWatched(ports: Pick<StaleSweepPorts, "db" | "observeThread">, jobId: string): Promise<boolean> {
  if (!hasLiveAttempt(ports.db, jobId)) return false;
  if (!ports.observeThread) return true;
  const threadId = liveAttemptThreadId(ports.db, jobId);
  if (!threadId) return true;
  try {
    const status = await ports.observeThread(threadId);
    if (status == null) return true;
    return isRunWatchOwnedStatus(status);
  } catch {
    return true;
  }
}

export function hasOpenDependency(db: SqlDatabase, jobId: string): boolean {
  return dependencyLinks(db, jobId).waitsFor.some((link) => link.state !== "done" && link.state !== "canceled");
}

export function isInLaunchQueue(db: SqlDatabase, jobId: string): boolean {
  return Boolean(
    db.prepare(`SELECT 1 FROM agency_launch_queue WHERE job_id = ? AND dropped_at IS NULL LIMIT 1`).get(jobId),
  );
}

export function hasOpenNeedsInputWait(db: SqlDatabase, jobId: string): boolean {
  return Boolean(
    db.prepare(`SELECT 1 FROM agency_job_needs_input_wait WHERE job_id = ? AND closed_at IS NULL LIMIT 1`).get(jobId),
  );
}

export function parentBlocksSweep(db: SqlDatabase, job: Pick<Job, "parentJobId">): boolean {
  if (!job.parentJobId) return false;
  const parent = db.prepare(`SELECT state FROM agency_job WHERE id = ?`).get(job.parentJobId) as { state: string } | undefined;
  return parent?.state === "done" || parent?.state === "canceled";
}

function workerUsesOrigin(db: SqlDatabase, jobId: string, origin: string): boolean {
  const placeholders = LIVE_ATTEMPT_STATES.map(() => "?").join(", ");
  return Boolean(
    db
      .prepare(`SELECT 1 FROM agency_run_attempt WHERE job_id = ? AND thread_id = ? AND state IN (${placeholders}) LIMIT 1`)
      .get(jobId, origin, ...LIVE_ATTEMPT_STATES),
  );
}

/** A coordinator/reviewer waiting on concrete active work is not an abandoned task.
 * Blocked/review children still require the lead's attention; unrelated siblings never suppress a nudge.
 */
function hasExpectedWork(db: SqlDatabase, job: Job): boolean {
  const working = (id: string, state: string) =>
    (state === "running" && hasLiveAttempt(db, id)) || (state === "queued" && isInLaunchQueue(db, id));
  const children = db.prepare("SELECT id, state FROM agency_job WHERE parent_job_id = ? AND state NOT IN ('done','canceled')")
    .all(job.id) as Array<{ id: string; state: string }>;
  if (children.length) return children.every(child => working(child.id, child.state));
  const inputs = completionWaitingDependencies(db, job);
  return inputs.length > 0 && inputs.every(id => {
    const source = db.prepare("SELECT state FROM agency_job WHERE id = ?").get(id) as { state: string } | undefined;
    return Boolean(source && working(id, source.state));
  });
}

export function isStaleCandidate(
  db: SqlDatabase,
  job: Job,
  rules: StaleRules,
  now: Date,
  opts?: StaleCandidateOpts,
): { ok: true; stateSince: string; movementAt: string } | { ok: false; reason: string } {
  if (job.state !== "blocked" && job.state !== "running") return { ok: false, reason: "not_state" };
  if (job.state === "blocked" && rules.staleHoursBlocked <= 0) return { ok: false, reason: "rule_off" };
  if (job.state === "running" && rules.staleHoursRunning <= 0) return { ok: false, reason: "rule_off" };
  if (rules.staleMaxAttempts <= 0) return { ok: false, reason: "rule_off" };
  // Blocked leftovers are zombies. A running attempt is watched only while the
  // thread is active/pending/error — idle belongs to completion, not run-watch.
  if (job.state === "running" && hasLiveAttempt(db, job.id) && opts?.liveAttemptWatched !== false) {
    return { ok: false, reason: "live_attempt" };
  }
  if (job.state === "running" && hasExpectedWork(db, job)) return { ok: false, reason: "expected_work" };
  if (hasOpenDependency(db, job.id)) return { ok: false, reason: "open_dependency" };
  if (isInLaunchQueue(db, job.id)) return { ok: false, reason: "launch_queue" };
  if (hasOpenNeedsInputWait(db, job.id)) return { ok: false, reason: "needs_input" };
  if (parentBlocksSweep(db, job)) return { ok: false, reason: "parent_closed" };
  const movementAt = lastMovementAt(db, job);
  const threshold = job.state === "blocked" ? rules.staleHoursBlocked : rules.staleHoursRunning;
  if (now.getTime() - Date.parse(movementAt) < hoursMs(threshold)) return { ok: false, reason: "fresh" };
  return { ok: true, stateSince: stateSinceOf(db, job), movementAt };
}

function listNudges(db: SqlDatabase, jobId: string, stateSince: string): StaleNudgeRow[] {
  return db
    .prepare(`SELECT * FROM agency_stale_nudge WHERE job_id = ? AND state_since = ? ORDER BY attempt`)
    .all(jobId, stateSince) as StaleNudgeRow[];
}

function readNudge(db: SqlDatabase, id: string): StaleNudgeRow | undefined {
  return db.prepare(`SELECT * FROM agency_stale_nudge WHERE nudge_id = ?`).get(id) as StaleNudgeRow | undefined;
}

function insertNudge(db: SqlDatabase, row: StaleNudgeRow): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO agency_stale_nudge (
         nudge_id, batch_id, job_id, origin_thread_id, state_since, attempt, send_state,
         dispatch_claimed, queued_message_id, revision_at_send, next_check_at, decision, reason_code, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.nudge_id,
      row.batch_id,
      row.job_id,
      row.origin_thread_id,
      row.state_since,
      row.attempt,
      row.send_state,
      row.dispatch_claimed,
      row.queued_message_id,
      row.revision_at_send,
      row.next_check_at,
      row.decision,
      row.reason_code,
      row.created_at,
    );
  return result.changes > 0;
}

function lastComments(db: SqlDatabase, jobId: string, limit = 3): string[] {
  const rows = db
    .prepare(
      `SELECT comment FROM agency_activity
       WHERE job_id = ? AND kind = 'comment' AND comment IS NOT NULL
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(jobId, limit) as Array<{ comment: string }>;
  return rows.map((row) => row.comment.replace(/\s+/g, " ").trim()).filter(Boolean);
}

export function formatStaleBatchText(
  items: Array<{
    job: Pick<Job, "id" | "key" | "title" | "state" | "revision">;
    stateSince: string;
    nudgeId: string;
    comments: string[];
  }>,
  batch: string,
  lang: AgencyLanguage,
): string {
  const token = staleBatchToken(batch);
  if (lang === "en") {
    const blocks = items.map((item) => {
      const notes = item.comments.length ? item.comments.map((line) => `- ${line}`).join("\n") : "- (no recent comments)";
      return [
        `${item.job.key}: ${item.job.title}`,
        `state ${item.job.state} since ${item.stateSince}; revision ${item.job.revision}`,
        notes,
        `nudgeId ${item.nudgeId}`,
        staleNudgeToken(item.nudgeId),
        `bb agency job stale-answer --input-json '{"requestId":"<uuid>","jobId":"${item.job.key}","nudgeId":"${item.nudgeId}","expectedJobRevision":${item.job.revision},"decision":"cancel","reason":"<why>"}'`,
      ].join("\n");
    });
    return [
      "Agency: these jobs from this chat have been sitting without movement.",
      "Decide yourself from this chat and the job card. Do not ask the owner. Do not call agency_ask_owner.",
      "One stale-answer per job: close | cancel | keep | escalate. close/cancel without a published version cancel the job (closed_by_origin_agent). keep needs nextCheckHours 1–168. escalate writes to the owner Inbox only.",
      "",
      ...blocks,
      "",
      token,
    ].join("\n");
  }
  const blocks = items.map((item) => {
    const notes = item.comments.length ? item.comments.map((line) => `- ${line}`).join("\n") : "- (нет недавних комментариев)";
    return [
      `${item.job.key}: ${item.job.title}`,
      `состояние ${item.job.state} с ${item.stateSince}; ревизия ${item.job.revision}`,
      notes,
      `nudgeId ${item.nudgeId}`,
      staleNudgeToken(item.nudgeId),
      `bb agency job stale-answer --input-json '{"requestId":"<uuid>","jobId":"${item.job.key}","nudgeId":"${item.nudgeId}","expectedJobRevision":${item.job.revision},"decision":"cancel","reason":"<почему>"}'`,
    ].join("\n");
  });
  return [
    "Агентство: эти задачи из этого чата висят без движения.",
    "Решите сами по содержимому чата и карточке. Владельца не спрашивать. agency_ask_owner не вызывать.",
    "Один stale-answer на задачу: close | cancel | keep | escalate. close/cancel без опубликованной версии отменяют задачу (closed_by_origin_agent). keep требует nextCheckHours 1–168. escalate пишет только во «Входящие».",
    "",
    ...blocks,
    "",
    token,
  ].join("\n");
}

function noOriginComment(job: Pick<Job, "key" | "state">, stateSince: string, lang: AgencyLanguage): string {
  return lang === "en"
    ? `${job.key} has been sitting in ${job.state} since ${stateSince}. There is no commissioning chat (originThreadId is empty); the sweeper will not write to a thread. The owner digest watchdog still sees the job.`
    : `${job.key} зависла в ${job.state} с ${stateSince}. Адресата в чате постановки нет (originThreadId пуст) — обходчик в чат не пишет. Задача по-прежнему видна сторожу владельца.`;
}

function rejectedComment(job: Pick<Job, "key">, code: string, message: string, lang: AgencyLanguage): string {
  return lang === "en"
    ? `${job.key}: the stale nudge could not be delivered to the commissioning chat (${code}: ${message}). Treated as no addressee; no further messages to that thread.`
    : `${job.key}: обходчик не доставил сообщение в чат постановки (${code}: ${message}). Дальше как без адресата; в этот чат больше не пишем.`;
}

function escalateText(job: Pick<Job, "key" | "title" | "state">, stateSince: string, lang: AgencyLanguage): string {
  return lang === "en"
    ? `Stale job ${job.key} «${job.title}» is still ${job.state} since ${stateSince}. The commissioning-chat agent did not answer three nudges.`
    : `Зависшая задача ${job.key} «${job.title}» всё ещё ${job.state} с ${stateSince}. Агент чата постановки не ответил на три напоминания.`;
}

function originOf(job: Pick<Job, "originThreadId">): string | null {
  const value = job.originThreadId?.trim() || null;
  return isOriginThreadId(value) ? value : null;
}

function episodeOpen(rows: StaleNudgeRow[]): boolean {
  return rows.some((row) => OPEN_SEND.includes(row.send_state as (typeof OPEN_SEND)[number]) && !row.decision);
}

function sentRows(rows: StaleNudgeRow[]): StaleNudgeRow[] {
  return rows.filter((row) => row.send_state !== "skipped" && row.reason_code !== "no_origin");
}

function dueForNext(rows: StaleNudgeRow[], rules: StaleRules, now: Date): boolean {
  if (episodeOpen(rows)) return false;
  const sent = sentRows(rows).filter((row) => row.send_state !== "rejected");
  if (sent.length === 0) return true;
  const last = sent[sent.length - 1];
  if (last.decision === "keep") {
    return Boolean(last.next_check_at && now.getTime() >= Date.parse(last.next_check_at));
  }
  if (last.decision) return false;
  if (last.next_check_at) return now.getTime() >= Date.parse(last.next_check_at);
  if (rules.staleRepeatHours <= 0) return false;
  return now.getTime() >= Date.parse(last.created_at) + hoursMs(rules.staleRepeatHours);
}

function orderBatchRows(rows: StaleNudgeRow[], getJob: (id: string) => Job | undefined): StaleNudgeRow[] {
  return [...rows].sort((left, right) => {
    const a = getJob(left.job_id);
    const b = getJob(right.job_id);
    if (a && b) {
      if (b.parentJobId === a.id) return -1;
      if (a.parentJobId === b.id) return 1;
    }
    return left.created_at.localeCompare(right.created_at) || left.nudge_id.localeCompare(right.nudge_id);
  });
}

function originHourBlocked(db: SqlDatabase, origin: string, now: Date): boolean {
  const row = db
    .prepare(
      `SELECT MAX(created_at) AS ts FROM agency_stale_nudge
       WHERE origin_thread_id = ? AND dispatch_claimed = 1
         AND send_state IN ('pending', 'queued', 'confirmed', 'unknown')`,
    )
    .get(origin) as { ts: string | null } | undefined;
  if (!row?.ts) return false;
  return now.getTime() - Date.parse(row.ts) < STALE_ORIGIN_HOUR_MS;
}

function markSend(
  db: SqlDatabase,
  ids: string[],
  outcome: IsolatedSendOutcome | { kind: "recovered" },
  now: string,
): void {
  for (const id of ids) {
    if (outcome.kind === "recovered") {
      db.prepare(`UPDATE agency_stale_nudge SET send_state = 'confirmed' WHERE nudge_id = ?`).run(id);
      continue;
    }
    if (outcome.kind === "confirmed") {
      if (outcome.delivery === "queued") {
        db.prepare(`UPDATE agency_stale_nudge SET send_state = 'queued', queued_message_id = ? WHERE nudge_id = ?`).run(
          outcome.queuedMessageId ?? null,
          id,
        );
      } else {
        db.prepare(`UPDATE agency_stale_nudge SET send_state = 'confirmed', queued_message_id = NULL WHERE nudge_id = ?`).run(id);
      }
      continue;
    }
    if (outcome.kind === "unknown") {
      db.prepare(`UPDATE agency_stale_nudge SET send_state = 'unknown', reason_code = ? WHERE nudge_id = ?`).run(outcome.code, id);
      continue;
    }
    db.prepare(`UPDATE agency_stale_nudge SET send_state = 'rejected', reason_code = ? WHERE nudge_id = ?`).run(outcome.code, id);
  }
  void now;
}

export function escalateStale(
  deps: StaleSweepPorts,
  job: Pick<Job, "id" | "key" | "title" | "state">,
  reason: string,
  dedupeKey: string,
): boolean {
  const nowIso = iso(deps.now());
  const recorded = recordOf(deps)(
    deps.db,
    { text: reason.trim() || escalateText(job, "", deps.lang ?? agencyLanguage()), level: "warning", jobId: job.id, dedupeKey },
    "stale-sweeper",
    nowIso,
  );
  return recorded.ok && !recorded.value.duplicate;
}

function escalateIfNeeded(ports: StaleSweepPorts, job: Job, stateSince: string, lang: AgencyLanguage): boolean {
  return escalateStale(ports, job, escalateText(job, stateSince, lang), `stale:${job.id}:${stateSince}:exhausted`);
}

function emptyStats(): StaleSweepStats {
  return { candidates: 0, inserted: 0, sent: 0, commented: 0, escalated: 0 };
}

export async function sweepStaleJobs(ports: StaleSweepPorts): Promise<StaleSweepStats> {
  const stats = emptyStats();
  if (ports.isActive?.() === false || !ports.db.open || !hasTable(ports.db)) return stats;
  const now = ports.now();
  const nowIso = iso(now);
  const lang = ports.lang ?? agencyLanguage();

  const jobs = (
    ports.db.prepare(`SELECT id FROM agency_job WHERE state IN ('blocked', 'running')`).all() as Array<{ id: string }>
  )
    .map((row) => ports.getJob(row.id))
    .filter((job): job is Job => Boolean(job));

  for (const job of jobs) {
    const rules = rulesOf(ports, job.departmentId);
    const watched =
      job.state === "running" && hasLiveAttempt(ports.db, job.id) ? await liveAttemptIsWatched(ports, job.id) : false;
    if (ports.isActive?.() === false || !ports.db.open) return stats;
    const candidate = isStaleCandidate(ports.db, job, rules, now, { liveAttemptWatched: watched });
    if (!candidate.ok) continue;
    stats.candidates += 1;
    const rows = listNudges(ports.db, job.id, candidate.stateSince);
    const delivered = sentRows(rows).filter((row) => row.send_state !== "rejected");
    if (delivered.length >= rules.staleMaxAttempts) {
      if (escalateIfNeeded(ports, job, candidate.stateSince, lang)) stats.escalated += 1;
      continue;
    }
    if (rows.some((row) => row.send_state === "rejected" || row.reason_code === "no_origin")) continue;
    if (!dueForNext(rows, rules, now)) continue;

    const origin = originOf(job);
    const nextAttempt = delivered.length + 1;
    const id = nudgeId(job.id, candidate.stateSince, nextAttempt);
    if (!origin || workerUsesOrigin(ports.db, job.id, origin)) {
      const inserted = insertNudge(ports.db, {
        nudge_id: id,
        batch_id: null,
        job_id: job.id,
        origin_thread_id: origin ?? "",
        state_since: candidate.stateSince,
        attempt: nextAttempt,
        send_state: "skipped",
        dispatch_claimed: 0,
        queued_message_id: null,
        revision_at_send: job.revision,
        next_check_at: null,
        decision: null,
        reason_code: origin ? "worker_origin" : "no_origin",
        created_at: nowIso,
      });
      if (inserted) {
        stats.inserted += 1;
        if (!origin) {
          commentOf(ports, job, noOriginComment(job, candidate.stateSince, lang));
          stats.commented += 1;
        }
      }
      continue;
    }

    if (
      insertNudge(ports.db, {
        nudge_id: id,
        batch_id: null,
        job_id: job.id,
        origin_thread_id: origin,
        state_since: candidate.stateSince,
        attempt: nextAttempt,
        send_state: "pending",
        dispatch_claimed: 0,
        queued_message_id: null,
        revision_at_send: job.revision,
        next_check_at: null,
        decision: null,
        reason_code: null,
        created_at: nowIso,
      })
    ) {
      stats.inserted += 1;
    }
  }

  await flushStaleNudges(ports, stats);
  return stats;
}

/** Kept for register.ts and existing tests. */
export const sweepStaleNudges = sweepStaleJobs;

export async function recoverStaleNudges(ports: StaleSweepPorts, stats: StaleSweepStats = emptyStats()): Promise<StaleSweepStats> {
  if (ports.isActive?.() === false || !ports.db.open || !hasTable(ports.db)) return stats;
  const now = ports.now();
  const nowIso = iso(now);
  const lang = ports.lang ?? agencyLanguage();
  const claimed = ports.db
    .prepare(
      `SELECT * FROM agency_stale_nudge
       WHERE dispatch_claimed = 1 AND batch_id IS NOT NULL
         AND send_state IN ('pending', 'queued', 'unknown')
       ORDER BY created_at`,
    )
    .all() as StaleNudgeRow[];
  const byBatch = new Map<string, StaleNudgeRow[]>();
  for (const row of claimed) {
    const list = byBatch.get(row.batch_id!) ?? [];
    list.push(row);
    byBatch.set(row.batch_id!, list);
  }
  for (const [batch, rows] of byBatch) {
    await dispatchClaimedBatch(ports, batch, rows, nowIso, lang, stats, { sendIfAbsent: true });
  }
  void now;
  return stats;
}

export async function flushStaleNudges(ports: StaleSweepPorts, stats: StaleSweepStats = emptyStats()): Promise<StaleSweepStats> {
  if (ports.isActive?.() === false || !ports.db.open || !hasTable(ports.db)) return stats;
  const now = ports.now();
  const nowIso = iso(now);
  const lang = ports.lang ?? agencyLanguage();
  await recoverStaleNudges(ports, stats);
  if (ports.isActive?.() === false || !ports.db.open) return stats;

  const pending = ports.db
    .prepare(
      `SELECT * FROM agency_stale_nudge
       WHERE send_state = 'pending' AND dispatch_claimed = 0
       ORDER BY created_at`,
    )
    .all() as StaleNudgeRow[];

  const unclaimedByOrigin = new Map<string, StaleNudgeRow[]>();
  for (const row of pending) {
    if (!row.origin_thread_id) continue;
    const list = unclaimedByOrigin.get(row.origin_thread_id) ?? [];
    list.push(row);
    unclaimedByOrigin.set(row.origin_thread_id, list);
  }

  for (const [origin, rows] of unclaimedByOrigin) {
    if (originHourBlocked(ports.db, origin, now)) continue;
    const live = orderBatchRows(rows, ports.getJob).filter((row) => {
      const job = ports.getJob(row.job_id);
      if (!job || (job.state !== "blocked" && job.state !== "running")) {
        ports.db
          .prepare(`UPDATE agency_stale_nudge SET send_state = 'skipped', reason_code = 'state_changed' WHERE nudge_id = ?`)
          .run(row.nudge_id);
        return false;
      }
      return true;
    });
    if (!live.length) continue;
    const slice = live.slice(0, STALE_BATCH_SIZE);
    const batch = batchId(origin, now);
    ports.db.transaction(() => {
      for (const row of slice) {
        ports.db
          .prepare(
            `UPDATE agency_stale_nudge SET batch_id = ?, dispatch_claimed = 1
             WHERE nudge_id = ? AND dispatch_claimed = 0 AND send_state = 'pending'`,
          )
          .run(batch, row.nudge_id);
      }
    })();
    const claimed = slice
      .map((row) => readNudge(ports.db, row.nudge_id))
      .filter((row): row is StaleNudgeRow => Boolean(row && row.dispatch_claimed === 1 && row.batch_id === batch));
    if (claimed.length) await dispatchClaimedBatch(ports, batch, claimed, nowIso, lang, stats, { sendIfAbsent: true });
  }
  return stats;
}

async function dispatchClaimedBatch(
  ports: StaleSweepPorts,
  batch: string,
  rows: StaleNudgeRow[],
  nowIso: string,
  lang: AgencyLanguage,
  stats: StaleSweepStats,
  opts: { sendIfAbsent: boolean },
): Promise<void> {
  if (ports.isActive?.() === false || !ports.db.open) return;
  const origin = rows[0]?.origin_thread_id;
  if (!origin) return;
  const liveRows = orderBatchRows(rows, ports.getJob);
  const items = [];
  for (const row of liveRows) {
    const job = ports.getJob(row.job_id);
    if (!job || (job.state !== "blocked" && job.state !== "running") || job.originThreadId !== origin) {
      ports.db
        .prepare(`UPDATE agency_stale_nudge SET send_state = 'skipped', reason_code = 'state_changed' WHERE nudge_id = ?`)
        .run(row.nudge_id);
      continue;
    }
    items.push({
      job,
      stateSince: row.state_since,
      nudgeId: row.nudge_id,
      comments: lastComments(ports.db, job.id).slice(0, 3),
    });
  }
  if (!items.length) return;
  const text = formatStaleBatchText(items, batch, lang);
  const ids = items.map((item) => item.nudgeId);
  const first = liveRows[0]!;
  let outcome: IsolatedSendOutcome | { kind: "recovered" };
  try {
    const presence = await ports.send.recoverContinuation(origin, staleBatchToken(batch), first.queued_message_id);
    if (ports.isActive?.() === false || !ports.db.open) return;
    if (presence === "present") outcome = { kind: "recovered" };
    else if (presence === "queued") {
      outcome = { kind: "confirmed", delivery: "queued", queuedMessageId: first.queued_message_id ?? undefined };
    } else if (presence === "unknown") {
      return;
    } else if (presence === "absent" && opts.sendIfAbsent) {
      outcome = await ports.send.send({ threadId: origin, text });
    } else {
      return;
    }
  } catch {
    outcome = { kind: "unknown", code: "send_transport", message: "stale nudge send failed" };
  }
  if (ports.isActive?.() === false || !ports.db.open) return;
  markSend(ports.db, ids, outcome, nowIso);
  if (outcome.kind === "confirmed" || outcome.kind === "recovered") stats.sent += 1;
  if (outcome.kind === "rejected") {
    for (const item of items) {
      commentOf(ports, item.job, rejectedComment(item.job, outcome.code, outcome.message, lang));
      stats.commented += 1;
    }
  }
}
