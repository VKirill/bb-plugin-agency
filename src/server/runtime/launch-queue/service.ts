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
export const WAIT_CODES = new Set(["concurrency_limit_reached", "budget_exhausted", "dependencies_open"]);

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export type QueueEntry = { jobId: string; position: number; requestedAt: string; waitingReason: string | null };

export function enqueueLaunch(db: SqlDatabase, jobId: string, now: string): void {
  db.prepare(`INSERT OR IGNORE INTO agency_launch_queue (job_id, requested_at, waiting_reason, updated_at) VALUES (?, ?, NULL, ?)`).run(jobId, now, now);
}

export function dequeueLaunch(db: SqlDatabase, jobId: string): boolean {
  return db.prepare(`DELETE FROM agency_launch_queue WHERE job_id = ?`).run(jobId).changes > 0;
}

export function listLaunchQueue(db: SqlDatabase): QueueEntry[] {
  const rows = db
    .prepare(
      `SELECT q.job_id, q.requested_at, q.waiting_reason, j.priority
       FROM agency_launch_queue q JOIN agency_job j ON j.id = q.job_id`,
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
  now: () => string;
};

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
      setReason(ports.db, job.id, result.error.message, ports.now());
      continue;
    }
    dequeueLaunch(ports.db, job.id);
    removed += 1;
    ports.comment(
      job,
      en
        ? `Left the launch queue: ${result.error.message}. Check readiness in the job card and launch by hand.`
        : `Снята с очереди запуска: ${result.error.message}. Проверьте готовность в карточке задачи и запустите вручную.`,
    );
  }
  return { launched, removed };
}
