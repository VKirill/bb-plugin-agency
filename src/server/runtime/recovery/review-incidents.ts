import type { SqlDatabase } from "../../db/sql";

/** A failed callback or review preparation must not leave review silently stuck.
 * Ordinary rework has already moved to running and is not an incident here.
 */
export function pendingReviewIncidents(db: SqlDatabase, now: string) {
  return db.prepare(`SELECT j.id AS jobId,
    CASE WHEN h.job_id IS NOT NULL THEN 'review_handoff_rejected' ELSE 'review_creation_failed' END AS code
    FROM agency_job j JOIN agency_artifact_version v ON v.rowid =
      (SELECT MAX(rowid) FROM agency_artifact_version WHERE job_id = j.id)
    LEFT JOIN agency_handin_hold h ON h.job_id = j.id AND h.hash = v.hash
    LEFT JOIN agency_auto_review q ON q.job_id = j.id AND q.hash = v.hash
    WHERE j.state = 'review' AND j.updated_at <= ? AND (h.job_id IS NOT NULL OR q.outcome = 'failed')
    ORDER BY j.updated_at LIMIT 100`).all(new Date(Date.parse(now) - 120_000).toISOString()) as Array<{ jobId: string; code: string }>;
}
