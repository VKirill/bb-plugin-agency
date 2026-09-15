import type { Job } from "../prototype/data";

/** Inbox «Нужно ваше решение»: review, blocked, and durable waiting_input. */
export function inboxNeedsDecision(job: Pick<Job, "state" | "sourceState">): boolean {
  return (
    job.state === "review" ||
    job.state === "blocked" ||
    job.state === "waiting_input" ||
    job.sourceState === "waiting_input"
  );
}

export function inboxDecisionJobs(jobs: readonly Job[]): Job[] {
  return jobs.filter(inboxNeedsDecision);
}
