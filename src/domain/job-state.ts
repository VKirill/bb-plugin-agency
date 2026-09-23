import type { JobDependency, JobState } from "../shared/contracts";
import { fail, ok, type DomainResult } from "./result";

export const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  backlog: ["queued", "blocked", "canceled"],
  queued: ["running", "blocked", "canceled"],
  running: ["review", "waiting_input", "blocked", "canceled"],
  waiting_input: ["running", "blocked", "canceled"],
  blocked: ["queued", "running", "waiting_input", "canceled"],
  // A stopped review worker may need a new provider; published versions remain intact.
  review: ["done", "running", "blocked", "canceled"],
  done: ["review"],
  canceled: [],
};

export type JobTransitionContext = {
  assignedAgentId?: string | null;
  bindingId?: string | null;
  brief?: string | null;
  acceptance?: string | null;
  threadBound?: boolean;
  publishedCurrentVersion?: boolean;
  acceptedCurrentVersion?: boolean;
  reviewPolicySatisfied?: boolean;
  reworkComment?: string | null;
  confirmedContinuation?: boolean;
  openQuestions?: boolean;
  openBlockers?: boolean;
};

function present(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

function assertReadyForQueue(context: JobTransitionContext): DomainResult<true> {
  if (!present(context.assignedAgentId) || !present(context.bindingId) || !present(context.brief) || !present(context.acceptance)) {
    return fail("missing_transition_guard", "queued/running require assignee, binding, brief and acceptance");
  }
  return ok(true);
}

export function assertJobTransition(
  from: JobState,
  to: JobState,
  context: JobTransitionContext = {},
): DomainResult<JobState> {
  if (!canTransitionJob(from, to)) {
    return fail("illegal_transition", `${from} → ${to} is not allowed`);
  }
  if (to === "queued" || to === "running") {
    const ready = assertReadyForQueue(context);
    if (!ready.ok) return ready;
  }
  if (to === "running" && context.threadBound !== true) {
    return fail("missing_transition_guard", "running requires a bound thread");
  }
  if (from === "waiting_input" && to === "running") {
    if (context.confirmedContinuation !== true) {
      return fail("missing_transition_guard", "return from waiting_input requires confirmed continuation");
    }
    if (context.openQuestions !== false || context.openBlockers !== false) {
      return fail("missing_transition_guard", "return from waiting_input requires no remaining questions or blockers");
    }
  }
  if (from === "review" && to === "running" && !present(context.reworkComment)) {
    return fail("missing_transition_guard", "return from review requires a comment");
  }
  if (to === "review" && context.publishedCurrentVersion !== true) {
    return fail("missing_transition_guard", "review requires a published current artifact version");
  }
  if (to === "done") {
    if (context.acceptedCurrentVersion !== true || context.reviewPolicySatisfied !== true) {
      return fail("missing_transition_guard", "done requires acceptance of the current version");
    }
  }
  return ok(to);
}

export function assertJobDependencies(edges: readonly JobDependency[]): DomainResult<readonly JobDependency[]> {
  for (const edge of edges) {
    if (edge.jobId === edge.dependsOnJobId) {
      return fail("dependency_self", `job ${edge.jobId} cannot depend on itself`);
    }
  }
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.jobId) ?? [];
    list.push(edge.dependsOnJobId);
    outgoing.set(edge.jobId, list);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (node: string): boolean => {
    if (visited.has(node)) return false;
    if (visiting.has(node)) return true;
    visiting.add(node);
    for (const next of outgoing.get(node) ?? []) {
      if (walk(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  for (const node of outgoing.keys()) {
    if (walk(node)) return fail("dependency_cycle", "job dependencies contain a cycle");
  }
  return ok(edges);
}
