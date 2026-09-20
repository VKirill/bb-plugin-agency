import { fail, ok, type DomainResult } from "../../../domain";
import type { AgentVersion } from "../../../shared/contracts/versions";
import type { DomainStore } from "../../services";

export const LIVE_ASSIGNED_PROVIDER_SOURCE = "live_assigned_agent_version" as const;

export type LiveAssignedProvider = {
  jobId: string;
  agentId: string;
  agentVersionId: string;
  providerId: string;
  /** The model of the live profile: the launch checks the machine really has it. */
  model: string;
  source: typeof LIVE_ASSIGNED_PROVIDER_SOURCE;
};

export function resolveLiveAssignedProvider(
  store: Pick<DomainStore, "getAgent" | "getAgentVersion">,
  job: { id: string; assignedAgentId: string | null },
  options?: { effectiveVersion?: (version: AgentVersion) => AgentVersion },
): DomainResult<LiveAssignedProvider> {
  if (!job.assignedAgentId) return fail("assignee_required", "job.assignedAgentId is required");
  const agent = store.getAgent(job.assignedAgentId);
  if (!agent) return fail("not_found", `agent ${job.assignedAgentId} not found`);
  if (agent.state === "paused" || agent.state === "archived") return fail("agent_inactive", `agent ${agent.name} is ${agent.state}; activate the profile before launching`);
  const stored = store.getAgentVersion(agent.currentVersionId);
  if (!stored) return fail("not_found", `agent version ${agent.currentVersionId} not found`);
  if (stored.agentId !== agent.id) return fail("version_mismatch", "currentVersionId must belong to this agent");
  const version = options?.effectiveVersion?.(stored) ?? stored;
  if (!version.providerId.trim()) return fail("provider_required", "live agentVersion.providerId is empty");
  if (!version.model?.trim()) return fail("model_required", "live agentVersion.model is empty");
  return ok({
    jobId: job.id,
    agentId: agent.id,
    agentVersionId: stored.id,
    providerId: version.providerId,
    model: version.model,
    source: LIVE_ASSIGNED_PROVIDER_SOURCE,
  });
}
