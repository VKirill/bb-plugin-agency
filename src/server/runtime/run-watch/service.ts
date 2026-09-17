import { agencyLanguage, type AgencyLanguage } from "../../i18n/language.js";
import type { Job } from "../../../shared/contracts";
import type { SqlDatabase } from "../../db/sql";

/**
 * Watches a running attempt for signs of life. The completion reminder covers
 * "turn ended without a result"; this covers the opposite: a thread that never
 * starts, sits in error, or stays active without progress. Progress is any new
 * thread update, token usage event or job activity. The watch never stops a
 * thread: it comments, then moves the job to blocked, which wakes the lead.
 */

/** Active without progress this long: a system comment on the job. */
export const RUN_WATCH_QUIET_MS = 10 * 60_000;
/** Active without progress this long: blocked. */
export const RUN_WATCH_STALL_MS = 30 * 60_000;
/** Pending or starting this long: blocked. */
export const RUN_WATCH_START_MS = 10 * 60_000;
/** Thread error this long (provider retry had its chance): blocked. */
export const RUN_WATCH_ERROR_MS = 5 * 60_000;
/** Continuously active this long, even with progress: blocked. */
export const RUN_WATCH_CEILING_MS = 2 * 60 * 60_000;

export const RUN_WATCH_MIGRATION = `CREATE TABLE agency_run_watch (
    attempt_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    thread_status TEXT,
    status_since TEXT NOT NULL,
    progress_at TEXT NOT NULL,
    active_since TEXT,
    warned_at TEXT,
    outcome TEXT,
    outcome_at TEXT,
    updated_at TEXT NOT NULL
  )`;

export type RunWatchRow = { threadId: string; jobId: string; launchId: string };

export type RunWatchObservation = {
  /** null when the thread could not be read. */
  threadStatus: string | null;
  threadUpdatedAt: string | null;
  backgroundAgents: number;
};

export type RunWatchPorts = {
  db: SqlDatabase;
  getJob: (jobId: string) => Job | undefined;
  attemptForLaunch: (launchId: string) => { id: string; state: string } | undefined;
  /** Latest token usage event of the thread or activity of the job, ISO. */
  lastProgressAt: (threadId: string, jobId: string) => string | null;
  comment: (job: Job, text: string) => boolean;
  /** Thresholds of the job's department; the defaults apply when omitted. */
  thresholds?: (job: Job) => Partial<RunWatchThresholds>;
  /** Comment and move the job to blocked; false when the transition was refused. */
  block: (job: Job, text: string) => boolean;
  now: () => string;
};

export type RunWatchOutcome = "skipped" | "ok" | "warned" | "blocked";

export type RunWatchThresholds = { quietMs: number; stallMs: number; startMs: number; errorMs: number; ceilingMs: number };

export const DEFAULT_RUN_WATCH_THRESHOLDS: RunWatchThresholds = {
  quietMs: RUN_WATCH_QUIET_MS,
  stallMs: RUN_WATCH_STALL_MS,
  startMs: RUN_WATCH_START_MS,
  errorMs: RUN_WATCH_ERROR_MS,
  ceilingMs: RUN_WATCH_CEILING_MS,
};

type WatchRecord = {
  attempt_id: string;
  job_id: string;
  thread_status: string | null;
  status_since: string;
  progress_at: string;
  active_since: string | null;
  warned_at: string | null;
  outcome: string | null;
  outcome_at: string | null;
};

const ACTIVE_STATUSES = new Set(["active", "stopping"]);
const STARTING_STATUSES = new Set(["pending", "starting"]);

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

