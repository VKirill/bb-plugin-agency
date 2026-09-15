import type {
  LaunchContract,
  ReconcileOutcome,
  SpawnOutcome,
  SpawnPort,
  ThreadVerifyOutcome,
  ThreadVerifyPort,
} from "./ports.js";
import { DEPLOYED_CORE_ISOLATED_SPAWN_FIELDS } from "./readiness.js";

/**
 * Installed plugin-sdk ThreadSpawnArgs has no isolatedSkillDelivery/skillIds.
 * Do not cast spawn args or call threads.spawn until a live core probe proves those fields.
 */
export function deployedSdkHasIsolatedSpawnFields(): false {
  return DEPLOYED_CORE_ISOLATED_SPAWN_FIELDS;
}

export function unsupportedSdkSpawnPort(): SpawnPort {
  return {
    supported: false,
    async spawn(_request: LaunchContract): Promise<SpawnOutcome> {
      return {
        kind: "rejected",
        code: "sdk_isolated_fields_unsupported",
        message: "deployed SDK/core cannot express isolated skill/MCP fields; spawn is not called",
      };
    },
    async reconcileByLaunchId(_launchId: string): Promise<ReconcileOutcome> {
      return { kind: "unsupported" };
    },
  };
}

/** Deployed SDK has no launchId/thread lookup. Do not invent confirmation. */
export function unsupportedSdkThreadVerifyPort(): ThreadVerifyPort {
  return {
    supported: false,
    async verifyConfirmedThread(): Promise<ThreadVerifyOutcome> {
      return {
        kind: "unavailable",
        code: "sdk_thread_lookup_unsupported",
        message:
          "deployed SDK cannot prove launchId or thread identity against provider/server metadata; recovery stays pending",
      };
    },
  };
}
