import type { DomainResult } from "../../../domain";
import type { Job } from "../../../shared/contracts";
import type { SqlDatabase } from "../../db/sql";
import { agencyLanguage } from "../../i18n/language.js";

/**
 * Launch queue. A job whose launch waits for a free slot (concurrency limit),
 * budget or the jobs it depends on stays in the queue; a sweep launches it as soon as the limits allow,
 * highest priority first, then oldest request. Any other refusal takes the job
 * out of the queue with the reason in its history: a person decides.
 */

export const LAUNCH_QUEUE_MIGRATION = `CREATE TABLE agency_launch_queue (
    job_id TEXT PRIMARY KEY,
    requested_at TEXT NOT NULL,
    waiting_reason TEXT,
    updated_at TEXT NOT NULL
  )`;

export const LAUNCH_QUEUE_SWEEP_MS = 15_000;

/** Refusals that mean «wait», not «stop». */
export const WAIT_CODES = new Set(["concurrency_limit_reached", "budget_exhausted", "dependencies_open", "owns_overlap"]);

/**
 * Refusals that pass: a machine that blinked, a provider that answered 502, a launch that
 * did not start this time. The queue keeps the job and tries again instead of dropping it
 * silently — a job left in «queued» with nothing watching it waits forever.
 */
const TRANSIENT_CODES = new Set(["host_offline", "host_unavailable", "provider_unavailable", "launch_not_started", "provider_cli_missing"]);
const TRANSIENT_TEXT = /\b(50[0-9]|429)\b|not connected|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed/i;

/** The owner hears about a stuck launch after this long, and the job leaves the queue after the second one. */
export const TRANSIENT_NOTIFY_MS = 10 * 60_000;
export const TRANSIENT_GIVE_UP_MS = 60 * 60_000;
/** A job in «queued» with no queue row and no live attempt is put back after this long. */
export const QUEUE_REPAIR_MS = 5 * 60_000;

