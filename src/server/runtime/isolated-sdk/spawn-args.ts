import { fail, ok, type DomainResult } from "../../../domain";
import type { ContextSnapshot } from "../context-snapshot/types.js";
import type { LaunchContract } from "../launch/ports.js";
import type { IsolatedThreadSpawnArgs } from "./sdk-isolation-contract.js";

export type { IsolatedThreadSpawnArgs } from "./sdk-isolation-contract.js";

/**
 * Layers a worker reads, in compile order. A later layer does not cancel an
 * earlier one. The platform layer is supplied by the host session, not here.
 * Without department and agent layers a worker never sees its job description
 * or the department charter, so it cannot tell its own work from misrouted work.
 */
const WORKER_PROMPT_LAYERS = [
  ["agency", "Agency rules"],
  ["project", "Project"],
  ["department", "Department: process and scope"],
  ["agent", "Your position and job description"],
  ["job", "Job"],
  ["handoff", "Handoff from the previous attempt"],
] as const;

/** The first line names the job: BB titles the hidden thread from the start of the prompt. */
export function composeWorkerPrompt(
  levels: ContextSnapshot["prompt"]["levels"],
  job?: Pick<ContextSnapshot["job"], "key" | "title">,
): string {
  const sections = WORKER_PROMPT_LAYERS.flatMap(([layer, title]) => {
    const text = levels[layer].trim();
    return text ? [`## ${title} (${layer})\n${text}`] : [];
  });
  return [
    ...(job ? [`${job.key}: ${job.title}`] : []),
    "You are an employee of the BB Agency. The layers below add to each other: a lower layer does not cancel a higher one.",
    ...sections,
  ].join("\n\n");
}

export function spawnArgsFromContract(
  contract: LaunchContract,
  snapshot: ContextSnapshot,
  jobId: string,
): DomainResult<IsolatedThreadSpawnArgs> {
  const skillIds = [...new Set(contract.skillIds)];
  if (skillIds.length === 0) {
    return fail("incomplete_launch_contract", "skillIds must contain at least one catalog skill");
  }
  if (!snapshot.prompt.levels.job.trim()) {
    return fail("incomplete_launch_contract", "snapshot prompt.job is empty; no fallback brief");
  }
  const prompt = composeWorkerPrompt(snapshot.prompt.levels, snapshot.job);
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
    ...(snapshot.execution?.reasoningLevel || snapshot.execution?.permissionMode
      ? {
          ...(snapshot.execution.reasoningLevel ? { reasoningLevel: snapshot.execution.reasoningLevel } : {}),
          ...(snapshot.execution.permissionMode ? { permissionMode: snapshot.execution.permissionMode } : {}),
          executionInputSources: {
            ...(snapshot.execution.reasoningLevel ? { reasoningLevel: "explicit" as const } : {}),
            ...(snapshot.execution.permissionMode ? { permissionMode: "explicit" as const } : {}),
          },
        }
      : {}),
    ...(snapshot.plugins?.ids.length
      ? {
          instructionPluginIds: [...snapshot.plugins.ids],
          ...(snapshot.plugins.toolNames.length
            ? { dynamicToolNames: [...snapshot.plugins.toolNames], allowBridgeToolProxy: true }
            : {}),
        }
      : {}),
  });
}
