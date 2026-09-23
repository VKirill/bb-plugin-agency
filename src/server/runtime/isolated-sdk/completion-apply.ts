import { fail, ok, type DomainResult } from "../../../domain";
import type { DomainStore, ServiceContext } from "../../services";
import { uuidV5 } from "../launch/operation-ids.js";
import type { InternalRunStoreReads, RunAttempt, RunStore } from "../run-store/types.js";
import type { CompletionReading } from "./completion.js";

export type AppliedCompletion = CompletionReading & {
  jobState: string | null;
  reviewApplied: boolean;
  publishedHash: string | null;
  attemptState: string | null;
  attemptReviewApplied: boolean;
  attemptAcceptedApplied: boolean;
};

/**
 * Server-side review: idle + hash-verified current version → store Job review.
 * Assessment-only is not enough. Already-review is idempotent. No public flag.
 */
export function applyVerifiedReviewToStore(deps: {
  store: DomainStore;
  ctx: ServiceContext;
  jobId: string;
  launchId: string;
  reading: CompletionReading;
  publishedHash?: string | null;
}): DomainResult<AppliedCompletion> {
  const publishedHash = deps.publishedHash ?? null;
  const job = deps.store.getJob(deps.jobId);
  if (!job) return fail("not_found", `job ${deps.jobId} not found`);
  const base: AppliedCompletion = {
    ...deps.reading,
    jobState: job.state,
    reviewApplied: false,
    publishedHash,
    attemptState: null,
    attemptReviewApplied: false,
    attemptAcceptedApplied: false,
  };
  if (deps.reading.runSucceeded) {
    return fail("contract_incomplete", "Agency completion must not claim runSucceeded");
  }
  if (!deps.reading.mayEnterReview || !deps.reading.publishedVerified || !publishedHash) {
    return ok(base);
  }
  if (job.state === "review") {
    return ok({ ...base, jobState: "review" });
  }
  if (job.state !== "running") {
    return ok(base);
  }
  // The version returned for rework is not a hand-in; only a new hash is.
  if (deps.store.reworkBlocksReview(deps.jobId, publishedHash)) {
    return ok(base);
  }
  // A version without the employee's closing comment is not handed in yet: the reminder asks for it.
  if (deps.store.handInCommentMissing(deps.jobId)) {
    return ok(base);
  }
  const next = deps.store.transitionJob(deps.ctx, {
    // A job can go through review again after rework: one request per published version.
    requestId: uuidV5(deps.launchId, `agency.job.review:${publishedHash}`),
    jobId: deps.jobId,
    expectedRevision: job.revision,
    to: "review",
  });
  if (!next.ok) return next;
  if (next.value.state === "review") deps.store.resolveRework(deps.jobId);
  return ok({
    ...deps.reading,
    jobState: next.value.state,
    reviewApplied: next.value.state === "review",
    publishedHash,
    attemptState: null,
    attemptReviewApplied: false,
    attemptAcceptedApplied: false,
  });
}

export function canEnterAcceptedSucceeded(input: {
  attemptState: string;
  jobState: string | null;
  acceptedVerified: boolean;
  publishedVerified: boolean;
  publishedHash: string | null;
  attemptId: string;
  attemptJobId: string;
  jobId: string;
  attemptThreadId: string | null;
  attemptLaunchId: string | null;
  receiptAttemptId: string;
  receiptJobId: string;
  receiptThreadId: string | null;
  receiptLaunchId: string;
  launchId: string;
}): boolean {
  return (
    input.attemptState === "awaiting_review" &&
    input.jobState === "done" &&
    input.acceptedVerified === true &&
    input.publishedVerified === true &&
    Boolean(input.publishedHash) &&
    input.attemptJobId === input.jobId &&
    input.receiptJobId === input.jobId &&
    input.receiptAttemptId === input.attemptId &&
    Boolean(input.attemptThreadId) &&
    input.attemptThreadId === input.receiptThreadId &&
    Boolean(input.attemptLaunchId) &&
    input.attemptLaunchId === input.receiptLaunchId &&
    input.receiptLaunchId === input.launchId
  );
}

