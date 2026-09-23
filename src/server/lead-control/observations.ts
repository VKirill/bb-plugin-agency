import type { SqlDatabase } from "../db/sql";
import type { z } from "zod";
import type { progressSignalSchema } from "../../shared/contracts/lead-control";

export const LESSON_FEEDBACK_MIGRATION = `CREATE TABLE agency_lesson_feedback (
 activity_id TEXT PRIMARY KEY REFERENCES agency_activity(id), job_id TEXT NOT NULL REFERENCES agency_job(id),
 knowledge_id TEXT NOT NULL REFERENCES agency_knowledge(id), revision INTEGER NOT NULL,
 outcome TEXT NOT NULL, evidence_json TEXT NOT NULL, comment TEXT NOT NULL
);
CREATE INDEX agency_lesson_feedback_job_idx ON agency_lesson_feedback(job_id, knowledge_id, revision);`;

const TREE = `WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT j.id FROM agency_job j JOIN tree t ON j.parent_job_id = t.id)`;

/** New facts ask for reconsideration; they do not invalidate the lead's reasoning. */
export function decisionFreshness(db: SqlDatabase, jobId: string, activityId: string | undefined) {
  if (!activityId) return { status: "missing" as const, count: 0, changes: [] };
  const rows = db.prepare(`${TREE} SELECT a.id AS activityId, a.job_id AS jobId, a.kind,
    COUNT(*) OVER() AS total FROM agency_activity a JOIN tree t ON t.id = a.job_id
    WHERE a.rowid > (SELECT rowid FROM agency_activity WHERE id = ?)
      AND (a.kind IN ('job_created','job_updated','job_transitioned','job_dependency_added','job_dependency_removed',
        'artifact_published','artifact_accepted','job_input_attached','lesson_feedback')
        OR EXISTS (SELECT 1 FROM json_each(a.references_json) r WHERE json_extract(r.value,'$.type') = 'launch_issue'))
    ORDER BY a.rowid DESC LIMIT 20`).all(jobId, activityId) as Array<{ activityId: string; jobId: string; kind: string; total: number }>;
  return { status: rows.length ? "new_facts" as const : "current" as const, count: rows[0]?.total ?? 0,
    changes: rows.map(({ total: _total, ...row }) => row) };
}

/** Latest reported assessment per job and exact lesson revision. Reads are not outcomes. */
export function lessonFeedback(db: SqlDatabase, jobId: string) {
  return (db.prepare(`${TREE} SELECT f.* FROM agency_lesson_feedback f JOIN tree t ON t.id = f.job_id
    WHERE f.rowid = (SELECT MAX(f2.rowid) FROM agency_lesson_feedback f2
      WHERE f2.job_id = f.job_id AND f2.knowledge_id = f.knowledge_id AND f2.revision = f.revision)
    ORDER BY f.rowid DESC LIMIT 30`).all(jobId) as Array<{ activity_id: string; job_id: string; knowledge_id: string; revision: number; outcome: "helped" | "not_helpful" | "harmful" | "not_applicable"; evidence_json: string; comment: string }>).map(r => ({
      activityId: r.activity_id, jobId: r.job_id, knowledgeId: r.knowledge_id, revision: r.revision,
      outcome: r.outcome, evidence: JSON.parse(r.evidence_json) as string[], comment: r.comment,
    }));
}

/** Three distinct failed requests of one operation/reason in the current attempt.
 * Success of that operation clears its failures. A new published hash starts a new evidence epoch.
 * Polls, idempotent retries, elapsed time and plain progress comments do not establish a loop.
 */
export function progressSignal(db: SqlDatabase, jobId: string): z.infer<typeof progressSignalSchema> | null {
  const attempt = db.prepare(`SELECT id, state FROM agency_run_attempt WHERE job_id = ?
    ORDER BY attempt_no DESC LIMIT 1`).get(jobId) as { id: string; state: string } | undefined;
  if (!attempt || attempt.state !== "running") return null;
  const rows = db.prepare(`SELECT id, step, outcome, reason, request_id, artifact_hash FROM agency_trace
    WHERE job_id = ? AND attempt_id = ? AND step NOT LIKE 'lead.%'
    AND outcome IN ('failed','succeeded') ORDER BY id DESC LIMIT 500`).all(jobId, attempt.id) as
    Array<{ id: number; step: string; outcome: string; reason: string; request_id: string | null; artifact_hash: string | null }>;
  const failures = new Map<string, { step: string; reason: string; ids: number[]; requests: Set<string> }>();
  const hashes = new Set<string>();
  for (const row of rows.reverse()) {
    if (row.step === 'publishArtifactVersion' && row.outcome === 'succeeded' && row.artifact_hash && !hashes.has(row.artifact_hash)) {
      hashes.add(row.artifact_hash); failures.clear();
    }
    if (row.outcome === 'succeeded') {
      for (const [key, group] of failures) if (group.step === row.step) failures.delete(key);
      continue;
    }
    if (!row.request_id || row.step === 'getIsolationReadiness') continue;
    const key = `${row.step}:${row.reason}`;
    const group = failures.get(key) ?? { step: row.step, reason: row.reason, ids: [], requests: new Set<string>() };
    if (!group.requests.has(row.request_id)) { group.requests.add(row.request_id); group.ids.push(row.id); }
    failures.set(key, group);
  }
  const group = [...failures.values()].filter(g => g.ids.length >= 3).sort((a, b) => b.ids.at(-1)! - a.ids.at(-1)!)[0];
  return group ? { step: group.step, reason: group.reason, count: group.ids.length, traceIds: group.ids.slice(-10), attemptId: attempt.id } : null;
}
