import { decisionFreshness, lessonFeedback, progressSignal } from "./observations";
import { rulesForDepartment } from "../rules/work-rules";
import type { SqlDatabase } from "../db/sql";
import type { Job } from "../../shared/contracts";
import { leadDecisionRecordSchema, type LeadDecision } from "../../shared/contracts/lead-control";
import { parentHandInReady } from "../runtime/hand-in/service";

export const LEAD_CONTROL_MIGRATION = `CREATE TABLE agency_lead_decision (
 job_id TEXT NOT NULL REFERENCES agency_job(id), revision INTEGER NOT NULL,
 body_json TEXT NOT NULL, activity_id TEXT NOT NULL REFERENCES agency_activity(id), PRIMARY KEY(job_id, revision)
);
CREATE TABLE agency_handin_protocol (attempt_id TEXT PRIMARY KEY REFERENCES agency_run_attempt(id));
CREATE TABLE agency_result_submission (
 attempt_id TEXT PRIMARY KEY REFERENCES agency_run_attempt(id), artifact_id TEXT NOT NULL,
 version INTEGER NOT NULL, hash TEXT NOT NULL, activity_id TEXT NOT NULL REFERENCES agency_activity(id)
);`;

export function readLeadDecision(db: SqlDatabase, jobId: string) {
  const row = db.prepare("SELECT * FROM agency_lead_decision WHERE job_id = ? ORDER BY revision DESC LIMIT 1").get(jobId) as
    { revision: number; body_json: string; activity_id: string } | undefined;
  return row ? leadDecisionRecordSchema.parse({ revision: row.revision, decision: JSON.parse(row.body_json) as LeadDecision, activityId: row.activity_id }) : null;
}

export function readLeadState(db: SqlDatabase, job: Job, offset: number, limit: number, beforeDecisionRevision?: number) {
  const decision = readLeadDecision(db, job.id);
  const decisionHistory = (db.prepare(`SELECT revision, body_json, activity_id FROM agency_lead_decision
    WHERE job_id = ? AND revision < ? ORDER BY revision DESC LIMIT 11`).all(job.id, beforeDecisionRevision ?? Number.MAX_SAFE_INTEGER) as
    Array<{ revision: number; body_json: string; activity_id: string }>);
  const decisions = decisionHistory.slice(0, 10).map(row => leadDecisionRecordSchema.parse({ revision: row.revision, decision: JSON.parse(row.body_json), activityId: row.activity_id }));
  const autonomousLearning = rulesForDepartment(db, job.departmentId).autoLearn;
  const lessonCandidates = db.prepare(`SELECT id, title, summary, source, revision FROM agency_knowledge
    WHERE scope_kind = 'department' AND scope_id = ? AND status = 'proposal' AND kind = 'lesson'
    ORDER BY updated_at DESC LIMIT 10`).all(job.departmentId) as Array<{ id: string; title: string; summary: string; source: string; revision: number }>;
  const candidates = db.prepare(`SELECT COUNT(*) AS n FROM agency_knowledge
    WHERE scope_kind = 'department' AND scope_id = ? AND status = 'proposal' AND kind = 'lesson'`).get(job.departmentId) as { n: number };
  const children = db.prepare(`SELECT id, key, title, state, assigned_agent_id AS assignedAgentId FROM agency_job
    WHERE parent_job_id = ? ORDER BY id LIMIT ? OFFSET ?`).all(job.id, limit, offset) as
    Array<{ id: string; key: string; title: string; state: string; assignedAgentId: string | null }>;
  const counts = db.prepare("SELECT state, COUNT(*) AS n FROM agency_job WHERE parent_job_id = ? GROUP BY state").all(job.id) as Array<{state: string; n: number}>;
  const total = counts.reduce((n, row) => n + row.n, 0);
  const publications = db.prepare(`SELECT v.artifact_id AS artifactId, v.version, v.hash, v.relative_path AS relativePath,
    (SELECT p.created_at FROM agency_artifact_publish_intent p WHERE p.artifact_id = v.artifact_id
      AND p.job_id = v.job_id AND p.version = v.version AND p.hash = v.hash AND p.state = 'committed') AS reservedAt
    FROM agency_artifact_version v WHERE v.job_id = ? AND v.version = (
      SELECT MAX(v2.version) FROM agency_artifact_version v2 WHERE v2.artifact_id = v.artifact_id AND v2.job_id = v.job_id
    )`).all(job.id) as Array<{ artifactId: string; version: number; hash: string; relativePath: string; reservedAt: string | null }>;
  const attempt = db.prepare(`SELECT a.id, p.attempt_id AS explicit, s.hash FROM agency_run_attempt a
    LEFT JOIN agency_handin_protocol p ON p.attempt_id = a.id
    LEFT JOIN agency_result_submission s ON s.attempt_id = a.id WHERE a.job_id = ? ORDER BY a.attempt_no DESC LIMIT 1`).get(job.id) as
    { id: string; explicit: string | null; hash: string | null } | undefined;
  return { job, decision, decisions, decisionFreshness: decisionFreshness(db, job.id, decision?.activityId), lessonFeedback: lessonFeedback(db, job.id), progressSignal: progressSignal(db, job.id), nextDecisionBeforeRevision: decisionHistory.length > 10 ? decisions.at(-1)!.revision : null, lessonCandidates: autonomousLearning ? lessonCandidates : [], lessonCandidateCount: autonomousLearning ? candidates.n : 0, decisionRevision: decision?.revision ?? 0, children,
    childCounts: Object.fromEntries(counts.map(row => [row.state, row.n])), nextOffset: offset + children.length < total ? offset + children.length : null,
    publications, handIn: { protocol: attempt?.explicit ? "explicit" as const : "legacy" as const,
      dependenciesReady: parentHandInReady(db, job.id), submittedHash: attempt?.hash ?? null },
    guidance: "The job brief and acceptance are authoritative. decisionFreshness=new_facts asks you to reconsider listed changes, not rewrite every decision. progressSignal is advisory: inspect the cited traces before intervening. lessonFeedback contains reported assessments, not causal proof; revisit harmful/not_helpful lessons and record evidence with knowledge feedback after actual use. Read child details/evidence as needed. Record a decision when the route changes; wait only on a real dependency. Progress and planning are not final submission. Lesson candidates are observations: inspect their source, establish cause/correction/verification/applicability before accepting a useful lesson. More candidates: knowledge list filtered by department/status proposal.",
  };
}
