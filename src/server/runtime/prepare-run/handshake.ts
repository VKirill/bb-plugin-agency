import { fail, ok, type DomainResult } from "../../../domain";
import type { CapabilityReadiness } from "../launch/ports.js";
import { DEFAULT_CAPABILITY_UNAVAILABLE } from "../launch/readiness.js";
import type { ExperimentalIsolatedCapability } from "./experimental-names.js";

export const HANDSHAKE_PROTOCOL = "agency-isolated-capability-v1" as const;

export type IsolatedCapabilityHandshake = {
  protocol: typeof HANDSHAKE_PROTOCOL;
  capabilities: ExperimentalIsolatedCapability;
};

export type IsolatedCapabilityHandshakePort = {
  /**
   * Runtime probe only. Implementations must not infer readiness from TypeScript
   * types, cwd, or instance/display name (including isolated 0431).
   */
  probe(): Promise<DomainResult<IsolatedCapabilityHandshake>>;
};

const ALL_FALSE: ExperimentalIsolatedCapability = {
  isolatedSkillDelivery: false,
  skillIds: false,
  originPluginId: false,
  experimental_callerLaunchId: false,
  experimental_callerAttemptId: false,
  experimental_callerJobId: false,
  uniqueLookupFork: false,
  forkDoesNotInheritIdentity: false,
  threadVisibilityHidden: false,
};

export function unavailableHandshake(): IsolatedCapabilityHandshake {
  return { protocol: HANDSHAKE_PROTOCOL, capabilities: { ...ALL_FALSE } };
}

export function unavailableHandshakePort(): IsolatedCapabilityHandshakePort {
  return {
    async probe() {
      return ok(unavailableHandshake());
    },
  };
}

export function isHandshakeReady(handshake: IsolatedCapabilityHandshake): boolean {
  if (handshake.protocol !== HANDSHAKE_PROTOCOL) return false;
  return Object.values(handshake.capabilities).every((bit) => bit === true);
}

/** Maps a proven runtime handshake. Types/instance name never enter this function. */
export function readinessFromHandshake(handshake: IsolatedCapabilityHandshake): CapabilityReadiness {
  if (!isHandshakeReady(handshake)) {
    return {
      ...DEFAULT_CAPABILITY_UNAVAILABLE,
      reason:
        "typed runtime capability handshake is not proven; TypeScript types and instance names are not evidence",
    };
  }
  return {
    executionAvailable: true,
    isolationReady: true,
    isolatedSpawnFields: true,
    reason:
      "GET experimental_thread-spawn-contract fingerprint confirms loaded core schemas; not OS isolation or security proof",
  };
}

export function parseHandshakePayload(value: unknown): DomainResult<IsolatedCapabilityHandshake> {
  if (!value || typeof value !== "object") {
    return fail("invalid_handshake", "handshake payload must be an object from a runtime probe");
  }
  const record = value as Record<string, unknown>;
  if (record.protocol !== HANDSHAKE_PROTOCOL) {
    return fail("invalid_handshake", "handshake protocol is not agency-isolated-capability-v1");
  }
  const caps = record.capabilities;
  if (!caps || typeof caps !== "object") {
    return fail("invalid_handshake", "handshake.capabilities is required");
  }
  const raw = caps as Record<string, unknown>;
  const keys: (keyof ExperimentalIsolatedCapability)[] = [
    "isolatedSkillDelivery",
    "skillIds",
    "originPluginId",
    "experimental_callerLaunchId",
    "experimental_callerAttemptId",
    "experimental_callerJobId",
    "uniqueLookupFork",
    "forkDoesNotInheritIdentity",
    "threadVisibilityHidden",
  ];
  const capabilities: ExperimentalIsolatedCapability = { ...ALL_FALSE };
  for (const key of keys) {
    if (typeof raw[key] !== "boolean") {
      return fail("invalid_handshake", `handshake.capabilities.${key} must be a boolean from runtime`);
    }
    capabilities[key] = raw[key];
  }
  return ok({ protocol: HANDSHAKE_PROTOCOL, capabilities });
}
