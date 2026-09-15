import { fail, ok, type DomainResult } from "../../../domain";
import {
  PUBLIC_SDK_CALLER_FIELDS,
  type IsolatedCapabilityHandshake,
  unavailableHandshake,
} from "../prepare-run";

const REQUIRED_PUBLIC_KEYS = [
  PUBLIC_SDK_CALLER_FIELDS.experimental_callerLaunchId,
  PUBLIC_SDK_CALLER_FIELDS.experimental_callerAttemptId,
  PUBLIC_SDK_CALLER_FIELDS.experimental_callerJobId,
  "isolatedSkillDelivery",
  "skillIds",
] as const;

/**
 * Runtime probe of a spawn-args shape. Types-only / instance name are not input.
 * Returns unavailable until regenerated experimental_ keys exist on the object.
 */
export function probeSpawnArgsShape(sample: object): DomainResult<IsolatedCapabilityHandshake> {
  const missing = REQUIRED_PUBLIC_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(sample, key));
  if (missing.length > 0) {
    return fail(
      "typed_capability_unproven",
      `runtime spawn shape missing ${missing.join(", ")}; no casts and no types-only readiness`,
    );
  }
  return ok({
    protocol: "agency-isolated-capability-v1",
    capabilities: {
      isolatedSkillDelivery: true,
      skillIds: true,
      originPluginId: true,
      experimental_callerLaunchId: true,
      experimental_callerAttemptId: true,
      experimental_callerJobId: true,
      uniqueLookupFork: true,
      forkDoesNotInheritIdentity: true,
      threadVisibilityHidden: true,
    },
  });
}

export function isolatedHandshakeUnavailable(): IsolatedCapabilityHandshake {
  return unavailableHandshake();
}
