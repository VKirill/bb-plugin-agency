import type { HandoffPackage, InputArtifactRef } from "../context-snapshot/types.js";
import { emptyEvidence, isOfficialThreadStatus, isStopPhase } from "./evidence.js";
import type {
  ListRunningEvidence,
  OfficialThreadStatus,
  StopAckEvidence,
  StopIntentRecord,
  SupportedStopEvidence,
  ThreadGetEvidence,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseStopAck(value: unknown): StopAckEvidence | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return null;
  return value.ok === true ? { ok: true } : null;
}

function parseGet(value: unknown): ThreadGetEvidence | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return null;
  const threadId = readString(value.threadId);
  if (!threadId) return null;
  if (value.status === null) return { threadId, status: null };
  if (!isOfficialThreadStatus(value.status)) return null;
  const status: OfficialThreadStatus = value.status;
  return { threadId, status };
}

function parseListRunning(value: unknown): ListRunningEvidence | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return null;
  const occupying = value.occupyingStatuses;
  if (!Array.isArray(occupying) || occupying.length !== 2) return null;
  if (occupying[0] !== "starting" || occupying[1] !== "active") return null;
  if (typeof value.threadPresent !== "boolean") return null;
  return {
    occupyingStatuses: ["starting", "active"],
    threadPresent: value.threadPresent,
  };
}

function parseEvidence(value: unknown): SupportedStopEvidence {
  if (!isRecord(value) || value.kind !== "threads.stop+get+listRunning") {
    return emptyEvidence();
  }
  return {
    kind: "threads.stop+get+listRunning",
    stopAck: parseStopAck(value.stopAck),
    get: parseGet(value.get),
    listRunning: parseListRunning(value.listRunning),
  };
}

function parseArtifact(value: unknown): InputArtifactRef | undefined {
  if (!isRecord(value)) return undefined;
  const artifactId = readString(value.artifactId);
  const hash = readString(value.hash);
  const jobId = readString(value.jobId);
  const hostId = readString(value.hostId);
  const relativePath = readString(value.relativePath);
  if (!artifactId || !hash || !jobId || !hostId || relativePath === undefined) return undefined;
  if (typeof value.version !== "number" || !Number.isInteger(value.version)) return undefined;
  return {
    artifactId,
    version: value.version,
    hash,
    jobId,
    hostId,
    relativePath,
  };
}

function parseHandoff(value: unknown): HandoffPackage | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return null;
  const priorRunAttemptId = readString(value.priorRunAttemptId);
  const fromSnapshotDigest = readString(value.fromSnapshotDigest);
  const hash = readString(value.hash);
  if (!priorRunAttemptId || !fromSnapshotDigest || !hash) return null;
  if (!Array.isArray(value.acceptedArtifacts) || !Array.isArray(value.openQuestions)) return null;
  const acceptedArtifacts: InputArtifactRef[] = [];
  for (const item of value.acceptedArtifacts) {
    const parsed = parseArtifact(item);
    if (!parsed) return null;
    acceptedArtifacts.push(parsed);
  }
  const openQuestions: string[] = [];
  for (const item of value.openQuestions) {
    if (typeof item !== "string") return null;
    openQuestions.push(item);
  }
  let returnReason: string | null;
  if (value.returnReason === null) {
    returnReason = null;
  } else {
    const parsedReason = readString(value.returnReason);
    if (parsedReason === undefined) return null;
    returnReason = parsedReason;
  }
  return {
    priorRunAttemptId,
    fromSnapshotDigest,
    acceptedArtifacts,
    openQuestions,
    returnReason,
    hash,
  };
}

export function parseStopIntentRecord(value: unknown): StopIntentRecord | undefined {
  if (!isRecord(value)) return undefined;
  const intentId = readString(value.intentId);
  const requestId = readString(value.requestId);
  const jobId = readString(value.jobId);
  const attemptId = readString(value.attemptId);
  const launchId = readString(value.launchId);
  const threadId = readString(value.threadId);
  const createdAt = readString(value.createdAt);
  const updatedAt = readString(value.updatedAt);
  if (!intentId || !requestId || !jobId || !attemptId || !launchId || !threadId || !createdAt || !updatedAt) {
    return undefined;
  }
  if (!isStopPhase(value.phase)) return undefined;
  const reason = value.reason === null ? null : readString(value.reason) ?? null;
  const failureCode = value.failureCode === null || value.failureCode === undefined
    ? null
    : readString(value.failureCode) ?? null;
  return {
    intentId,
    requestId,
    jobId,
    attemptId,
    launchId,
    threadId,
    phase: value.phase,
    reason,
    evidence: parseEvidence(value.evidence),
    handoff: parseHandoff(value.handoff),
    failureCode,
    createdAt,
    updatedAt,
  };
}
