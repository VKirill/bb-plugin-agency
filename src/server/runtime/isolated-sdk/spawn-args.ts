import { fail, ok, type DomainResult } from "../../../domain";
import type { ContextSnapshot } from "../context-snapshot/types.js";
import type { LaunchContract } from "../launch/ports.js";
import type { IsolatedThreadSpawnArgs } from "./sdk-isolation-contract.js";

export type { IsolatedThreadSpawnArgs } from "./sdk-isolation-contract.js";

export function spawnArgsFromContract(
  contract: LaunchContract,
  snapshot: ContextSnapshot,
  jobId: string,
): DomainResult<IsolatedThreadSpawnArgs> {
  const skillIds = [...new Set(contract.skillIds)];
  if (skillIds.length === 0) {
    return fail("incomplete_launch_contract", "skillIds must contain at least one catalog skill");
  }
  const prompt = snapshot.prompt.levels.job.trim();
  if (!prompt) {
    return fail("incomplete_launch_contract", "snapshot prompt.job is empty; no fallback brief");
  }
  return ok({
    projectId: contract.bbProjectId,
    providerId: contract.providerId,
    model: contract.model,
    prompt,
    environment: {
      type: "host",
      hostId: contract.hostId,
      workspace: { type: "unmanaged", path: contract.canonicalRoot },
    },
    isolatedSkillDelivery: true,
    skillIds,
    visibility: "hidden",
    experimental_callerLaunchId: contract.launchId,
    experimental_callerAttemptId: contract.attemptId,
    ...(jobId ? { experimental_callerJobId: jobId } : {}),
    ...(snapshot.execution?.reasoningLevel
      ? {
          reasoningLevel: snapshot.execution.reasoningLevel,
          executionInputSources: { reasoningLevel: "explicit" as const },
        }
      : {}),
  });
}
