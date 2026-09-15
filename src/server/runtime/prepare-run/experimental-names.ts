/** Core worker that owns caller identity + unique lookup/fork. */
export const CORE_CALLER_WORKER_THREAD = "thr_vkwz27paec" as const;

/**
 * Public SDK surfaces (root decision): every new public field is experimental_*.
 * Internal launchContract.launchId is unchanged and is not a public spawn key.
 */
export const PUBLIC_SDK_CALLER_FIELDS = {
  experimental_callerLaunchId: "experimental_callerLaunchId",
  experimental_callerAttemptId: "experimental_callerAttemptId",
  experimental_callerJobId: "experimental_callerJobId",
} as const;

export const EXPERIMENTAL_ISOLATED_NAMES = {
  isolatedSkillDelivery: "isolatedSkillDelivery",
  skillIds: "skillIds",
  originPluginId: "originPluginId",
  experimental_callerLaunchId: "experimental_callerLaunchId",
  experimental_callerAttemptId: "experimental_callerAttemptId",
  experimental_callerJobId: "experimental_callerJobId",
  uniqueLookupFork: "uniqueLookupFork",
  forkDoesNotInheritIdentity: "forkDoesNotInheritIdentity",
  threadVisibility: "visibility",
  threadVisibilityValue: "hidden",
  /** Internal coordinator id. Not a public SDK spawn field. */
  internalLaunchId: "launchId",
} as const;

export type ExperimentalIsolatedCapability = {
  isolatedSkillDelivery: boolean;
  skillIds: boolean;
  originPluginId: boolean;
  experimental_callerLaunchId: boolean;
  experimental_callerAttemptId: boolean;
  experimental_callerJobId: boolean;
  uniqueLookupFork: boolean;
  forkDoesNotInheritIdentity: boolean;
  threadVisibilityHidden: boolean;
};
