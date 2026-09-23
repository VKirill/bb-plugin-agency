import type { SqlDatabase } from "../../db/sql";

/** A plan/progress publication is not the parent's final hand-in. */
export function parentHandInReady(db: SqlDatabase, jobId: string): boolean {
  const open = db.prepare(`SELECT 1 FROM agency_job j WHERE j.parent_job_id = ?
    AND j.state NOT IN ('done', 'canceled')
    AND NOT EXISTS (SELECT 1 FROM agency_auto_review q WHERE q.review_job_id = j.id) LIMIT 1`).get(jobId);
  if (open) return false;
  return freshParentSummary(db, jobId);
}

/** Final publication must follow the last work-child change; automatic QC is excluded. */
export function freshParentSummary(db: SqlDatabase, jobId: string): boolean {
  const publication = db.prepare(`SELECT MAX(rowid) AS seq FROM agency_activity WHERE job_id = ? AND kind = 'artifact_published'`).get(jobId) as { seq: number | null };
  const lastWork = db.prepare(`SELECT MAX(a.rowid) AS seq FROM agency_activity a JOIN agency_job j ON j.id = a.job_id
    WHERE j.parent_job_id = ? AND a.kind IN ('job_created', 'artifact_published', 'job_transitioned')
      AND NOT EXISTS (SELECT 1 FROM agency_auto_review q WHERE q.review_job_id = j.id)`).get(jobId) as { seq: number | null };
  return lastWork.seq === null || (publication.seq !== null && publication.seq > lastWork.seq);
}

/**
 * A hand-in is a published version plus a closing comment from the employee:
 * the lead reads the comment, not the thread. A job does not go to review while
 * the working attempt has no such comment since it started or since the last
 * return for rework. The intake assessment is not a closing comment.
 */
export function handInCommentMissing(db: SqlDatabase, jobId: string): boolean {
  const attempt = db
    .prepare(
      `SELECT a.id, a.created_at, j.assigned_agent_id AS agent_id
       FROM agency_run_attempt a JOIN agency_job j ON j.id = a.job_id
       WHERE a.job_id = ? AND a.state IN ('running', 'awaiting_review')
       ORDER BY a.attempt_no DESC LIMIT 1`,
    )
    .get(jobId) as { id: string; created_at: string; agent_id: string | null } | undefined;
  if (!attempt) return false;
  const rework = db
    .prepare(`SELECT MAX(created_at) AS at FROM agency_rework WHERE job_id = ? AND attempt_id = ?`)
    .get(jobId, attempt.id) as { at: string | null };
  const since = rework.at && rework.at > attempt.created_at ? rework.at : attempt.created_at;
  const comments = db
    .prepare(
      `SELECT actor, references_json FROM agency_activity
       WHERE job_id = ? AND kind = 'comment' AND timestamp >= ?`,
    )
    .all(jobId, since) as { actor: string; references_json: string }[];
  return !comments.some((row) => {
    const actor = JSON.parse(row.actor) as { kind: string; agentId?: string };
    if (actor.kind !== "agent" || (attempt.agent_id && actor.agentId !== attempt.agent_id)) return false;
    return !row.references_json.includes('"intake_');
  });
}