export function runWatchText(
  kind: "quiet" | "stalled" | "not_started" | "error" | "ceiling",
  jobKey: string,
  lang: AgencyLanguage = agencyLanguage(),
  t: RunWatchThresholds = DEFAULT_RUN_WATCH_THRESHOLDS,
): string {
  const RUN_WATCH_QUIET_MS = t.quietMs;
  const RUN_WATCH_STALL_MS = t.stallMs;
  const RUN_WATCH_START_MS = t.startMs;
  const RUN_WATCH_ERROR_MS = t.errorMs;
  const RUN_WATCH_CEILING_MS = t.ceilingMs;
  if (lang === "en") {
    const stopEn = `To stop the attempt: bb agency launch cancel; then relaunch or reassign ${jobKey}.`;
    switch (kind) {
      case "quiet":
        return `Agency: ${jobKey} shows no signs of work for ${minutes(RUN_WATCH_QUIET_MS)} min — the thread is active but silent. After ${minutes(RUN_WATCH_STALL_MS)} min without activity the job moves to «needs decision».`;
      case "stalled":
        return `Agency: ${jobKey} is stalled — the thread was active ${minutes(RUN_WATCH_STALL_MS)} min without new events. The job moved to «needs decision». Open the attempt thread. ${stopEn}`;
      case "not_started":
        return `Agency: the employee for ${jobKey} did not start within ${minutes(RUN_WATCH_START_MS)} min. Check that the project machine is online and the provider CLI is installed and signed in. ${stopEn}`;
      case "error":
        return `Agency: the ${jobKey} thread has been in error for more than ${minutes(RUN_WATCH_ERROR_MS)} min (provider failure or subscription limit). The job moved to «needs decision». ${stopEn}`;
      case "ceiling":
        return `Agency: ${jobKey} has worked non-stop for more than ${minutes(RUN_WATCH_CEILING_MS) / 60} h — the limit of one attempt. The job moved to «needs decision»: check that the employee is not looping and split the work. ${stopEn}`;
    }
  }
  const stop = `Остановить попытку: bb agency launch cancel; затем перезапустить или переназначить ${jobKey}.`;
  switch (kind) {
    case "quiet":
      return `Агентство: у ${jobKey} нет признаков работы ${minutes(RUN_WATCH_QUIET_MS)} мин — тред активен, но без новых событий. Через ${minutes(RUN_WATCH_STALL_MS)} мин без активности задача перейдёт в «Ожидает решения».`;
    case "stalled":
      return `Агентство: ${jobKey} завис — тред активен ${minutes(RUN_WATCH_STALL_MS)} мин без новых событий. Задача переведена в «Ожидает решения». Откройте тред попытки. ${stop}`;
    case "not_started":
      return `Агентство: сотрудник по ${jobKey} не запустился за ${minutes(RUN_WATCH_START_MS)} мин. Проверьте, что машина проекта в сети, CLI провайдера установлен и авторизован. ${stop}`;
    case "error":
      return `Агентство: тред ${jobKey} в ошибке дольше ${minutes(RUN_WATCH_ERROR_MS)} мин (сбой провайдера или лимит подписки). Задача переведена в «Ожидает решения». ${stop}`;
    case "ceiling":
      return `Агентство: ${jobKey} работает без перерыва дольше ${minutes(RUN_WATCH_CEILING_MS) / 60} ч — это потолок одной попытки. Задача переведена в «Ожидает решения»: проверьте, не зациклился ли сотрудник, и разбейте работу. ${stop}`;
  }
}

function read(db: SqlDatabase, attemptId: string): WatchRecord | undefined {
  return db.prepare(`SELECT * FROM agency_run_watch WHERE attempt_id = ?`).get(attemptId) as WatchRecord | undefined;
}

function save(db: SqlDatabase, row: WatchRecord, now: string): void {
  db.prepare(
    `INSERT INTO agency_run_watch
       (attempt_id, job_id, thread_status, status_since, progress_at, active_since, warned_at, outcome, outcome_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(attempt_id) DO UPDATE SET
       thread_status = excluded.thread_status, status_since = excluded.status_since,
       progress_at = excluded.progress_at, active_since = excluded.active_since,
       warned_at = excluded.warned_at, outcome = excluded.outcome, outcome_at = excluded.outcome_at,
       updated_at = excluded.updated_at`,
  ).run(
    row.attempt_id,
    row.job_id,
    row.thread_status,
    row.status_since,
    row.progress_at,
    row.active_since,
    row.warned_at,
    row.outcome,
    row.outcome_at,
    now,
  );
}

