import type { DomainResult } from "../../../domain";
import type { ContextSnapshot } from "../context-snapshot/types.js";
import type { ServiceContext } from "../../services/context.js";

/** Persisted names; docs data-model: prepared=preparing, launching=starting, unknown=reconciling. */
export const RUN_ATTEMPT_STATES = [
  "prepared",
  "launching",
  "running",
  "waiting_input",
  "awaiting_review",
  "succeeded",
  "failed",
  "canceled",
  "unknown",
] as const;

export type RunAttemptState = (typeof RUN_ATTEMPT_STATES)[number];

export const ACTIVE_RUN_ATTEMPT_STATES = [
  "prepared",
  "launching",
  "running",
  "waiting_input",
  "awaiting_review",
  "unknown",
] as const satisfies readonly RunAttemptState[];

export type ActiveRunAttemptState = (typeof ACTIVE_RUN_ATTEMPT_STATES)[number];

export const TERMINAL_RUN_ATTEMPT_STATES = ["succeeded", "failed", "canceled"] as const satisfies readonly RunAttemptState[];

export type PersistedContextSnapshot = {
  snapshotId: string;
  jobId: string;
  digest: string;
  snapshot: ContextSnapshot;
  createdAt: string;
};

export type RunAttempt = {
  attemptId: string;
  jobId: string;
  attemptNo: number;
  snapshotId: string;
  digest: string;
  threadId: string | null;
  launchId: string | null;
  state: RunAttemptState;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type ReserveAttestation = {
  accessVerified: true;
  revisionsVerified: true;
  expectedJobRevision: number;
  expectedBindingRevision: number;
};

export type ReservePreparedRunInput = {
  requestId: string;
  snapshot: ContextSnapshot;
  attestation: ReserveAttestation;
  claimedBbProjectId?: string;
};

export type ReservedPreparedRun = {
  snapshotId: string;
  digest: string;
  attempt: RunAttempt;
};

export type LaunchReceiptSpawnKind = "confirmed" | "rejected" | "canceled" | "unknown";
export type LaunchReceiptJobBindState = "pending" | "applied" | "failed" | "needs_repair";

export type LaunchReceipt = {
  launchId: string;
  attemptId: string;
  jobId: string;
  snapshotId: string;
  digest: string;
  threadId: string | null;
  spawnKind: LaunchReceiptSpawnKind;
  persistErrorCode: string | null;
  persistErrorMessage: string | null;
  jobBindState: LaunchReceiptJobBindState;
  needsReconciliation: boolean;
  parentRequestId: string;
  createdAt: string;
  updatedAt: string;
};

export type RecordLaunchReceiptInput = {
  requestId: string;
  claimedBbProjectId?: string;
  receipt: Omit<LaunchReceipt, "createdAt" | "updatedAt">;
};

export type TransitionRunAttemptInput = {
  requestId: string;
  attemptId: string;
  expectedRevision: number;
  to: RunAttemptState;
  threadId?: string | null;
  launchId?: string | null;
  claimedBbProjectId?: string;
};

export type RunStore = {
  reservePreparedRun(ctx: ServiceContext, input: ReservePreparedRunInput): DomainResult<ReservedPreparedRun>;
  transitionAttempt(ctx: ServiceContext, input: TransitionRunAttemptInput): DomainResult<RunAttempt>;
  recordLaunchReceipt(ctx: ServiceContext, input: RecordLaunchReceiptInput): DomainResult<LaunchReceipt>;
};

/**
 * Internal-only reads. Not a register/RPC/CLI surface.
 * Future public export must keep ServiceContext scope.
 */
export type InternalRunStoreReads = {
  getSnapshot(ctx: ServiceContext, snapshotId: string): DomainResult<PersistedContextSnapshot>;
  getAttempt(ctx: ServiceContext, attemptId: string): DomainResult<RunAttempt>;
  listAttempts(ctx: ServiceContext, jobId: string): DomainResult<readonly RunAttempt[]>;
  getLaunchReceipt(ctx: ServiceContext, launchId: string): DomainResult<LaunchReceipt>;
  getLaunchReceiptByAttempt(ctx: ServiceContext, attemptId: string): DomainResult<LaunchReceipt>;
};
