import type { TrustedActor } from "../services/context";

export type JobCommentAttemptProof = {
  attemptNo: number;
  threadId: string | null;
};

export type JobCommentReceiptProof = {
  threadId: string | null;
};

export type ResolveJobCommentActorInput = {
  trustedCliThreadId: string | null | undefined;
  currentAttempt: JobCommentAttemptProof | null;
  receipt: JobCommentReceiptProof | null;
  snapshotAgentId: string | null;
};

function presentId(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

/** Highest attemptNo is the current attempt. Empty list → none. */
export function selectCurrentAttempt<T extends { attemptNo: number }>(attempts: readonly T[]): T | null {
  if (attempts.length === 0) return null;
  return attempts.reduce((best, row) => (row.attemptNo > best.attemptNo ? row : best));
}

/**
 * Assigned employee only when trusted CLI threadId equals the current attempt
 * threadId and the launch receipt threadId, and snapshot agent is present.
 * Payload actor is never consulted. No proof → host actor (user/system), never invented agent.
 */
export function resolveJobCommentActor(input: ResolveJobCommentActorInput, hostActor: TrustedActor): TrustedActor {
  const cliThread = presentId(input.trustedCliThreadId);
  const attemptThread = presentId(input.currentAttempt?.threadId);
  const receiptThread = presentId(input.receipt?.threadId);
  const snapshotAgentId = presentId(input.snapshotAgentId);
  if (!cliThread || !attemptThread || !receiptThread || !snapshotAgentId) return hostActor;
  if (cliThread !== attemptThread || cliThread !== receiptThread) return hostActor;
  return { kind: "agent", agentId: snapshotAgentId };
}
