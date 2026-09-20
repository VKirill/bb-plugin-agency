import type { DomainResult } from "../../../domain";
import type { ServiceContext } from "../../services/context.js";
import type { ContextSnapshot } from "../context-snapshot/types.js";
import type {
  LaunchReceipt,
  PersistedContextSnapshot,
  ReserveAttestation,
  RunAttempt,
  TransitionRunAttemptInput,
} from "../run-store/types.js";

export type LaunchContract = {
  snapshotId: string;
  digest: string;
  attemptId: string;
  launchId: string;
  providerId: string;
  model: string;
  skillIds: readonly string[];
  mcpIds: readonly string[];
  hostId: string;
  canonicalRoot: string;
  environmentId: string;
  bbProjectId: string;
};

export type SpawnOutcome =
  | { kind: "confirmed"; threadId: string }
  | { kind: "rejected"; code: string; message: string }
  | { kind: "canceled"; code: string; message: string; threadId?: string }
  | { kind: "unknown"; code: string; message: string; threadId?: string };

export type ReconcileOutcome = SpawnOutcome | { kind: "unsupported" };

export type SpawnPort = {
  readonly supported: boolean;
  spawn(request: LaunchContract): Promise<SpawnOutcome>;
  reconcileByLaunchId?(launchId: string): Promise<ReconcileOutcome>;
  cancelThread?(threadId: string): Promise<{ ok: true } | { ok: false; unsupported: true }>;
};

/** Hint from a typed/internal receipt. Not authority for bind or Job.running. */
export type ConfirmedThreadClaim = {
  launchId: string;
  attemptId: string;
  threadId: string | null;
  jobId: string;
  snapshotId: string;
  digest: string;
};

export type VerifiedThreadIdentity = {
  threadId: string;
  launchId: string;
  attemptId: string;
  hostId: string;
  environmentId: string;
  canonicalRoot: string;
  bbProjectId: string;
  providerId: string;
};

export type ThreadVerifyOutcome =
  | { kind: "confirmed"; identity: VerifiedThreadIdentity }
  | { kind: "rejected"; code: string; message: string }
  | { kind: "unavailable"; code: string; message: string };

export type ThreadVerifyPort = {
  readonly supported: boolean;
  verifyConfirmedThread(
    receipt: ConfirmedThreadClaim,
    storedSnapshot: ContextSnapshot,
  ): Promise<ThreadVerifyOutcome>;
};

export type LiveIdentityMatch = {
  hostId: string;
  environmentId: string;
  canonicalRoot: string;
  bbProjectId: string;
};

export type LiveIdentityPort = {
  verify(
    ctx: ServiceContext,
    snapshot: ContextSnapshot,
    claimedBbProjectId: string | undefined,
    attestation: ReserveAttestation,
  ): DomainResult<LiveIdentityMatch>;
};

export type CapabilityReadiness = {
  executionAvailable: boolean;
  isolationReady: boolean;
  reason: string;
};

export type ReadinessPort = {
  assess(snapshot: ContextSnapshot): CapabilityReadiness;
};

export type AttemptStorePort = {
  getSnapshot(ctx: ServiceContext, snapshotId: string): DomainResult<PersistedContextSnapshot>;
  getAttempt(ctx: ServiceContext, attemptId: string): DomainResult<RunAttempt>;
  transition(ctx: ServiceContext, input: TransitionRunAttemptInput): DomainResult<RunAttempt>;
  putReceipt(ctx: ServiceContext, receipt: LaunchReceiptDraft): DomainResult<LaunchReceipt>;
  getReceipt(ctx: ServiceContext, launchId: string): DomainResult<LaunchReceipt>;
  getReceiptByAttempt(ctx: ServiceContext, attemptId: string): DomainResult<LaunchReceipt>;
};

export type LaunchReceiptDraft = Omit<LaunchReceipt, "createdAt" | "updatedAt">;

export type ConfirmedJobBind = {
  jobId: string;
  attemptId: string;
  threadId: string;
  launchId: string;
};

export type JobRunningPort = {
  onConfirmedBind(ctx: ServiceContext, bind: ConfirmedJobBind): Promise<DomainResult<true>>;
};

export type LaunchPorts = {
  store: AttemptStorePort;
  liveIdentity: LiveIdentityPort;
  readiness: ReadinessPort;
  spawn: SpawnPort;
  threadVerify: ThreadVerifyPort;
  jobRunning: JobRunningPort;
};
