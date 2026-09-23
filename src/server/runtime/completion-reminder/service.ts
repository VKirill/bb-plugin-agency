import { agencyLanguage, type AgencyLanguage } from "../../i18n/language.js";
import type { Job } from "../../../shared/contracts";
import type { SqlDatabase } from "../../db/sql";
import type { IsolatedSendOutcome } from "../isolated-sdk/send-port.js";

/**
 * A worker thread that ends its turn while its job is still running and has no
 * published result gets a reminder with the hand-in steps. After the limit the
 * job goes to blocked, which wakes the lead (parent wake) or shows it to the
 * owner. A lead waiting for its own open subtasks is not reminded.
 */

export const COMPLETION_REMINDER_LIMIT = 2;
/** The thread must stay idle this long before a reminder: no race with a publish that just landed. */
export const COMPLETION_REMINDER_IDLE_MS = 20_000;
/** If the reminded turn was never observed running, remind again after this. */
export const COMPLETION_REMINDER_RETRY_MS = 10 * 60_000;

export const COMPLETION_REMINDER_MIGRATION = `CREATE TABLE agency_completion_reminder (
    attempt_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    idle_since TEXT,
    awaiting_turn INTEGER NOT NULL DEFAULT 0,
    last_sent_at TEXT,
    blocked_at TEXT,
    updated_at TEXT NOT NULL
  )`;

export type ReminderRow = { threadId: string; jobId: string; launchId: string };

export type ReminderReading = {
  threadStatus: string | null;
  publishedVerified: boolean;
  /** What the hand-in lacks: the version itself or the closing comment after it. */
  missing?: "version" | "comment";
};

export type ReminderPorts = {
  db: SqlDatabase;
  getJob: (jobId: string) => Job | undefined;
  /** Children that are not done or canceled. */
  openChildren: (jobId: string) => number;
  attemptForLaunch: (launchId: string) => { id: string; state: string } | undefined;
  send: (threadId: string, text: string) => Promise<IsolatedSendOutcome>;
  /** Comment and move the job to blocked; returns false when the transition was refused. */
  block: (job: Job, comment: string) => boolean;
  now: () => string;
  /** Reminders before the job goes to the lead; the default applies when omitted. */
  limit?: (job: Job) => number;
};

export type ReminderOutcome = "skipped" | "waiting" | "sent" | "blocked";

type Record = {
  attempt_id: string;
  job_id: string;
  count: number;
  idle_since: string | null;
  awaiting_turn: number;
  last_sent_at: string | null;
  blocked_at: string | null;
};

/** Messages into an employee thread are English like the launch prompt; the Language line sets the reply language. */
export const AGENT_MESSAGE_LANGUAGE: AgencyLanguage = "en";

export function completionReminderText(jobKey: string, attemptId: string, count: number, lang: AgencyLanguage = agencyLanguage(), limit: number = COMPLETION_REMINDER_LIMIT): string {
  const COMPLETION_REMINDER_LIMIT = limit;
  if (lang === "en") {
    return [
      `Agency: job ${jobKey} is not handed in — there is no published result version (reminder ${count} of ${COMPLETION_REMINDER_LIMIT}).`,
      "To hand in the work:",
      `1. Report .agency/jobs/${jobKey}/report.md: outcome, what was done and where, how it was checked, what is not done.`,
      "2. bb agency artifact create → bb agency artifact publish: a version of the report (and key result files).",
      "3. bb agency job submit (jobId, expectedRevision, artifactId, version, hash, comment): a two or three sentence summary for the lead with a link to the version.",
      "4. End the turn.",
      "Not your work or inputs are missing — return the job: comment «Return: …» and job transition to blocked. A question for the owner — job report-needs-input.",
      `After ${COMPLETION_REMINDER_LIMIT} reminders without a result the job moves to «needs decision».`,
      `agency.completionReminder:${attemptId}:${count}`,
    ].join("\n");
  }
  return [
    `Агентство: поручение ${jobKey} не сдано — нет опубликованной версии результата (напоминание ${count} из ${COMPLETION_REMINDER_LIMIT}).`,
    "Чтобы сдать работу:",
    `1. Отчёт .agency/jobs/${jobKey}/report.md: итог, что сделано и где, чем проверено, что не сделано.`,
    "2. bb agency artifact create → bb agency artifact publish: версия отчёта (и ключевых файлов результата).",
    "3. bb agency job submit (jobId, expectedRevision, artifactId, version, hash, comment): итог для руководителя в двух-трёх фразах со ссылкой на версию.",
    "4. Завершите ход.",
    "Работа не ваша или не хватает входов — верните задачу: комментарий «Возврат: …» и job transition в blocked. Вопрос владельцу — job report-needs-input.",
    `После ${COMPLETION_REMINDER_LIMIT} напоминаний без результата задача перейдёт в «Ожидает решения».`,
    `agency.completionReminder:${attemptId}:${count}`,
  ].join("\n");
}

