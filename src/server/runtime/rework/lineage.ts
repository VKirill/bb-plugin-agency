import type { SqlDatabase } from "../../db/sql";

/** Both an in-thread return and a linked replacement consume the same result's budget. */
export function reworkRoundCount(db: SqlDatabase, lineId: string): number {
  const replacements = db.prepare(`SELECT COUNT(*) AS n FROM agency_job WHERE rework_of_job_id = ? AND state != 'canceled'`).get(lineId) as { n: number };
  const returns = db.prepare(`SELECT COUNT(*) AS n FROM agency_rework r JOIN agency_job j ON j.id = r.job_id
    WHERE (j.id = ? OR j.rework_of_job_id = ?) AND j.state != 'canceled' AND r.send_state = 'confirmed'`).get(lineId, lineId) as { n: number };
  return replacements.n + returns.n;
}
