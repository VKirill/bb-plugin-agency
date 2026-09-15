import type { BoundExecutingCandidate } from "./candidates.js";

/** Badge counts this core `threads.get` status only. `starting` / `idle` are not N. */
export const EXECUTING_THREAD_STATUS = "active" as const;

export type BoundThreadView = {
  id: string;
  status?: string;
  experimental_callerLaunchId?: string;
  experimental_callerAttemptId?: string;
  experimental_callerJobId?: string;
};

export type ExecutingActivityCount =
  | { available: true; executingJobCount: number }
  | { available: false };

export type ExecutingActivityPorts = {
  listCandidates: () => BoundExecutingCandidate[];
  getThread: (threadId: string) => Promise<BoundThreadView>;
};

function verifiedActiveBind(candidate: BoundExecutingCandidate, thread: BoundThreadView): boolean {
  return (
    thread.id === candidate.threadId &&
    thread.status === EXECUTING_THREAD_STATUS &&
    thread.experimental_callerJobId === candidate.jobId &&
    thread.experimental_callerLaunchId === candidate.launchId &&
    thread.experimental_callerAttemptId === candidate.attemptId
  );
}

/**
 * Distinct Agency jobs whose bound thread is actually `active`.
 * Successful get with idle/starting/mismatch skips that job.
 * Any candidate lookup throw → `{ available: false }` (no partial N, no error text).
 * Zero candidates → `{ available: true, executingJobCount: 0 }`.
 */
export async function countExecutingJobs(ports: ExecutingActivityPorts): Promise<ExecutingActivityCount> {
  let candidates: BoundExecutingCandidate[];
  try {
    candidates = ports.listCandidates();
  } catch {
    return { available: false };
  }

  const jobs = new Set<string>();
  for (const candidate of candidates) {
    let thread: BoundThreadView;
    try {
      thread = await ports.getThread(candidate.threadId);
    } catch {
      return { available: false };
    }
    if (!verifiedActiveBind(candidate, thread)) continue;
    jobs.add(candidate.jobId);
  }
  return { available: true, executingJobCount: jobs.size };
}
