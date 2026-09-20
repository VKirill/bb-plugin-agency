import { randomBytes } from "node:crypto";
import { fail, ok, type DomainResult } from "../../domain";
import type { SqlDatabase } from "../db/sql";

/**
 * Messages to the owner from scripts, watchdogs and employees: `bb agency notify-owner`.
 * They land in «Входящие → Сообщения» and, when the owner turned Telegram on, in the
 * project's Telegram topic. A dedupe key sends the same message once.
 */

export const OWNER_MESSAGE_MIGRATION = `CREATE TABLE agency_owner_message (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT UNIQUE,
  text TEXT NOT NULL,
  level TEXT NOT NULL,
  job_id TEXT,
  source TEXT NOT NULL,
  telegram TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
)`;

export type OwnerMessage = {
  id: string;
  text: string;
  level: "info" | "warning";
  jobId: string | null;
  jobKey: string | null;
  source: string;
  telegram: string;
  createdAt: string;
  readAt: string | null;
};

type Row = { id: string; text: string; level: string; job_id: string | null; job_key: string | null; source: string; telegram: string; created_at: string; read_at: string | null };

function mapRow(row: Row): OwnerMessage {
  return {
    id: row.id,
    text: row.text,
    level: row.level === "warning" ? "warning" : "info",
    jobId: row.job_id,
    jobKey: row.job_key,
    source: row.source,
    telegram: row.telegram,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

const SELECT = `SELECT m.id, m.text, m.level, m.job_id, j.key AS job_key, m.source, m.telegram, m.created_at, m.read_at
  FROM agency_owner_message m LEFT JOIN agency_job j ON j.id = m.job_id`;

export function readOwnerMessage(db: SqlDatabase, id: string): OwnerMessage | null {
  const row = db.prepare(`${SELECT} WHERE m.id = ?`).get(id) as Row | undefined;
  return row ? mapRow(row) : null;
}

/** Stores a message; a known dedupe key returns the earlier one. */
export function recordOwnerMessage(
  db: SqlDatabase,
  input: { text: string; level?: "info" | "warning"; jobId?: string | null; dedupeKey?: string },
  source: string,
  now: string,
): DomainResult<{ message: OwnerMessage; duplicate: boolean }> {
  const text = input.text.trim();
  if (!text) return fail("invalid_command", "text is empty");
  if (input.dedupeKey) {
    const existing = db.prepare(`SELECT id FROM agency_owner_message WHERE dedupe_key = ?`).get(input.dedupeKey) as { id: string } | undefined;
    if (existing) return ok({ message: readOwnerMessage(db, existing.id)!, duplicate: true });
  }
  const id = `msg_${randomBytes(12).toString("hex")}`;
  db.prepare(
    `INSERT INTO agency_owner_message (id, dedupe_key, text, level, job_id, source, telegram, created_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?, 'off', ?, NULL)`,
  ).run(id, input.dedupeKey ?? null, text, input.level ?? "info", input.jobId ?? null, source, now);
  return ok({ message: readOwnerMessage(db, id)!, duplicate: false });
}

export function setTelegramState(db: SqlDatabase, id: string, state: string): void {
  db.prepare(`UPDATE agency_owner_message SET telegram = ? WHERE id = ?`).run(state.slice(0, 200), id);
}

export function listOwnerMessages(db: SqlDatabase, limit = 100): { messages: OwnerMessage[]; unread: number } {
  const messages = (db.prepare(`${SELECT} ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`).all(limit) as Row[]).map(mapRow);
  const unread = (db.prepare(`SELECT COUNT(*) AS n FROM agency_owner_message WHERE read_at IS NULL`).get() as { n: number }).n;
  return { messages, unread };
}

/** Marks the given messages read, or all of them without ids. */
export function markOwnerMessagesRead(db: SqlDatabase, ids: readonly string[] | undefined, now: string): number {
  if (!ids) return db.prepare(`UPDATE agency_owner_message SET read_at = ? WHERE read_at IS NULL`).run(now).changes;
  if (!ids.length) return 0;
  return db
    .prepare(`UPDATE agency_owner_message SET read_at = ? WHERE read_at IS NULL AND id IN (${ids.map(() => "?").join(", ")})`)
    .run(now, ...ids).changes;
}

export type DigestItem = { key: string; title: string; state: string; since: string };

/**
 * What a summary or a watchdog tells the owner. The summary covers the last hours;
 * the watchdog lists jobs that wait for a person longer than `stuckHours`.
 */
export function buildDigest(
  db: SqlDatabase,
  input: { kind: "summary" | "watchdog"; sinceHours: number; stuckHours: number },
  now: Date,
  en: boolean,
): { text: string; level: "info" | "warning"; items: DigestItem[]; counts: Record<string, number> } {
  const hours = (value: number) => new Date(now.getTime() - value * 3_600_000).toISOString();
  // Only waits for a person: review is a station the conveyor closes by itself.
  const waiting = (before: string) =>
    (
      db
        .prepare(
          `SELECT key, title, state, updated_at FROM agency_job
           WHERE state IN ('waiting_input', 'blocked') AND updated_at <= ?
           ORDER BY updated_at`,
        )
        .all(before) as { key: string; title: string; state: string; updated_at: string }[]
    ).map((row) => ({ key: row.key, title: row.title, state: row.state, since: row.updated_at }));
  const label = (state: string) =>
    en
      ? ({ review: "waits for review", waiting_input: "waits for your answer", blocked: "needs a decision" } as Record<string, string>)[state] ?? state
      : ({ review: "ждёт проверки", waiting_input: "ждёт вашего ответа", blocked: "ожидает решения" } as Record<string, string>)[state] ?? state;
  const line = (item: DigestItem) => `- ${item.key} «${item.title}» — ${label(item.state)}`;

  if (input.kind === "watchdog") {
    const items = waiting(hours(input.stuckHours));
    const text = items.length
      ? [en ? `Watchdog: ${items.length} jobs wait longer than ${input.stuckHours} h.` : `Сторож: ${items.length} задач ждут дольше ${input.stuckHours} ч.`, ...items.slice(0, 20).map(line), ...(items.length > 20 ? [en ? `…and ${items.length - 20} more.` : `…и ещё ${items.length - 20}.`] : [])].join("\n")
      : en ? `Watchdog: nothing waits longer than ${input.stuckHours} h.` : `Сторож: дольше ${input.stuckHours} ч ничего не ждёт.`;
    return { text, level: items.length ? "warning" : "info", items, counts: { stuck: items.length } };
  }

  const since = hours(input.sinceHours);
  const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  const counts = {
    created: count(`SELECT COUNT(*) AS n FROM agency_activity WHERE kind = 'job_created' AND timestamp > ?`, since),
    done: count(`SELECT COUNT(*) AS n FROM agency_job WHERE state = 'done' AND closed_at > ?`, since),
    accepted: count(`SELECT COUNT(*) AS n FROM agency_artifact_acceptance WHERE accepted_at > ?`, since),
    running: count(`SELECT COUNT(*) AS n FROM agency_job WHERE state = 'running'`),
    review: count(`SELECT COUNT(*) AS n FROM agency_job WHERE state = 'review'`),
    waitingInput: count(`SELECT COUNT(*) AS n FROM agency_job WHERE state = 'waiting_input'`),
    blocked: count(`SELECT COUNT(*) AS n FROM agency_job WHERE state = 'blocked'`),
  };
  const items = waiting(now.toISOString());
  const text = [
    en
      ? `Agency for ${input.sinceHours} h: new jobs ${counts.created}, done ${counts.done}, versions accepted ${counts.accepted}.`
      : `Агентство за ${input.sinceHours} ч: новых задач ${counts.created}, готово ${counts.done}, принято версий ${counts.accepted}.`,
    en
      ? `Now: running ${counts.running}, waiting for review ${counts.review}, for your answer ${counts.waitingInput}, for a decision ${counts.blocked}.`
      : `Сейчас: в работе ${counts.running}, ждут проверки ${counts.review}, вашего ответа ${counts.waitingInput}, решения ${counts.blocked}.`,
    ...items.slice(0, 10).map(line),
  ].join("\n");
  return { text, level: counts.waitingInput + counts.blocked > 0 ? "warning" : "info", items, counts };
}

export type ScriptTemplate = { id: string; title: string; description: string; script: string };

/** Ready scripts for the owner's scheduler (cron, launchd): everything runs through `bb agency`. */
export function scriptTemplates(en: boolean): ScriptTemplate[] {
  const header = en
    ? "# Runs as the BB owner user. cron has a short PATH: put the full path of `command -v bb` here."
    : "# Запускается от пользователя BB. У cron короткий PATH: подставьте полный путь из `command -v bb`.";
  return [
    {
      id: "daily-summary",
      title: en ? "Daily summary" : "Сводка за день",
      description: en
        ? "Every morning: what was done and accepted in 24 h, and what waits for you. Arrives in Inbox → Messages and in Telegram when it is on."
        : "Каждое утро: что сделано и принято за сутки и что ждёт вас. Приходит во «Входящие → Сообщения» и в Telegram, если он включён.",
      script: [
        header,
        "# crontab -e",
        `0 9 * * * bb agency digest --input-json '{"kind":"summary","sinceHours":24,"notify":true}' >/dev/null 2>&1`,
      ].join("\n"),
    },
    {
      id: "watchdog",
      title: en ? "Watchdog" : "Сторож",
      description: en
        ? "Every 30 minutes: jobs that wait for your answer or a decision longer than 12 h. Writes only when something waits, once per job state."
        : "Каждые 30 минут: задачи, которые ждут вашего ответа или решения дольше 12 ч. Пишет, только когда что-то ждёт, и один раз на состояние задачи.",
      script: [
        header,
        "# crontab -e",
        `*/30 * * * * bb agency digest --input-json '{"kind":"watchdog","stuckHours":12,"notify":true}' >/dev/null 2>&1`,
      ].join("\n"),
    },
    {
      id: "recurring-job",
      title: en ? "Recurring job from outside data" : "Регулярная задача из внешних данных",
      description: en
        ? "When the brief is built by a script (an export, a report file). A fixed recurring job is simpler in Automations → On a schedule."
        : "Когда бриф собирает скрипт (выгрузка, файл отчёта). Постоянную регулярную задачу проще завести в «Автоматизации → По расписанию».",
      script: [
        "#!/bin/sh",
        header,
        "set -eu",
        'BINDING="bnd_…"      # bb agency workspace --json → bindings[].id',
        'DEPARTMENT="dep_…"   # departments[].id',
        'LEAD="agt_…"         # the department lead',
        'REQUEST=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)',
        `BRIEF="$(date +%F): $(cat /path/to/input.txt)"`,
        `JSON=$(python3 -c 'import json,sys; print(json.dumps({"requestId":sys.argv[1],"bindingId":sys.argv[2],"departmentId":sys.argv[3],"assignedAgentId":sys.argv[4],"title":"Weekly report","brief":sys.argv[5],"acceptance":"Report published as a version"}))' "$REQUEST" "$BINDING" "$DEPARTMENT" "$LEAD" "$BRIEF")`,
        `JOB=$(bb agency job create --input-json "$JSON" --json)`,
        `ID=$(printf '%s' "$JOB" | python3 -c 'import json,sys; v=json.load(sys.stdin)["value"]; print(v["id"], v["revision"])')`,
        `set -- $ID`,
        `bb agency launch queue --input-json "{\\"requestId\\":\\"$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)\\",\\"jobId\\":\\"$1\\",\\"expectedRevision\\":$2}"`,
        `bb agency notify-owner --input-json "{\\"text\\":\\"Weekly report queued: $1\\",\\"jobId\\":\\"$1\\"}"`,
      ].join("\n"),
    },
  ];
}
