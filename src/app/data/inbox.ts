import type { Job } from "../prototype/data";

/**
 * Inbox «Нужно ваше решение»: only waits that the customer alone can end.
 * - waiting_input: the line lacks raw material only the customer has.
 * - blocked root: the escalation reached the top; nobody above the lead but the customer.
 * Review is the conveyor. A blocked subtask is the lead's problem (parent wake), not the customer's.
 */
export function inboxNeedsDecision(job: Pick<Job, "state" | "sourceState" | "parentId">): boolean {
  if (job.state === "waiting_input" || job.sourceState === "waiting_input") return true;
  return job.state === "blocked" && !job.parentId;
}

export function inboxDecisionJobs(jobs: readonly Job[]): Job[] {
  return jobs.filter(inboxNeedsDecision);
}
