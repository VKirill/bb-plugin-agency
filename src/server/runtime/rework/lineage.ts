import type { SqlDatabase } from "../../db/sql";
import { fail, ok, type DomainResult } from "../../../domain";
import { rulesForDepartment } from "../../rules/work-rules";
import { latestLoopMark, rootJobId } from "../loop-break/store";
import { loopEffect } from "../loop-break/mark";

/** Both an in-thread return and a linked replacement consume the same result's budget. */
export function reworkRoundCount(db: SqlDatabase, lineId: string): number {
  const replacements = db.prepare(`SELECT COUNT(*) AS n FROM agency_job WHERE rework_of_job_id = ?`).get(lineId) as { n: number };
  const returns = db.prepare(`SELECT COUNT(*) AS n FROM agency_rework r JOIN agency_job j ON j.id = r.job_id
    WHERE (j.id = ? OR j.rework_of_job_id = ?) AND r.send_state = 'confirmed'`).get(lineId, lineId) as { n: number };
  // A stopped worker followed by a new thread is another pass too. Reservations without a
  // bound thread did no work and must not consume this budget (catalog fixes, rejected spawn).
  const restarts = db.prepare(`SELECT COALESCE(SUM(n - 1), 0) AS n FROM (
    SELECT COUNT(*) AS n FROM agency_run_attempt a JOIN agency_job j ON j.id = a.job_id
    WHERE (j.id = ? OR j.rework_of_job_id = ?) AND a.thread_id IS NOT NULL
    GROUP BY a.job_id HAVING COUNT(*) > 1
  )`).get(lineId, lineId) as { n: number };
  return replacements.n + returns.n + restarts.n;
}

/** Shared admission for readiness and the atomic reservation; never stops an existing run. */
export function assertRelaunchAllowed(db: SqlDatabase, jobId: string): DomainResult<true> {
  const job = db.prepare(`SELECT * FROM agency_job WHERE id = ?`).get(jobId) as
    { id: string; parent_job_id: string | null; rework_of_job_id: string | null; department_id: string } | undefined;
  if (!job) return fail("not_found", `job ${jobId} not found`);
  const lineId = job.rework_of_job_id ?? job.id;
  const root = rootJobId(db, job.parent_job_id ?? job.id);
  if (loopEffect(latestLoopMark(db, root, lineId)) === "block")
    return fail("loop_blocked", "A recorded loop blocks another launch on this result. Resolve the cause before retrying.");
  const previous = db.prepare(`SELECT 1 FROM agency_run_attempt WHERE job_id = ? AND thread_id IS NOT NULL LIMIT 1`).get(jobId);
  if (!previous) return ok(true);
  const used = reworkRoundCount(db, lineId);
  const limit = rulesForDepartment(db, job.department_id).reworkLimit;
  return used >= limit
    ? fail("rework_limit_reached", `${used} rework round(s), including worker restarts, already used; department limit ${limit}. Canceling and requeueing does not reset it. Resolve the repeated blocker and escalate for a decision; do not start another copy.`)
    : ok(true);
}
