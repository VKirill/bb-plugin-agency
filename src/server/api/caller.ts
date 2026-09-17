import { AsyncLocalStorage } from "node:async_hooks";
import type { SqlDatabase } from "../db/sql";

/**
 * Who is calling through the CLI. BB passes the calling thread to the CLI
 * handler; a thread bound to an Agency attempt is that attempt's employee. RPC
 * calls from the interface carry no thread: they act as the owner.
 */
export type CallerAttempt = {
  threadId: string;
  attemptId: string;
  jobId: string;
  agentId: string | null;
};

const scope = new AsyncLocalStorage<{ threadId: string | null }>();

export function withCallerThread<T>(threadId: string | null, run: () => T): T {
  return scope.run({ threadId }, run);
}

export function callerThreadId(): string | null {
  return scope.getStore()?.threadId ?? null;
}

export function callerAttemptForThread(db: SqlDatabase, threadId: string): CallerAttempt | null {
  const row = db
    .prepare(
      `SELECT a.id, a.job_id, j.assigned_agent_id FROM agency_run_attempt a LEFT JOIN agency_job j ON j.id = a.job_id
       WHERE a.thread_id = ? ORDER BY a.created_at DESC, a.attempt_no DESC LIMIT 1`,
    )
    .get(threadId) as { id: string; job_id: string; assigned_agent_id: string | null } | undefined;
  return row ? { threadId, attemptId: row.id, jobId: row.job_id, agentId: row.assigned_agent_id } : null;
}
