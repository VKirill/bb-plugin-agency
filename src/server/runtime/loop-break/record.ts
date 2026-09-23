import { latestReviewText } from "../conveyor/verdict.js";
import { recoveryHistory } from "../recovery/history.js";
import { loopEffect } from "./mark.js";
import type { Job } from "../../../shared/contracts";
import type { SqlDatabase } from "../../db/sql";
import { askLoopBreak, LOOP_BREAK_POINT, loopBreakState } from "../../decisions/loop-break.js";
import { appendDecisionLog } from "../../decisions/log.js";
import { getDecisionSettings } from "../../decisions/settings.js";
import {
  hasLoopFingerprint,
  insertLoopMark,
  latestAttemptId,
  latestEvidenceHash,
  latestLoopMark,
  loopFingerprint,
  rootJobId,
} from "./store.js";

/**
 * Once per evidence fingerprint on the line. The same fingerprint is not asked
 * again. No attempt id, a disabled point, or a failed call writes nothing:
 * the line keeps its rework limit and does not gain a block.
 */
export async function noteReworkLoop(db: SqlDatabase, job: Job, now = new Date().toISOString(), notifyLead?: (workJobId: string) => void): Promise<void> {
  const settings = getDecisionSettings(db);
  const comment = latestReviewText(db, job.id);
  if (!comment) return;
  if (!settings.enabled || !settings.points.includes(LOOP_BREAK_POINT)) return;
  const root = rootJobId(db, job.parentJobId ?? job.id);
  const source = db.prepare(`SELECT j.id, j.rework_of_job_id FROM agency_job j WHERE j.id = COALESCE(
    (SELECT job_id FROM agency_auto_review WHERE review_job_id = ? LIMIT 1),
    (SELECT i.source_job_id FROM agency_job_input_ref i JOIN agency_job w ON w.id = i.source_job_id
      LEFT JOIN agency_membership m ON m.department_id = w.department_id AND m.agent_id = w.assigned_agent_id
      WHERE i.target_job_id = ? AND COALESCE(m.role, '') != 'reviewer' ORDER BY w.rowid DESC LIMIT 1))`).get(job.id, job.id) as
    { id: string; rework_of_job_id: string | null } | undefined;
  const workJobId = source ? source.rework_of_job_id ?? source.id : null;
  const rootJob = db.prepare(`SELECT key, title, acceptance FROM agency_job WHERE id = ?`).get(root) as
    | { key: string; title: string; acceptance: string }
    | undefined;
  const attemptId = latestAttemptId(db, job.id) ?? latestAttemptId(db, root);
  if (!attemptId || !rootJob) return;
  const fingerprint = loopFingerprint(`${rootJob.acceptance}\nwork:${workJobId ?? job.id}`, comment, latestEvidenceHash(db, job.id));
  if (hasLoopFingerprint(db, root, fingerprint)) return;
  const prior = latestLoopMark(db, root, workJobId ?? undefined);
  const asked = await askLoopBreak(
    settings,
    loopBreakState({
      key: rootJob.key,
      title: rootJob.title,
      acceptance: rootJob.acceptance,
      prior: [prior ? `${prior.relation ?? "unknown"}/${prior.cause ?? "unknown"}` : "", source ? recoveryHistory(db, source.id, job.id) : ""].join("\n"),
      defects: comment,
    }),
  );
  const row = appendDecisionLog(
    db,
    asked
      ? {
          point: LOOP_BREAK_POINT,
          jobKey: job.key,
          outcome: asked.relation ?? asked.cause ?? "uncertain",
          detail: `${asked.relation ?? "-"}/${asked.cause ?? "-"}`,
          answers: asked.answers,
          ms: asked.ms,
        }
      : { point: LOOP_BREAK_POINT, jobKey: job.key, outcome: "failed", detail: "no_answer" },
    now,
  );
  void row;
  if (!asked) return;
  insertLoopMark(db, {
    rootJobId: root,
    workJobId,
    attemptId,
    fingerprint,
    relation: asked.relation,
    cause: asked.cause,
    createdAt: now,
  });
  if (source && loopEffect(asked) === "block") notifyLead?.(source.id);
}
