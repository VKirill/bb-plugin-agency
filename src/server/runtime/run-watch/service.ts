import { failureKind, failureAdvice } from "./failure-policy";
import { agencyLanguage, type AgencyLanguage } from "../../i18n/language.js";
import type { Job } from "../../../shared/contracts";
import type { SqlDatabase } from "../../db/sql";
import { isUsageLimitDetail } from "../agent-fallback.js";

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
/**
 * A provider error BB itself retries — a subscription window, an overload, a broken
 * connection — is not a dead attempt. BB waits for the reset (up to six hours by default)
 * and sends a continuation into the same thread, so the watch waits with it and only
 * tells the owner. A machine that went offline is the same case: nothing is lost.
 */
export const RUN_WATCH_PROVIDER_WAIT_MS = 6 * 60 * 60_000;
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
  /** Why the thread is in error, as BB reported it; null when unknown. */
  providerError?: (threadId: string) => string | null;
  /**
   * What BB said on the error event: false = it will not continue this thread.
   * Null when BB did not say. A usage limit with willRetry false is a dead attempt.
   */
  bbWillRetry?: (threadId: string) => boolean | null;
  queuedWork?: (threadId: string) => boolean | null;
  /** False when the machine of the job is offline: the attempt waits for it to come back. */
  hostOnline?: (job: Job) => boolean | null;
  /** Owner-set reserve is ready for this attempt (still on the primary). */
  canSwitchToFallback?: (job: Job, row: RunWatchRow) => boolean;
  /** Cancel this attempt and requeue on the reserve. Does not rewrite the profile. */
  switchToFallback?: (job: Job, row: RunWatchRow) => boolean;
  onReworkPhase?: (event: { jobId: string; attemptId: string; reworkAt: string; previousActiveSince: string | null }) => void;
  now: () => string;
};

export type RunWatchOutcome = "skipped" | "ok" | "warned" | "blocked" | "fallback";

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
  rework_at: string | null;
};

const ACTIVE_STATUSES = new Set(["active", "stopping"]);
const STARTING_STATUSES = new Set(["pending", "starting"]);

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

export function runWatchText(
  kind: "quiet" | "stalled" | "not_started" | "error" | "ceiling" | "provider_wait" | "usage_limit",
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
    const stopEn = `Worker: save a checkpoint and report to the lead; do not cancel or relaunch yourself. Responsible lead: diagnose this attempt first. Only if replacement is necessary, use bb agency launch cancel after checkpoint, then authorize recovery of ${jobKey}.`;
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
        return `Agency: ${jobKey} has worked non-stop for more than ${minutes(RUN_WATCH_CEILING_MS) / 60} h — the ceiling of continuous work in this phase. The job moved to «needs decision»: check that the employee is not looping and split the work. ${stopEn}`;
      case "provider_wait":
        return `Agency: the ${jobKey} thread is in error, and BB is waiting to carry it on by itself — a subscription window, an overload or a machine that went offline. The job stays in work; nothing is lost. ${stopEn}`;
      case "usage_limit":
        return `Agency: ${jobKey} hit a usage limit, and BB will not continue this thread. The employee has no reserve model, so the job moved to «needs decision». Set a reserve on the employee and relaunch, or wait for the window to reset. ${stopEn}`;
    }
  }
  const stop = `Исполнителю: сохраните checkpoint и сообщите руководителю; не отменяйте и не перезапускайте себя. Руководителю: сначала установите причину. Только если нужна замена попытки, после checkpoint выполните bb agency launch cancel и разрешите recovery той же ${jobKey}.`;
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
      return `Агентство: ${jobKey} работает без перерыва дольше ${minutes(RUN_WATCH_CEILING_MS) / 60} ч — это потолок непрерывной работы в текущем этапе. Задача переведена в «Ожидает решения»: проверьте, не зациклился ли сотрудник, и разбейте работу. ${stop}`;
    case "provider_wait":
      return `Агентство: тред ${jobKey} в ошибке, но BB сам ждёт возможности продолжить — окно подписки, перегрузка провайдера или машина не в сети. Задача остаётся в работе, ничего не потеряно. ${stop}`;
    case "usage_limit":
      return `Агентство: у ${jobKey} закончился лимит провайдера, и BB этот тред продолжать не будет. У сотрудника нет запасной модели — задача переведена в «Ожидает решения». Задайте резерв у сотрудника и перезапустите, либо дождитесь сброса окна. ${stop}`;
  }
}

