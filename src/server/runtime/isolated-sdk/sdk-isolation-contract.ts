import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ReasoningEffort, ServiceTier } from "../../../shared/contracts/versions.js";

/** This plugin's originPluginId on threads.spawn. */
export const AGENCY_PLUGIN_ID = "agency";

/**
 * Native BB 0.43 spawn. Only fields that exist on public createThread
 * (visibility, origin plugin, pluginMetadata): 0.43 rejects unknown keys.
 * Launch identity is pluginMetadata + the Agency database; skills travel in the prompt.
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
  origin: "plugin";
  originPluginId: typeof AGENCY_PLUGIN_ID;
  visibility: "hidden";
  pluginMetadata: {
    agencyLaunchId: string;
    agencyAttemptId: string;
    agencyJobId: string;
  };
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
};

export type IsolatedThreadGetArgs = {
  threadId: string;
  include?: string;
};

export type IsolatedThreadListArgs = {
  includeHidden?: boolean;
  projectId?: string;
  originPluginId?: string;
};

export type OfficialThreadSpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
export type OfficialThreadListArgs = NonNullable<Parameters<BbPluginApi["sdk"]["threads"]["list"]>[0]>;

export type OfficialSpawnHasReasoningLevel = "reasoningLevel" extends keyof OfficialThreadSpawnArgs
  ? true
  : false;

/** Compile pin: the public SDK's `threads.spawn` carries `reasoningLevel`; otherwise this is `true as never`. */
export const OFFICIAL_SPAWN_HAS_REASONING_LEVEL: OfficialSpawnHasReasoningLevel =
  true as OfficialSpawnHasReasoningLevel extends false ? never : OfficialSpawnHasReasoningLevel;
