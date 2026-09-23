import { agencyLanguage, type AgencyLanguage } from "../../i18n/language.js";
import type { Job } from "../../../shared/contracts";
import type { SqlDatabase } from "../../db/sql";
import type { IsolatedSendOutcome } from "../isolated-sdk/send-port.js";

/** Resume an idle worker; never turn the wake-up budget into a delivery deadline.
 * Only consecutive unanswered wake-ups count. A working thread or an unfinished
 * dependency clears the episode. Loop diagnosis belongs to the lead/progress watch.
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
  /** What final hand-in lacks: a version or explicit submission after it. */
  missing?: "version" | "comment";
};

export type ReminderPorts = {
  db: SqlDatabase;
  getJob: (jobId: string) => Job | undefined;
  /** Children that are not done or canceled. */
  openChildren: (jobId: string) => number;
  waitingDependencies?: (job: Job) => string[];
  attemptForLaunch: (launchId: string) => { id: string; state: string } | undefined;
  send: (threadId: string, text: string) => Promise<IsolatedSendOutcome>;
  /** Comment and move the job to blocked; returns false when the transition was refused. */
  block: (job: Job, comment: string) => boolean;
  now: () => string;
  /** Reminders before the job goes to the lead; the default applies when omitted. */
  limit?: (job: Job) => number;
};

export type ReminderOutcome = "skipped" | "waiting" | "sent" | "blocked" | "resumed" | "dependency_wait";

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

function reminderText(jobKey: string, attemptId: string, count: number, lang: AgencyLanguage, limit: number, published: boolean): string {
  if (lang === "en") return [
    `Agency: ${jobKey} is idle without final submission${published ? " (a version is published; it may be intermediate)" : ""}. Wake-up ${count}/${limit}; this is NOT a delivery deadline.`,
    "If required work remains, continue it in this same job and attempt. Do not submit a partial result to satisfy a reminder. Record meaningful progress and the next step with job comment; publication alone does not mean the product is complete.",
    "If waiting on another job, record the exact source and next action in job comment and notify your lead. Use job depend for work that requires a completed predecessor. Reviewers wait for pinned producers to reach review, not done: do not create a circular acceptance dependency. A reviewer may end the turn while input-producing jobs are still working. Do not poll, restart, or manufacture a final verdict.",
    `Only when the full acceptance is met: write .agency/jobs/${jobKey}/report.md, publish its exact version with bb agency artifact create/publish, then bb agency job submit (jobId, expectedRevision, artifactId, version, hash, comment).`,
    "A real blocker requires a factual report to the lead; use job report-needs-input only for a missing owner decision. Consecutive unanswered wake-ups escalate for diagnosis, not for forced partial hand-in.",
    `agency.completionReminder:${attemptId}:${count}`,
  ].join("\n");
  return [
    `Агентство: ${jobKey} простаивает без итоговой сдачи${published ? " (опубликованная версия может быть промежуточной)" : ""}. Возобновление ${count}/${limit}; это НЕ срок сдачи.`,
    "Если обязательная работа осталась, продолжайте её в той же задаче и попытке. Не сдавайте частичный результат ради напоминания. Зафиксируйте существенный прогресс и следующий шаг через job comment; публикация сама по себе не означает готовность продукта.",
    "Если ожидаете другую задачу, укажите точный источник и следующий шаг через job comment и сообщите руководителю. job depend нужен, когда предшественник должен завершиться. Проверяющий ожидает review у закреплённых источников, а не done: не создавайте цикл приёмки. Проверяющий может завершить ход, пока исполнители готовят входы. Не опрашивайте статус циклом, не перезапускайте работу и не подменяйте ожидание финальным вердиктом.",
    `Только после выполнения всех критериев: .agency/jobs/${jobKey}/report.md, точная версия через bb agency artifact create/publish, затем bb agency job submit (jobId, expectedRevision, artifactId, version, hash, comment).`,
    "Реальный блокер передайте руководителю с фактами; job report-needs-input нужен только для недостающего решения владельца. Последовательные пробуждения без ответа приводят к разбору, а не к требованию неполной сдачи.",
    `agency.completionReminder:${attemptId}:${count}`,
  ].join("\n");
}

