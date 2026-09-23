import type { SqlDatabase } from "../../db/sql";
import { reworkRoundCount } from "../rework/lineage";
import { rootJobId } from "../loop-break/store";

export const RECOVERY_MIGRATION = `CREATE TABLE agency_recovery (
 request_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES agency_job(id),
 payload TEXT NOT NULL, actor TEXT NOT NULL, round_count INTEGER NOT NULL,
 mark_id TEXT NOT NULL, launch_failures INTEGER NOT NULL, created_at TEXT NOT NULL, consumed_attempt_id TEXT
); CREATE INDEX agency_recovery_job_idx ON agency_recovery(job_id);`;

function ready(db: SqlDatabase): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agency_recovery'").get());
}
export function failedLaunchCount(db: SqlDatabase, jobId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM agency_run_attempt WHERE job_id = ? AND state = 'failed' AND thread_id IS NULL").get(jobId) as { n: number }).n;
}
export function recoveryBasis(db: SqlDatabase, jobId: string): { rounds: number; markId: string; launchFailures: number } {
  const job = db.prepare("SELECT parent_job_id, rework_of_job_id FROM agency_job WHERE id = ?").get(jobId) as { parent_job_id: string | null; rework_of_job_id: string | null };
  const line = job.rework_of_job_id ?? jobId;
  const root = rootJobId(db, job.parent_job_id ?? jobId);
  const mark = db.prepare("SELECT id FROM agency_loop_mark WHERE root_job_id = ? AND (work_job_id = ? OR work_job_id IS NULL) ORDER BY created_at DESC, rowid DESC LIMIT 1").get(root, line) as { id: string } | undefined;
  return { rounds: reworkRoundCount(db, line), markId: mark?.id ?? "", launchFailures: failedLaunchCount(db, jobId) };
}
export function hasRecoveryPermit(db: SqlDatabase, jobId: string): boolean {
  if (!ready(db)) return false;
  const grant = db.prepare("SELECT round_count, mark_id, launch_failures FROM agency_recovery WHERE job_id = ? AND consumed_attempt_id IS NULL ORDER BY rowid DESC LIMIT 1").get(jobId) as { round_count: number; mark_id: string; launch_failures: number } | undefined;
  if (!grant) return false;
  const basis = recoveryBasis(db, jobId);
  return basis.rounds === grant.round_count && basis.markId === grant.mark_id && basis.launchFailures === grant.launch_failures;
}
/** Consume when a real thread is bound, not on rejected readiness or an empty reservation. */
export function consumeRecoveryPermit(db: SqlDatabase, jobId: string, attemptId: string): void {
  if (ready(db)) db.prepare("UPDATE agency_recovery SET consumed_attempt_id = ? WHERE job_id = ? AND consumed_attempt_id IS NULL").run(attemptId, jobId);
}
