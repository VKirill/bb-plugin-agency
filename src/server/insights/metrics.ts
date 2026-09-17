import type { SqlDatabase } from "../db/sql";

/**
 * Employee metrics from Agency data only: what the employee holds now, what it
 * finished, how often its work came back and how long a job took. Spend is
 * added by the caller from token usage.
 */

export type AgentMetrics = {
  agentId: string;
  open: number;
  blocked: number;
  inReview: number;
  done30d: number;
  canceled30d: number;
  /** Median hours from job creation to done over the last 90 days; null without data. */
  medianLeadHours: number | null;
  /** Share of done jobs (90 days) accepted without a return for rework, 0–100; null without data. */
  firstPassPercent: number | null;
  reworkReturns90d: number;
  attempts30d: number;
  failedAttempts30d: number;
  lastActivityAt: string | null;
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function agentMetrics(db: SqlDatabase, agentId: string, now: Date): AgentMetrics {
  const days = (count: number) => new Date(now.getTime() - count * 86_400_000).toISOString();
  const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  const done90 = db
    .prepare(
      `SELECT j.id, j.closed_at, (SELECT MIN(a.timestamp) FROM agency_activity a WHERE a.job_id = j.id) AS created_at
       FROM agency_job j WHERE j.assigned_agent_id = ? AND j.state = 'done' AND j.closed_at >= ?`,
    )
    .all(agentId, days(90)) as { id: string; closed_at: string; created_at: string | null }[];
  const leadHours = done90
    .filter((row) => row.created_at)
    .map((row) => (Date.parse(row.closed_at) - Date.parse(row.created_at!)) / 3_600_000)
    .filter((hours) => Number.isFinite(hours) && hours >= 0);
  const reworked = new Set(
    (db.prepare(`SELECT DISTINCT job_id FROM agency_rework WHERE created_at >= ?`).all(days(90)) as { job_id: string }[]).map((row) => row.job_id),
  );
  const firstPass = done90.filter((row) => !reworked.has(row.id)).length;
  const lastActivity = db
    .prepare(`SELECT MAX(timestamp) AS at FROM agency_activity WHERE actor LIKE ?`)
    .get(`%"agentId":"${agentId}"%`) as { at: string | null };
  return {
    agentId,
    open: count(`SELECT COUNT(*) AS n FROM agency_job WHERE assigned_agent_id = ? AND state NOT IN ('done', 'canceled')`, agentId),
    blocked: count(`SELECT COUNT(*) AS n FROM agency_job WHERE assigned_agent_id = ? AND state IN ('blocked', 'waiting_input')`, agentId),
    inReview: count(`SELECT COUNT(*) AS n FROM agency_job WHERE assigned_agent_id = ? AND state = 'review'`, agentId),
    done30d: count(`SELECT COUNT(*) AS n FROM agency_job WHERE assigned_agent_id = ? AND state = 'done' AND closed_at >= ?`, agentId, days(30)),
    canceled30d: count(`SELECT COUNT(*) AS n FROM agency_job WHERE assigned_agent_id = ? AND state = 'canceled' AND closed_at >= ?`, agentId, days(30)),
    medianLeadHours: median(leadHours) === null ? null : Math.round(median(leadHours)! * 10) / 10,
    firstPassPercent: done90.length ? Math.round((firstPass / done90.length) * 100) : null,
    reworkReturns90d: count(
      `SELECT COUNT(*) AS n FROM agency_rework r JOIN agency_job j ON j.id = r.job_id WHERE j.assigned_agent_id = ? AND r.created_at >= ?`,
      agentId,
      days(90),
    ),
    attempts30d: count(`SELECT COUNT(*) AS n FROM agency_run_attempt a JOIN agency_job j ON j.id = a.job_id WHERE j.assigned_agent_id = ? AND a.created_at >= ?`, agentId, days(30)),
    failedAttempts30d: count(
      `SELECT COUNT(*) AS n FROM agency_run_attempt a JOIN agency_job j ON j.id = a.job_id WHERE j.assigned_agent_id = ? AND a.state = 'failed' AND a.created_at >= ?`,
      agentId,
      days(30),
    ),
    lastActivityAt: lastActivity.at,
  };
}
