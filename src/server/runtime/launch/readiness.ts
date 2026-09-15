import type { ContextSnapshot } from "../context-snapshot/types.js";
import type { CapabilityReadiness, ReadinessPort } from "./ports.js";

/** Deployed BB 0.43.1 / SDK 0.4.87: isolated spawn fields are not on ThreadSpawnArgs. */
export const DEPLOYED_CORE_ISOLATED_SPAWN_FIELDS = false;

export const DEFAULT_CAPABILITY_UNAVAILABLE: CapabilityReadiness = {
  executionAvailable: false,
  isolationReady: false,
  isolatedSpawnFields: DEPLOYED_CORE_ISOLATED_SPAWN_FIELDS,
  reason: "Isolation and isolated spawn fields are not proven on the deployed core; execution stays unavailable",
};

export function isReadyToSpawn(readiness: CapabilityReadiness): boolean {
  return readiness.executionAvailable && readiness.isolationReady && readiness.isolatedSpawnFields;
}

export function unavailableReadinessPort(): ReadinessPort {
  return {
    assess(_snapshot: ContextSnapshot): CapabilityReadiness {
      return DEFAULT_CAPABILITY_UNAVAILABLE;
    },
  };
}
