import type { ContextSnapshot } from "../context-snapshot/types.js";
import type { CapabilityReadiness, ReadinessPort } from "./ports.js";

/** Production readiness: public `threads.spawn` of a hidden plugin thread with pluginMetadata. */
export const NATIVE_SPAWN_READINESS: CapabilityReadiness = {
  executionAvailable: true,
  isolationReady: true,
  reason: "native threads.spawn (origin plugin, hidden visibility, pluginMetadata)",
};

export const DEFAULT_CAPABILITY_UNAVAILABLE: CapabilityReadiness = {
  executionAvailable: false,
  isolationReady: false,
  reason: "No spawn port is wired; execution stays unavailable",
};

export function isReadyToSpawn(readiness: CapabilityReadiness): boolean {
  return readiness.executionAvailable;
}

export function unavailableReadinessPort(): ReadinessPort {
  return {
    assess(_snapshot: ContextSnapshot): CapabilityReadiness {
      return DEFAULT_CAPABILITY_UNAVAILABLE;
    },
  };
}
