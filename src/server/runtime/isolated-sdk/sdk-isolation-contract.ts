import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ReasoningEffort, ServiceTier } from "../../../shared/contracts/versions.js";

/**
 * Agency isolation contract. Independent of npm SDK spawn/list field names.
 * Portable package = these types + GET spawn-contract probe. Not a cast of ThreadSpawnArgs.
 */
export type IsolatedThreadSpawnArgs = {
  projectId: string;
  providerId: string;
  model: string;
  prompt: string;
  environment: {
    type: "host";
    hostId: string;
    workspace: { type: "unmanaged"; path: string };
  };
  isolatedSkillDelivery: true;
  skillIds: string[];
  visibility: "hidden";
  experimental_callerLaunchId: string;
  experimental_callerAttemptId: string;
  experimental_callerJobId?: string;
  /** Official `threads.spawn` field. Not `reasoningEffort`. */
  reasoningLevel?: ReasoningEffort;
  /** Official `threads.spawn` field: the provider's fast mode, only for providers with service tiers. */
  serviceTier?: ServiceTier;
  executionInputSources?: {
    reasoningLevel?: "explicit";
    serviceTier?: "explicit";
    permissionMode?: "explicit";
  };
  /** Set only by the owner's rule «Запуск без песочницы». */
  permissionMode?: "full";
  /** Plugins selected in the employee profile: instructions, agent tools and the bridge that serves them. */
  instructionPluginIds?: string[];
  dynamicToolNames?: string[];
  allowBridgeToolProxy?: boolean;
};

export type IsolatedThreadGetArgs = {
  threadId: string;
  include?: string;
};

export type IsolatedThreadListArgs = {
  experimental_callerLaunchId?: string;
  includeHidden?: boolean;
  projectId?: string;
};

export type OfficialThreadSpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
export type OfficialThreadListArgs = NonNullable<Parameters<BbPluginApi["sdk"]["threads"]["list"]>[0]>;

export type OfficialSpawnHasReasoningLevel = "reasoningLevel" extends keyof OfficialThreadSpawnArgs
  ? true
  : false;
export type OfficialSpawnHasCallerLaunch = "experimental_callerLaunchId" extends keyof OfficialThreadSpawnArgs
  ? true
  : false;
export type OfficialListHasCallerLaunch = "experimental_callerLaunchId" extends keyof OfficialThreadListArgs
  ? true
  : false;

/**
 * Compile pin 0.4.87-agy16.431: both true. Public npm 0.4.87 makes `true as never`.
 * Runtime spawn still requires GET /api/v1/system/experimental_thread-spawn-contract.
 */
export const OFFICIAL_SPAWN_HAS_REASONING_LEVEL: OfficialSpawnHasReasoningLevel =
  true as OfficialSpawnHasReasoningLevel extends false ? never : OfficialSpawnHasReasoningLevel;
export const OFFICIAL_SPAWN_HAS_CALLER_LAUNCH: OfficialSpawnHasCallerLaunch =
  true as OfficialSpawnHasCallerLaunch extends false ? never : OfficialSpawnHasCallerLaunch;
export const OFFICIAL_LIST_HAS_CALLER_LAUNCH: OfficialListHasCallerLaunch =
  true as OfficialListHasCallerLaunch extends false ? never : OfficialListHasCallerLaunch;

export const SDK_ISOLATION_BLOCKER =
  "typed spawn fields are present on compile pin 0.4.87-agy16.431; runtime spawn still requires actual GET /api/v1/system/experimental_thread-spawn-contract; engines and ordinary host 0.4.87 are not readiness";

export function officialSdkAllowsIsolatedSpawn(): boolean {
  return Boolean(OFFICIAL_SPAWN_HAS_CALLER_LAUNCH && OFFICIAL_LIST_HAS_CALLER_LAUNCH);
}