function read(db: SqlDatabase, attemptId: string): WatchRecord | undefined {
  return db.prepare(`SELECT * FROM agency_run_watch WHERE attempt_id = ?`).get(attemptId) as WatchRecord | undefined;
}

function save(db: SqlDatabase, row: WatchRecord, now: string): void {
  db.prepare(
    `INSERT INTO agency_run_watch
       (attempt_id, job_id, thread_status, status_since, progress_at, active_since, warned_at, outcome, outcome_at, updated_at, rework_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(attempt_id) DO UPDATE SET
       thread_status = excluded.thread_status, status_since = excluded.status_since,
       progress_at = excluded.progress_at, active_since = excluded.active_since,
       warned_at = excluded.warned_at, outcome = excluded.outcome, outcome_at = excluded.outcome_at,
       updated_at = excluded.updated_at, rework_at = excluded.rework_at`,
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
    row.rework_at,
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
    rework_at: null,
  };
  // Review/reclamation can occur entirely between watcher polls. The confirmed
  // return ledger is the durable work-phase boundary, not the job revision or
  // a comment. Rebase to its actual time (never to now), once, preserving elapsed
  // rework time even across server restarts and old false ceiling outcomes.
  const reworkAt = (ports.db.prepare(`SELECT MAX(COALESCE(confirmed_at, created_at)) AS at FROM agency_rework
    WHERE attempt_id = ? AND send_state = 'confirmed'`).get(attempt.id) as { at: string | null }).at;
  if (reworkAt && Date.parse(reworkAt) <= nowMs && (!record.rework_at || Date.parse(reworkAt) > Date.parse(record.rework_at))) {
    const previousActiveSince = record.active_since;
    record.rework_at = reworkAt;
    record.active_since = status && ACTIVE_STATUSES.has(status) ? latest([stored?.active_since, reworkAt]) : null;
    record.status_since = latest([stored?.status_since, reworkAt]);
    record.progress_at = latest([record.progress_at, reworkAt]);
    record.warned_at = null;
    record.outcome = null;
    record.outcome_at = null;
    save(ports.db, record, now);
    ports.onReworkPhase?.({ jobId: job.id, attemptId: attempt.id, reworkAt, previousActiveSince });
  }
  // A lead may resume a transport-failed turn in the same attempt. Require
  // actual thread activity, not merely a job-state reset, to re-arm supervision.
  // Other outcomes (especially the work ceiling) require their own recovery.
  if (record.outcome === "error" && record.thread_status === "error" && status === "active") {
    record.outcome = null;
    record.outcome_at = null;
  }
  if (record.outcome) return "skipped";
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

  const finish = (kind: "stalled" | "not_started" | "error" | "ceiling" | "usage_limit"): RunWatchOutcome => {
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
    const detail = ports.providerError?.(row.threadId);
    const bbRetries = ports.bbWillRetry?.(row.threadId);
    const queued = ports.queuedWork?.(row.threadId) === true;
    if (!queued && bbRetries !== true && isUsageLimitDetail(detail) && ports.canSwitchToFallback?.(job, row) && ports.switchToFallback) {
      const switched = ports.switchToFallback(job, row);
      if (switched) {
        record.outcome = "fallback";
        record.outcome_at = now;
        save(ports.db, record, now);
        return "fallback";
      }
    }
    // BB said it will not continue this thread: a usage limit is then a dead attempt, not a wait.
    if (!queued && isUsageLimitDetail(detail) && bbRetries === false) return finish("usage_limit");
    // Retry is a fact from BB or its durable queue, never a guess from error text.
    const waiting = bbRetries === true || queued || ports.hostOnline?.(job) === false;
    if (waiting && inStatusMs < RUN_WATCH_PROVIDER_WAIT_MS) {
      if (!record.warned_at && ports.comment(job, runWatchText("provider_wait", job.key, agencyLanguage(), t))) record.warned_at = now;
      save(ports.db, record, now);
      return record.warned_at === now ? "warned" : "ok";
    }
    const kind = failureKind(detail);
    const actionable = ["auth", "context", "model", "environment"].includes(kind);
    if (actionable || inStatusMs >= t.errorMs) {
      const en = agencyLanguage() === "en";
      const text = (en ? `Agency: ${job.key} needs the lead's decision (${kind}). ` : `Агентство: ${job.key} требует решения руководителя (${kind}). `)
        + failureAdvice(kind, en);
      const blocked = ports.block(job, text);
      if (blocked) { record.outcome = "error"; record.outcome_at = now; }
      save(ports.db, record, now);
      return blocked ? "blocked" : "ok";
    }
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