export function completionReminderText(jobKey: string, attemptId: string, count: number, lang: AgencyLanguage = agencyLanguage(), limit: number = COMPLETION_REMINDER_LIMIT): string {
  return reminderText(jobKey, attemptId, count, lang, limit, false);
}

export function handInCommentReminderText(jobKey: string, attemptId: string, count: number, lang: AgencyLanguage = agencyLanguage(), limit: number = COMPLETION_REMINDER_LIMIT): string {
  return reminderText(jobKey, attemptId, count, lang, limit, true);
}

/** Only concrete dependencies, never all siblings or an active parent plan.
 * Review inputs are ready for a verdict at review (not only at done), avoiding
 * the cycle in which the producer waits for acceptance from this reviewer.
 */
export function completionWaitingDependencies(db: SqlDatabase, job: Job): string[] {
  const rows = db.prepare(`SELECT DISTINCT j.id FROM agency_job_dependency d
    JOIN agency_job j ON j.id = d.depends_on_job_id
    WHERE d.job_id = ? AND j.state NOT IN ('done', 'canceled')
    UNION
    SELECT DISTINCT j.id FROM agency_job j
    WHERE j.id != ? AND j.id != COALESCE(?, '')
      AND j.state NOT IN ('review', 'done', 'canceled')
      AND (EXISTS (SELECT 1 FROM agency_auto_review q WHERE q.review_job_id = ? AND q.job_id = j.id)
        OR (EXISTS (SELECT 1 FROM agency_membership m WHERE m.department_id = ? AND m.agent_id = ? AND m.role = 'reviewer')
          AND EXISTS (SELECT 1 FROM agency_job_input_ref i WHERE i.target_job_id = ? AND i.source_job_id = j.id)))`)
    .all(job.id, job.id, job.parentJobId, job.id, job.departmentId, job.assignedAgentId, job.id) as Array<{ id: string }>;
  return rows.map(row => row.id);
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
  let current: Record = read(ports.db, attempt.id) ?? {
    attempt_id: attempt.id,
    job_id: job.id,
    count: 0,
    idle_since: null,
    awaiting_turn: 0,
    last_sent_at: null,
    blocked_at: null,
  };
  // A same-attempt authorized return/recovery must not inherit an old episode.
  const clearEpisode = (): boolean => {
    const changed = Boolean(current.count || current.idle_since || current.awaiting_turn || current.blocked_at);
    if (changed) {
      current = { ...current, count: 0, idle_since: null, awaiting_turn: 0, last_sent_at: null, blocked_at: null };
      upsert(ports.db, current, now);
    }
    return changed;
  };
  if (current.blocked_at) clearEpisode();
  // A queued message or unknown status is not an observed response.
  if (reading.threadStatus === "running" || reading.threadStatus === "active") {
    return clearEpisode() ? "resumed" : "skipped";
  }
  if (reading.threadStatus !== "idle") return "skipped";
  if (reading.publishedVerified) { clearEpisode(); return "skipped"; }
  // Parent wake / input handoff will resume these workers. No premature final submission.
  if (ports.openChildren(job.id) > 0 || (ports.waitingDependencies?.(job).length ?? 0) > 0) {
    return clearEpisode() ? "dependency_wait" : "skipped";
  }

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
        ? `Agency: no resumed work observed after ${limit} consecutive wake-ups. Inspect the same attempt and its dependencies; diagnose with the lead. This is not a delivery deadline: do not submit a partial result or relaunch automatically.`
        : `Агентство: после ${limit} последовательных пробуждений возобновление работы не наблюдалось. Руководителю: проверьте ту же попытку и её зависимости, установите причину. Это не срок сдачи: не требуйте частичный результат и не перезапускайте автоматически.`,
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