function transient(error: { code: string; message: string }): boolean {
  return TRANSIENT_CODES.has(error.code) || TRANSIENT_TEXT.test(error.message);
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export type QueueEntry = { jobId: string; position: number; requestedAt: string; waitingReason: string | null };

/** Puts the job in line. A job the queue had dropped starts a new round: the reason is cleared. */
export function enqueueLaunch(db: SqlDatabase, jobId: string, now: string): void {
  db.prepare(`INSERT OR IGNORE INTO agency_launch_queue (job_id, requested_at, waiting_reason, updated_at) VALUES (?, ?, NULL, ?)`).run(jobId, now, now);
  db.prepare(`UPDATE agency_launch_queue SET dropped_at = NULL, failing_since = NULL, waiting_reason = NULL, requested_at = ?, updated_at = ? WHERE job_id = ? AND dropped_at IS NOT NULL`).run(now, now, jobId);
}

/**
 * A job the queue gave up on keeps its row with `dropped_at`: the launch is not retried in a
 * loop, the reason stays visible, and the owner decides. A new `enqueueLaunch` starts it over.
 */
export function dropFromQueue(db: SqlDatabase, jobId: string, reason: string, now: string): void {
  db.prepare(`UPDATE agency_launch_queue SET dropped_at = ?, waiting_reason = ?, updated_at = ? WHERE job_id = ?`).run(now, reason, now, jobId);
}

export function dequeueLaunch(db: SqlDatabase, jobId: string): boolean {
  return db.prepare(`DELETE FROM agency_launch_queue WHERE job_id = ?`).run(jobId).changes > 0;
}

export function listLaunchQueue(db: SqlDatabase): QueueEntry[] {
  const rows = db
    .prepare(
      `SELECT q.job_id, q.requested_at, q.waiting_reason, j.priority
       FROM agency_launch_queue q JOIN agency_job j ON j.id = q.job_id WHERE q.dropped_at IS NULL`,
    )
    .all() as { job_id: string; requested_at: string; waiting_reason: string | null; priority: string }[];
  return rows
    .sort((a, b) => (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2) || a.requested_at.localeCompare(b.requested_at))
    .map((row, index) => ({ jobId: row.job_id, position: index + 1, requestedAt: row.requested_at, waitingReason: row.waiting_reason }));
}

export type LaunchQueuePorts = {
  db: SqlDatabase;
  getJob: (jobId: string) => Job | undefined;
  checkLimits: (job: Job) => Promise<DomainResult<{ warnings: string[] }>>;
  /** Prepares and launches the job with its current revision. */
  launch: (job: Job, requestedAt: string) => Promise<DomainResult<unknown>>;
  comment: (job: Job, text: string) => boolean;
  /** Tells the owner: a launch that keeps failing or leaves the queue is not visible otherwise. */
  notifyOwner?: (input: { jobId: string; text: string; dedupeKey: string }) => void;
  now: () => string;
};

function failureAge(db: SqlDatabase, jobId: string, now: string): number {
  const row = db.prepare(`SELECT failing_since FROM agency_launch_queue WHERE job_id = ?`).get(jobId) as { failing_since: string | null } | undefined;
  if (!row?.failing_since) {
    db.prepare(`UPDATE agency_launch_queue SET failing_since = ? WHERE job_id = ?`).run(now, jobId);
    return 0;
  }
  return Date.parse(now) - Date.parse(row.failing_since);
}

function clearFailure(db: SqlDatabase, jobId: string): void {
  db.prepare(`UPDATE agency_launch_queue SET failing_since = NULL WHERE job_id = ? AND failing_since IS NOT NULL`).run(jobId);
}

/**
 * A job in «queued» that no longer has a queue row and never got an attempt is stuck: the
 * queue dropped it, or a restart lost it. It goes back in line after a grace period, so a
 * launch never disappears without a trace.
 */
export function repairQueuedJobs(db: SqlDatabase, now: string, graceMs = QUEUE_REPAIR_MS): string[] {
  const rows = db
    .prepare(
      `SELECT j.id, j.updated_at FROM agency_job j
       WHERE j.state = 'queued'
         AND NOT EXISTS (SELECT 1 FROM agency_launch_queue q WHERE q.job_id = j.id)
         AND NOT EXISTS (SELECT 1 FROM agency_run_attempt a WHERE a.job_id = j.id)`,
    )
    .all() as { id: string; updated_at: string }[];
  const repaired: string[] = [];
  for (const row of rows) {
    if (Date.parse(now) - Date.parse(row.updated_at) < graceMs) continue;
    enqueueLaunch(db, row.id, now);
    repaired.push(row.id);
  }
  return repaired;
}

function setReason(db: SqlDatabase, jobId: string, reason: string, now: string): void {
  db.prepare(`UPDATE agency_launch_queue SET waiting_reason = ?, updated_at = ? WHERE job_id = ? AND COALESCE(waiting_reason, '') != ?`).run(reason, now, jobId, reason);
}

export async function sweepLaunchQueue(ports: LaunchQueuePorts): Promise<{ launched: number; removed: number }> {
  const en = agencyLanguage() === "en";
  let launched = 0;
  let removed = 0;
  for (const entry of listLaunchQueue(ports.db)) {
    const job = ports.getJob(entry.jobId);
    // Launched by hand, canceled or moved on: the queue has nothing to do.
    if (!job || (job.state !== "backlog" && job.state !== "queued")) {
      dequeueLaunch(ports.db, entry.jobId);
      removed += 1;
      continue;
    }
    const limits = await ports.checkLimits(job);
    if (!limits.ok) {
      if (WAIT_CODES.has(limits.error.code)) {
        setReason(ports.db, job.id, limits.error.message, ports.now());
        continue;
      }
    }
    const result = await ports.launch(job, entry.requestedAt);
    if (result.ok) {
      dequeueLaunch(ports.db, job.id);
      ports.comment(job, en ? "Launched from the queue: what it waited for is ready." : "Запущена из очереди: то, чего она ждала, готово.");
      launched += 1;
      continue;
    }
    if (WAIT_CODES.has(result.error.code)) {
      clearFailure(ports.db, job.id);
      setReason(ports.db, job.id, result.error.message, ports.now());
      continue;
    }
    const now = ports.now();
    if (transient(result.error)) {
      const age = failureAge(ports.db, job.id, now);
      setReason(ports.db, job.id, result.error.message, now);
      if (age < TRANSIENT_GIVE_UP_MS) {
        if (age >= TRANSIENT_NOTIFY_MS) {
          ports.notifyOwner?.({
            jobId: job.id,
            dedupeKey: `launch-queue-stuck:${job.id}:${entry.requestedAt}`,
            text: en
              ? `${job.key} has been waiting in the launch queue for more than ${Math.round(age / 60_000)} min: ${result.error.message}. The Agency keeps trying.`
              : `${job.key} ждёт в очереди запуска дольше ${Math.round(age / 60_000)} мин: ${result.error.message}. Агентство продолжает попытки.`,
          });
        }
        continue;
      }
    }
    removed += 1;
    const text = en
      ? `Left the launch queue: ${result.error.message}. Check readiness in the job card and launch by hand.`
      : `Снята с очереди запуска: ${result.error.message}. Проверьте готовность в карточке задачи и запустите вручную.`;
    dropFromQueue(ports.db, job.id, result.error.message, now);
    ports.comment(job, text);
    ports.notifyOwner?.({ jobId: job.id, dedupeKey: `launch-queue-left:${job.id}:${entry.requestedAt}`, text: `${job.key}: ${text}` });
  }
  return { launched, removed };
}
