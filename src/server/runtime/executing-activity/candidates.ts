import type { SqlDatabase } from "../../db/sql.js";

export type BoundExecutingCandidate = {
  jobId: string;
  attemptId: string;
  launchId: string;
  threadId: string;
};

/**
 * Verified bound executing rows: Job+attempt `running`, receipt confirmed and
 * `job_bind_state = applied`, current attempt `thread_id`/`launch_id` equal the receipt.
 * waiting_input / review / awaiting_review / done stay out.
 */
export function listBoundExecutingCandidates(db: SqlDatabase): BoundExecutingCandidate[] {
  const rows = db
    .prepare(
      `SELECT j.id AS jobId, a.id AS attemptId, r.launch_id AS launchId, r.thread_id AS threadId
       FROM agency_job j
       INNER JOIN agency_run_attempt a ON a.job_id = j.id
       INNER JOIN agency_launch_receipt r ON r.attempt_id = a.id AND r.job_id = j.id
       WHERE j.state = 'running'
         AND a.state = 'running'
         AND r.spawn_kind = 'confirmed'
         AND r.job_bind_state = 'applied'
         AND a.thread_id IS NOT NULL
         AND a.launch_id IS NOT NULL
         AND r.thread_id IS NOT NULL
         AND a.thread_id = r.thread_id
         AND a.launch_id = r.launch_id`,
    )
    .all() as Array<{ jobId: string; attemptId: string; launchId: string; threadId: string | null }>;
  return rows.filter((row): row is BoundExecutingCandidate => typeof row.threadId === "string" && row.threadId.length > 0);
}
