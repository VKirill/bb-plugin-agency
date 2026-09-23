import type { SqlDatabase } from "../db/sql";
import type { Job } from "../../shared/contracts";
import { progressSignal } from "./observations";
import { readLaunchIssue, resolveLaunchIssue } from "../runtime/launch-queue/issues";

/** Advisory only. Uses the durable lead delivery path; never cancels or respawns a worker. */
export function sweepProgressSignals(db: SqlDatabase, getJob: (id: string) => Job | undefined, notify: (job: Job, code: string) => void) {
  const rows = db.prepare(`SELECT id FROM agency_job WHERE state = 'running'
    UNION SELECT job_id AS id FROM agency_launch_issue WHERE code = 'progress_stalled'`).all() as Array<{ id: string }>;
  for (const row of rows) {
    const job = getJob(row.id);
    const issue = readLaunchIssue(db, row.id);
    const signal = job?.state === 'running' ? progressSignal(db, row.id) : null;
    if (!signal) {
      if (issue?.code === 'progress_stalled') resolveLaunchIssue(db, row.id);
      continue;
    }
    // A launch/contract incident already has its own responsible lead and delivery record.
    if (!issue || issue.code === 'progress_stalled') notify(job!, 'progress_stalled');
  }
}
