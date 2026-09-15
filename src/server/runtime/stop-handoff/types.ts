import type { HandoffPackage, InputArtifactRef } from "../context-snapshot/types.js";

/** SDK `threadStatusSchema` — there is no `stopped`. */
export const OFFICIAL_THREAD_STATUSES = [
  "active",
  "error",
  "idle",
  "pending",
  "starting",
  "stopping",
] as const;

export type OfficialThreadStatus = (typeof OFFICIAL_THREAD_STATUSES)[number];

export const OCCUPYING_THREAD_STATUSES = ["starting", "active"] as const;
export type OccupyingThreadStatus = (typeof OCCUPYING_THREAD_STATUSES)[number];

export const STOP_HANDOFF_KIND = "agency.stopHandoff";

export const STOP_PHASES = ["intent", "ack_recorded", "reconciling", "confirmed", "failed"] as const;
export type StopPhase = (typeof STOP_PHASES)[number];

export const SPAWN_BLOCKING_PHASES = ["intent", "ack_recorded", "reconciling", "failed"] as const;
export type SpawnBlockingPhase = (typeof SPAWN_BLOCKING_PHASES)[number];

export type StopAckEvidence = {
  ok: true;
};

export type ThreadGetEvidence = {
  threadId: string;
  status: OfficialThreadStatus | null;
};

export type ListRunningEvidence = {
  occupyingStatuses: readonly OccupyingThreadStatus[];
  threadPresent: boolean;
};

/** The only confirmation bundle this module accepts. Idle alone is not this object. */
export type SupportedStopEvidence = {
  kind: "threads.stop+get+listRunning";
  stopAck: StopAckEvidence | null;
  get: ThreadGetEvidence | null;
  listRunning: ListRunningEvidence | null;
};

export type StopIntentRecord = {
  intentId: string;
  requestId: string;
  jobId: string;
  attemptId: string;
  launchId: string;
  threadId: string;
  phase: StopPhase;
  reason: string | null;
  evidence: SupportedStopEvidence;
  handoff: HandoffPackage | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RequestStopInput = {
  requestId: string;
  jobId: string;
  attemptId: string;
  expectedAttemptRevision: number;
  launchId: string;
  threadId: string;
  reason?: string | null;
};

export type ReconcileStopInput = {
  requestId: string;
};

export type CompileHandoffInput = {
  requestId: string;
  acceptedArtifacts: readonly InputArtifactRef[];
  openQuestions: readonly string[];
  returnReason: string | null;
};

export type AssertCanSpawnInput = {
  jobId: string;
};

/** Durable phase `confirmed` is this observation — not writer-dead proof. */
export type ObservedStopClaim = {
  kind: "observed_stop";
  jobId: string;
  attemptId: string;
  launchId: string;
  threadId: string;
  requestId: string;
};

export const WRITER_QUIESCENCE_VERDICTS = ["confirmed", "unavailable", "still_active"] as const;
export type WriterQuiescenceVerdict = (typeof WRITER_QUIESCENCE_VERDICTS)[number];

/** Only this result authorises a new writer. Observed stop alone is not this type. */
export type SafeReplacement = {
  kind: "safe_replacement";
  observedStop: ObservedStopClaim;
  quiescence: "confirmed";
};
