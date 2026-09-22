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

const VERDICT_LINE = /(?:вердикт|verdict)\s*[:：]?\s*(?:принять|accept|доработать|rework|return)/i;

function verdictComment(db: SqlDatabase, jobId: string): string {
  const rows = db
    .prepare(
      `SELECT comment FROM agency_activity WHERE job_id = ? AND kind = 'comment' AND comment IS NOT NULL ORDER BY rowid DESC`,
    )
    .all(jobId) as Array<{ comment: string }>;
  for (const row of rows) {
    if (VERDICT_LINE.test(row.comment)) return row.comment.trim();
  }
  return "";
}

/**
 * Once per evidence fingerprint on the line. The same fingerprint is not asked
 * again. No attempt id, a disabled point, or a failed call writes nothing:
 * the line keeps its rework limit and does not gain a block.
 */
export async function noteReworkLoop(db: SqlDatabase, job: Job, now = new Date().toISOString()): Promise<void> {
  const settings = getDecisionSettings(db);
  const comment = verdictComment(db, job.id);
  if (!comment) return;
  if (!settings.enabled || !settings.points.includes(LOOP_BREAK_POINT)) return;
  const root = rootJobId(db, job.parentJobId ?? job.id);
  const rootJob = db.prepare(`SELECT key, title, acceptance FROM agency_job WHERE id = ?`).get(root) as
    | { key: string; title: string; acceptance: string }
    | undefined;
  const attemptId = latestAttemptId(db, job.id) ?? latestAttemptId(db, root);
  if (!attemptId || !rootJob) return;
  const fingerprint = loopFingerprint(rootJob.acceptance, comment, latestEvidenceHash(db, job.id));
  if (hasLoopFingerprint(db, root, fingerprint)) return;
  const prior = latestLoopMark(db, root);
  const asked = await askLoopBreak(
    settings,
    loopBreakState({
      key: rootJob.key,
      title: rootJob.title,
      acceptance: rootJob.acceptance,
      prior: prior ? `${prior.relation ?? "unknown"}/${prior.cause ?? "unknown"}` : "",
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
    attemptId,
    fingerprint,
    relation: asked.relation,
    cause: asked.cause,
    createdAt: now,
  });
}