export function handInCommentReminderText(jobKey: string, attemptId: string, count: number, lang: AgencyLanguage = agencyLanguage(), limit: number = COMPLETION_REMINDER_LIMIT): string {
  if (lang === "en") {
    return [
      `Agency: the result version of ${jobKey} is published, but there is no explicit final submission (reminder ${count} of ${limit}).`,
      "bb agency job submit (jobId, expectedRevision, artifactId, version, hash, comment): the outcome in two or three sentences — what was done, how it was checked, what is not done — with a link to the version. Then end the turn.",
      "The job goes to review only after final submission.",
      `agency.completionReminder:${attemptId}:${count}`,
    ].join("\n");
  }
  return [
    `Агентство: версия результата ${jobKey} опубликована, но нет явной итоговой сдачи (напоминание ${count} из ${limit}).`,
    "bb agency job submit (jobId, expectedRevision, artifactId, version, hash, comment): итог в двух-трёх фразах — что сделано, чем проверено, что не сделано — со ссылкой на версию. Затем завершите ход.",
    "На проверку задача уйдёт только после итоговой сдачи.",
    `agency.completionReminder:${attemptId}:${count}`,
  ].join("\n");
}

function read(db: SqlDatabase, attemptId: string): Record | undefined {
  return db.prepare(`SELECT * FROM agency_completion_reminder WHERE attempt_id = ?`).get(attemptId) as Record | undefined;
}

function upsert(db: SqlDatabase, row: Record, now: string): void {
  db.prepare(
    `INSERT INTO agency_completion_reminder
       (attempt_id, job_id, count, idle_since, awaiting_turn, last_sent_at, blocked_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(attempt_id) DO UPDATE SET
       count = excluded.count, idle_since = excluded.idle_since, awaiting_turn = excluded.awaiting_turn,
       last_sent_at = excluded.last_sent_at, blocked_at = excluded.blocked_at, updated_at = excluded.updated_at`,
  ).run(row.attempt_id, row.job_id, row.count, row.idle_since, row.awaiting_turn, row.last_sent_at, row.blocked_at, now);
}

export async function remindIncompleteWorker(
  ports: ReminderPorts,
  row: ReminderRow,
  reading: ReminderReading,
): Promise<ReminderOutcome> {
  const job = ports.getJob(row.jobId);
  const attempt = ports.attemptForLaunch(row.launchId);
  if (!job || !attempt || attempt.state !== "running" || job.state !== "running") return "skipped";
  const now = ports.now();
  const limit = ports.limit ? ports.limit(job) : COMPLETION_REMINDER_LIMIT;
  const current: Record = read(ports.db, attempt.id) ?? {
    attempt_id: attempt.id,
    job_id: job.id,
    count: 0,
    idle_since: null,
    awaiting_turn: 0,
    last_sent_at: null,
    blocked_at: null,
  };
  if (current.blocked_at) return "skipped";

  if (reading.threadStatus !== "idle") {
    // The worker is working (possibly on our reminder): the next idle is a new episode.
    if (current.idle_since || current.awaiting_turn) {
      upsert(ports.db, { ...current, idle_since: null, awaiting_turn: 0 }, now);
    }
    return "skipped";
  }
  if (reading.publishedVerified) return "skipped";
  // A lead that ended its turn to wait for subtasks is not late: parent wake will call it back.
  if (ports.openChildren(job.id) > 0) return "skipped";

  const nowMs = Date.parse(now);
  if (current.awaiting_turn && current.last_sent_at && nowMs - Date.parse(current.last_sent_at) < COMPLETION_REMINDER_RETRY_MS) {
    return "waiting";
  }
  if (!current.idle_since) {
    upsert(ports.db, { ...current, idle_since: now, awaiting_turn: 0 }, now);
    return "waiting";
  }
  if (nowMs - Date.parse(current.idle_since) < COMPLETION_REMINDER_IDLE_MS) return "waiting";

  if (current.count >= limit) {
    const blocked = ports.block(
      job,
      agencyLanguage() === "en"
        ? `Agency: the employee ended the turn without ${reading.missing === "comment" ? "a closing comment to the published version" : "a published result"} after ${limit} reminders. Check the attempt thread: reassign, clarify the brief or relaunch.`
        : `Агентство: исполнитель завершил ход без ${reading.missing === "comment" ? "итогового комментария к опубликованной версии" : "опубликованного результата"} после ${limit} напоминаний. Проверьте тред попытки: переназначьте, уточните бриф или перезапустите.`,
    );
    upsert(ports.db, { ...current, blocked_at: blocked ? now : null, idle_since: null }, now);
    return blocked ? "blocked" : "skipped";
  }

  const count = current.count + 1;
  const text =
    reading.missing === "comment"
      ? handInCommentReminderText(job.key, attempt.id, count, AGENT_MESSAGE_LANGUAGE, limit)
      : completionReminderText(job.key, attempt.id, count, AGENT_MESSAGE_LANGUAGE, limit);
  const outcome = await ports.send(row.threadId, text);
  if (outcome.kind === "rejected") return "skipped";
  upsert(ports.db, { ...current, count, idle_since: null, awaiting_turn: 1, last_sent_at: now }, now);
  return "sent";
}
