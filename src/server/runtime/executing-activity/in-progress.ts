import type { SqlDatabase } from "../../db/sql.js";

export type InProgressJobCount =
  | { available: true; inProgressJobCount: number }
  | { available: false };

export type InProgressJobCountPorts = {
  listRunningJobIds: () => string[];
};

/** Distinct jobs with `Job.state === running` (list «В работе»). Not thread status. */
export function listRunningJobIds(db: SqlDatabase): string[] {
  return (db.prepare(`SELECT id FROM agency_job WHERE state = 'running'`).all() as Array<{ id: string }>).map(
    (row) => row.id,
  );
}

export function countInProgressJobs(ports: InProgressJobCountPorts): InProgressJobCount {
  try {
    return { available: true, inProgressJobCount: new Set(ports.listRunningJobIds()).size };
  } catch {
    return { available: false };
  }
}
