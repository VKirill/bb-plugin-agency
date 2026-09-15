import {
  OCCUPYING_THREAD_STATUSES,
  OFFICIAL_THREAD_STATUSES,
  SPAWN_BLOCKING_PHASES,
  STOP_PHASES,
  type OfficialThreadStatus,
  type SpawnBlockingPhase,
  type StopPhase,
  type SupportedStopEvidence,
} from "./types.js";

export function isOfficialThreadStatus(value: unknown): value is OfficialThreadStatus {
  return (
    value === "active" ||
    value === "error" ||
    value === "idle" ||
    value === "pending" ||
    value === "starting" ||
    value === "stopping"
  );
}

export function isStopPhase(value: unknown): value is StopPhase {
  return (
    value === "intent" ||
    value === "ack_recorded" ||
    value === "reconciling" ||
    value === "confirmed" ||
    value === "failed"
  );
}

export function isSpawnBlockingPhase(phase: StopPhase): phase is SpawnBlockingPhase {
  return (
    phase === "intent" ||
    phase === "ack_recorded" ||
    phase === "reconciling" ||
    phase === "failed"
  );
}

export function emptyEvidence(): SupportedStopEvidence {
  return {
    kind: "threads.stop+get+listRunning",
    stopAck: null,
    get: null,
    listRunning: null,
  };
}

export function occupyingStatusList(): readonly ["starting", "active"] {
  return OCCUPYING_THREAD_STATUSES;
}

/**
 * Idle / missing listRunning / stop ack alone never confirm.
 * Confirmed only with the supported triple after an acknowledged stop.
 */
export function evaluateEvidence(evidence: SupportedStopEvidence): {
  phase: Exclude<StopPhase, "failed">;
  detail: string;
} {
  if (evidence.stopAck === null || evidence.stopAck.ok !== true) {
    return { phase: "intent", detail: "threads.stop acknowledgement is missing; idle is not stop proof" };
  }
  if (evidence.get === null) {
    return { phase: "ack_recorded", detail: "threads.get evidence is missing after stop ack" };
  }
  if (evidence.get.status === null) {
    return { phase: "reconciling", detail: "threads.get returned no status; cannot treat as stopped" };
  }
  if (evidence.listRunning === null) {
    return {
      phase: "reconciling",
      detail: "threads.listRunning evidence is required; idle get is not stop proof",
    };
  }
  const status = evidence.get.status;
  if (status === "starting" || status === "active") {
    return { phase: "reconciling", detail: `thread still occupying capacity (${status})` };
  }
  if (status === "stopping" || status === "pending") {
    return { phase: "reconciling", detail: `thread status ${status} is not confirmed stop` };
  }
  if (evidence.listRunning.threadPresent) {
    return { phase: "reconciling", detail: "thread still listed in threads.listRunning" };
  }
  if (status === "idle" || status === "error") {
    return {
      phase: "confirmed",
      detail: "observed stop (ack + get idle|error + absent listRunning); not writer-dead proof",
    };
  }
  return { phase: "reconciling", detail: `unhandled official status ${status}` };
}

export function officialStatusSet(): readonly OfficialThreadStatus[] {
  return OFFICIAL_THREAD_STATUSES;
}

export function stopPhaseSet(): readonly StopPhase[] {
  return STOP_PHASES;
}

export function spawnBlockingPhaseSet(): readonly SpawnBlockingPhase[] {
  return SPAWN_BLOCKING_PHASES;
}