export function canEnterAwaitingReview(input: {
  attemptState: string;
  jobState: string | null;
  threadStatus: string | null;
  publishedVerified: boolean;
  acceptedVerified?: boolean;
  publishedHash: string | null;
}): boolean {
  return (
    input.attemptState === "running" &&
    (input.jobState === "review" || (input.jobState === "done" && input.acceptedVerified === true)) &&
    input.threadStatus === "idle" &&
    input.publishedVerified === true &&
    Boolean(input.publishedHash)
  );
}

export function applyAwaitingReviewToAttempt(deps: {
  runs: Pick<RunStore, "transitionAttempt">;
  reads: Pick<InternalRunStoreReads, "getAttempt" | "getLaunchReceipt">;
  ctx: ServiceContext;
  launchId: string;
  jobState: string | null;
  threadStatus: string | null;
  publishedVerified: boolean;
  acceptedVerified?: boolean;
  publishedHash: string | null;
}): DomainResult<{ attempt: RunAttempt | null; changed: boolean }> {
  const receipt = deps.reads.getLaunchReceipt(deps.ctx, deps.launchId);
  if (!receipt.ok) return ok({ attempt: null, changed: false });
  const loaded = deps.reads.getAttempt(deps.ctx, receipt.value.attemptId);
  if (!loaded.ok) return loaded;
  const attempt = loaded.value;
  if (attempt.state === "awaiting_review") {
    return ok({ attempt, changed: false });
  }
  if (
    !canEnterAwaitingReview({
      attemptState: attempt.state,
      jobState: deps.jobState,
      threadStatus: deps.threadStatus,
      publishedVerified: deps.publishedVerified,
      acceptedVerified: deps.acceptedVerified,
      publishedHash: deps.publishedHash,
    })
  ) {
    return ok({ attempt, changed: false });
  }
  const next = deps.runs.transitionAttempt(deps.ctx, {
    // The same attempt can return to work. Each hand-in needs its own CAS key;
    // a launch-wide key replays an earlier revision or conflicts forever.
    requestId: uuidV5(deps.launchId, `agency.attempt.awaiting_review:${attempt.revision}:${deps.publishedHash}`),
    attemptId: attempt.attemptId,
    expectedRevision: attempt.revision,
    to: "awaiting_review",
  });
  if (!next.ok) return next;
  return ok({ attempt: next.value, changed: next.value.state === "awaiting_review" });
}

export function applyAcceptedSuccessToAttempt(deps: {
  store: Pick<DomainStore, "getJob">;
  runs: Pick<RunStore, "transitionAttempt">;
  reads: Pick<InternalRunStoreReads, "getAttempt" | "getLaunchReceipt">;
  ctx: ServiceContext;
  jobId: string;
  launchId: string;
  acceptedVerified: boolean;
  publishedVerified: boolean;
  publishedHash: string | null;
}): DomainResult<{ attempt: RunAttempt | null; changed: boolean }> {
  const receipt = deps.reads.getLaunchReceipt(deps.ctx, deps.launchId);
  if (!receipt.ok) return ok({ attempt: null, changed: false });
  const loaded = deps.reads.getAttempt(deps.ctx, receipt.value.attemptId);
  if (!loaded.ok) return loaded;
  const attempt = loaded.value;
  if (attempt.state === "succeeded") {
    return ok({ attempt, changed: false });
  }
  const job = deps.store.getJob(deps.jobId);
  if (
    !canEnterAcceptedSucceeded({
      attemptState: attempt.state,
      jobState: job?.state ?? null,
      acceptedVerified: deps.acceptedVerified,
      publishedVerified: deps.publishedVerified,
      publishedHash: deps.publishedHash,
      attemptId: attempt.attemptId,
      attemptJobId: attempt.jobId,
      jobId: deps.jobId,
      attemptThreadId: attempt.threadId,
      attemptLaunchId: attempt.launchId,
      receiptAttemptId: receipt.value.attemptId,
      receiptJobId: receipt.value.jobId,
      receiptThreadId: receipt.value.threadId,
      receiptLaunchId: receipt.value.launchId,
      launchId: deps.launchId,
    })
  ) {
    return ok({ attempt, changed: false });
  }
  const next = deps.runs.transitionAttempt(deps.ctx, {
    requestId: uuidV5(deps.launchId, "agency.attempt.accepted_succeeded"),
    attemptId: attempt.attemptId,
    expectedRevision: attempt.revision,
    to: "succeeded",
  });
  if (!next.ok) return next;
  return ok({ attempt: next.value, changed: next.value.state === "succeeded" });
}

