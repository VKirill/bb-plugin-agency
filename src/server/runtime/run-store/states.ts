import { fail, ok, type DomainResult } from "../../../domain";
import {
  ACTIVE_RUN_ATTEMPT_STATES,
  type RunAttemptState,
} from "./types.js";

const TRANSITIONS: Readonly<Record<RunAttemptState, readonly RunAttemptState[]>> = {
  prepared: ["launching", "running", "canceled"],
  launching: ["running", "failed", "canceled", "unknown"],
  running: ["waiting_input", "awaiting_review", "succeeded", "failed", "canceled", "unknown"],
  waiting_input: ["running", "failed", "canceled", "unknown"],
  // running: the owner returned the version for rework in the same thread.
  awaiting_review: ["running", "succeeded", "failed", "canceled", "unknown"],
  unknown: ["running", "failed", "canceled", "succeeded"],
  succeeded: [],
  failed: [],
  canceled: [],
};

export function isActiveAttemptState(state: RunAttemptState): boolean {
  return (ACTIVE_RUN_ATTEMPT_STATES as readonly string[]).includes(state);
}

export function assertAttemptTransition(from: RunAttemptState, to: RunAttemptState): DomainResult<RunAttemptState> {
  if (from === to) {
    return fail("illegal_attempt_transition", `${from} → ${to} is not a change`);
  }
  if (from === "unknown" && to === "launching") {
    return fail("no_automatic_spawn_retry", "unknown must not retry spawn; resolve to failed, canceled, running, or succeeded");
  }
  if (from === "awaiting_review" && (to === "launching" || to === "prepared")) {
    return fail("no_automatic_spawn_retry", "awaiting_review must not spawn; rework continues the same thread (running)");
  }
  if (from === "failed" && to === "launching") {
    return fail("no_automatic_spawn_retry", "failed is terminal; a new attempt is required after inspection");
  }
  if (!TRANSITIONS[from].includes(to)) {
    return fail("illegal_attempt_transition", `${from} → ${to} is not allowed`);
  }
  return ok(to);
}

export function requiresConfirmedThread(to: RunAttemptState): boolean {
  return to === "running" || to === "waiting_input" || to === "awaiting_review" || to === "succeeded";
}
