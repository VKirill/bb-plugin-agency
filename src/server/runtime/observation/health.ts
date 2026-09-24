import type { SqlDatabase } from "../../db/sql";
import type { BoundLaunchWatch } from "../isolated-sdk/completion-watch";

export const OBSERVATION_HEALTH_MIGRATION = `CREATE TABLE agency_observer_health (
 launch_id TEXT NOT NULL, job_id TEXT NOT NULL, thread_id TEXT NOT NULL, stage TEXT NOT NULL,
 code TEXT NOT NULL, first_at TEXT NOT NULL, last_at TEXT NOT NULL,
 failures INTEGER NOT NULL, notified_at TEXT, PRIMARY KEY(launch_id,stage)
)`;
export type ObservationFault = { launchId: string; jobId: string; threadId: string; stage: string; code: string; firstAt: string; lastAt: string; failures: number; notifiedAt: string | null };
export function observationHealth(db: SqlDatabase, jobId: string): ObservationFault[] {
  return db.prepare(`SELECT launch_id AS launchId, job_id AS jobId, thread_id AS threadId, stage, code,
    first_at AS firstAt, last_at AS lastAt, failures, notified_at AS notifiedAt
    FROM agency_observer_health WHERE job_id = ? ORDER BY first_at`).all(jobId) as ObservationFault[];
}
/** Persist an outage episode across reloads. Healthy stages cannot clear another stage's failure. */
export function recordObservation(db: SqlDatabase, row: BoundLaunchWatch, stage: string, code: string | null, now: string,
  notify: (fault: ObservationFault) => boolean): "healthy" | "recovered" | "failed" | "notified" {
  if (code === null) return db.prepare("DELETE FROM agency_observer_health WHERE launch_id = ? AND stage = ?").run(row.launchId, stage).changes ? "recovered" : "healthy";
  db.prepare(`INSERT INTO agency_observer_health (launch_id,job_id,thread_id,stage,code,first_at,last_at,failures)
    VALUES (?,?,?,?,?,?,?,1) ON CONFLICT(launch_id,stage) DO UPDATE SET code=excluded.code,last_at=excluded.last_at,failures=failures+1`)
    .run(row.launchId, row.jobId, row.threadId, stage, code, now, now);
  const fault = observationHealth(db, row.jobId).find(f => f.launchId === row.launchId && f.stage === stage)!;
  if (!fault.notifiedAt && fault.failures >= 3 && Date.parse(now) - Date.parse(fault.firstAt) >= 60_000 && notify(fault)) {
    db.prepare("UPDATE agency_observer_health SET notified_at = ? WHERE launch_id = ? AND stage = ?").run(now, row.launchId, stage);
    return "notified";
  }
  return "failed";
}