/** Attempt states a canceled job may leave behind while its thread is quiet. */
const CLOSABLE_ON_JOB_CANCEL = new Set(["running", "waiting_input", "awaiting_review", "unknown"]);

/**
 * A job canceled after its version was published (for example, replaced by a
 * rework subtask) keeps its attempt awaiting_review forever. Close it once the
 * thread is quiet; an active thread is stopped only by launch cancel.
 */
export function applyCanceledJobToAttempt(deps: {
  store: Pick<DomainStore, "getJob">;
  runs: Pick<RunStore, "transitionAttempt">;
  reads: Pick<InternalRunStoreReads, "getAttempt" | "getLaunchReceipt">;
  ctx: ServiceContext;
  jobId: string;
  launchId: string;
  threadStatus: string | null;
}): DomainResult<{ attempt: RunAttempt | null; changed: boolean }> {
  const job = deps.store.getJob(deps.jobId);
  if (!job || job.state !== "canceled") return ok({ attempt: null, changed: false });
  if (deps.threadStatus !== "idle" && deps.threadStatus !== "error") return ok({ attempt: null, changed: false });
  const receipt = deps.reads.getLaunchReceipt(deps.ctx, deps.launchId);
  if (!receipt.ok || receipt.value.jobId !== deps.jobId) return ok({ attempt: null, changed: false });
  const loaded = deps.reads.getAttempt(deps.ctx, receipt.value.attemptId);
  if (!loaded.ok) return loaded;
  const attempt = loaded.value;
  if (!CLOSABLE_ON_JOB_CANCEL.has(attempt.state)) return ok({ attempt, changed: false });
  const next = deps.runs.transitionAttempt(deps.ctx, {
    requestId: uuidV5(deps.launchId, "agency.attempt.job_canceled"),
    attemptId: attempt.attemptId,
    expectedRevision: attempt.revision,
    to: "canceled",
  });
  if (!next.ok) return next;
  return ok({ attempt: next.value, changed: next.value.state === "canceled" });
}

export function applyVerifiedCompletionLifecycle(deps: {
  store: DomainStore;
  runs: Pick<RunStore, "transitionAttempt">;
  reads: Pick<InternalRunStoreReads, "getAttempt" | "getLaunchReceipt">;
  ctx: ServiceContext;
  jobId: string;
  launchId: string;
  reading: CompletionReading;
  publishedHash?: string | null;
}): DomainResult<AppliedCompletion> {
  const reviewed = applyVerifiedReviewToStore({
    store: deps.store,
    ctx: deps.ctx,
    jobId: deps.jobId,
    launchId: deps.launchId,
    reading: deps.reading,
    publishedHash: deps.publishedHash,
  });
  if (!reviewed.ok) return reviewed;
  const marked = applyAwaitingReviewToAttempt({
    runs: deps.runs,
    reads: deps.reads,
    ctx: deps.ctx,
    launchId: deps.launchId,
    jobState: reviewed.value.jobState,
    threadStatus: reviewed.value.threadStatus,
    publishedVerified: reviewed.value.publishedVerified,
    acceptedVerified: reviewed.value.acceptedVerified,
    publishedHash: reviewed.value.publishedHash,
  });
  if (!marked.ok) return marked;
  const accepted = applyAcceptedSuccessToAttempt({
    store: deps.store,
    runs: deps.runs,
    reads: deps.reads,
    ctx: deps.ctx,
    jobId: deps.jobId,
    launchId: deps.launchId,
    acceptedVerified: reviewed.value.acceptedVerified,
    publishedVerified: reviewed.value.publishedVerified,
    publishedHash: reviewed.value.publishedHash,
  });
  if (!accepted.ok) return accepted;
  const closed = applyCanceledJobToAttempt({
    store: deps.store,
    runs: deps.runs,
    reads: deps.reads,
    ctx: deps.ctx,
    jobId: deps.jobId,
    launchId: deps.launchId,
    threadStatus: deps.reading.threadStatus,
  });
  if (!closed.ok) return closed;
  return ok({
    ...reviewed.value,
    attemptState: closed.value.attempt?.state ?? accepted.value.attempt?.state ?? marked.value.attempt?.state ?? null,
    attemptReviewApplied: marked.value.changed,
    attemptAcceptedApplied: accepted.value.changed,
  });
}