function latest(values: ReadonlyArray<string | null | undefined>): string {
  let best = "";
  let bestMs = -Infinity;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > bestMs) {
      best = value;
      bestMs = ms;
    }
  }
  return best;
}

export function superviseRun(ports: RunWatchPorts, row: RunWatchRow, observation: RunWatchObservation): RunWatchOutcome {
  const job = ports.getJob(row.jobId);
  const attempt = ports.attemptForLaunch(row.launchId);
  if (!job || !attempt || attempt.state !== "running" || job.state !== "running") return "skipped";
  const now = ports.now();
  const nowMs = Date.parse(now);
  const status = observation.threadStatus;
  const t: RunWatchThresholds = { ...DEFAULT_RUN_WATCH_THRESHOLDS, ...(ports.thresholds?.(job) ?? {}) };
  const stored = read(ports.db, attempt.id);
  if (stored?.outcome) return "skipped";

  const record: WatchRecord = stored ?? {
    attempt_id: attempt.id,
    job_id: job.id,
    thread_status: status,
    status_since: now,
    progress_at: now,
    active_since: status && ACTIVE_STATUSES.has(status) ? now : null,
    warned_at: null,
    outcome: null,
    outcome_at: null,
  };
  if (stored && stored.thread_status !== status) {
    // A status change is itself a sign of life and opens a new episode.
    record.thread_status = status;
    record.status_since = now;
    record.progress_at = now;
    record.active_since = status && ACTIVE_STATUSES.has(status) ? (stored.active_since ?? now) : null;
    record.warned_at = null;
  }
  record.progress_at =
    observation.backgroundAgents > 0
      ? now
      : latest([record.progress_at, observation.threadUpdatedAt, ports.lastProgressAt(row.threadId, job.id)]) || now;

  const finish = (kind: "stalled" | "not_started" | "error" | "ceiling"): RunWatchOutcome => {
    const blocked = ports.block(job, runWatchText(kind, job.key, agencyLanguage(), t));
    if (blocked) {
      record.outcome = kind;
      record.outcome_at = now;
    }
    save(ports.db, record, now);
    return blocked ? "blocked" : "ok";
  };

  if (status === "idle") {
    // The completion reminder owns idle; an idle thread is never stalled.
    record.active_since = null;
    record.warned_at = null;
    save(ports.db, record, now);
    return "ok";
  }
  const inStatusMs = nowMs - Date.parse(record.status_since);
  if (status === "error") {
    if (inStatusMs >= t.errorMs) return finish("error");
    save(ports.db, record, now);
    return "ok";
  }
  if (status && STARTING_STATUSES.has(status)) {
    if (inStatusMs >= t.startMs) return finish("not_started");
    save(ports.db, record, now);
    return "ok";
  }
  // active, stopping, unknown status or an unreadable thread.
  if (record.active_since && nowMs - Date.parse(record.active_since) >= t.ceilingMs) return finish("ceiling");
  const quietMs = nowMs - Date.parse(record.progress_at);
  if (quietMs >= t.stallMs) return finish("stalled");
  if (quietMs >= t.quietMs && !record.warned_at) {
    if (ports.comment(job, runWatchText("quiet", job.key, agencyLanguage(), t))) record.warned_at = now;
    save(ports.db, record, now);
    return record.warned_at === now ? "warned" : "ok";
  }
  save(ports.db, record, now);
  return "ok";
}

/** Latest progress signal for a thread and its job, straight from the plugin database. */
export function lastProgressFromDatabase(db: SqlDatabase, threadId: string, jobId: string): string | null {
  const usage = db
    .prepare(`SELECT MAX(created_at) AS at FROM agency_usage_event WHERE thread_id = ?`)
    .get(threadId) as { at: string | null } | undefined;
  const activity = db
    .prepare(`SELECT MAX(timestamp) AS at FROM agency_activity WHERE job_id = ?`)
    .get(jobId) as { at: string | null } | undefined;
  return latest([usage?.at, activity?.at]) || null;
}
