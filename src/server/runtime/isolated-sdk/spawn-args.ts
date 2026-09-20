import { fail, ok, type DomainResult } from "../../../domain";
import { attemptPackDir, PACK_ENTRY } from "../context-snapshot/pack.js";
import type { ContextSnapshot } from "../context-snapshot/types.js";
import type { LaunchContract } from "../launch/ports.js";
import { AGENCY_PLUGIN_ID, type IsolatedThreadSpawnArgs } from "./sdk-isolation-contract.js";

export type { IsolatedThreadSpawnArgs } from "./sdk-isolation-contract.js";

/**
 * The spawn prompt is a short pointer to the on-disk attempt pack. The brief, the contract, the
 * rules, the handoff and the role's CLI card are files of the pack, pinned by the snapshot digest;
 * none of them is pasted here.
 */

/** The first line names the job: BB titles the hidden thread from the start of the prompt. */
export function composeWorkerPrompt(snapshot: Pick<ContextSnapshot, "job" | "agentVersion" | "pack">): string {
  const dir = snapshot.pack?.dir ?? attemptPackDir(snapshot.job.key);
  const role = [snapshot.pack?.role, snapshot.agentVersion.role.trim().split("\n")[0]].filter(Boolean).join(", ");
  return [
    `${snapshot.job.key}: ${snapshot.job.title}`,
    `You are an Agency employee${role ? `: ${role}` : ""}.`,
    `Your job pack is in ${dir}/. Read ${dir}/${PACK_ENTRY} and the files it lists before the first edit, then do that job. The pack is the assignment: do not call job get for your own brief.`,
    `Hand in: write ${dir}/report.md, publish it as the job's artifact, leave a closing job comment and end the turn. Do not wait for the owner to accept this station.`,
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
  const prompt = composeWorkerPrompt(snapshot);
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
    origin: "plugin",
    originPluginId: AGENCY_PLUGIN_ID,
    visibility: "hidden",
    pluginMetadata: {
      agencyLaunchId: contract.launchId,
      agencyAttemptId: contract.attemptId,
      agencyJobId: jobId,
    },
    ...(snapshot.execution?.reasoningLevel || snapshot.execution?.serviceTier || snapshot.execution?.permissionMode
      ? {
          ...(snapshot.execution.reasoningLevel ? { reasoningLevel: snapshot.execution.reasoningLevel } : {}),
          ...(snapshot.execution.serviceTier ? { serviceTier: snapshot.execution.serviceTier } : {}),
          ...(snapshot.execution.permissionMode ? { permissionMode: snapshot.execution.permissionMode } : {}),
          executionInputSources: {
            ...(snapshot.execution.reasoningLevel ? { reasoningLevel: "explicit" as const } : {}),
            ...(snapshot.execution.serviceTier ? { serviceTier: "explicit" as const } : {}),
            ...(snapshot.execution.permissionMode ? { permissionMode: "explicit" as const } : {}),
          },
        }
      : {}),
  });
}
