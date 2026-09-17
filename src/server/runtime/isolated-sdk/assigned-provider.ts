import { fail, ok, type DomainResult } from "../../../domain";
import type { DomainStore } from "../../services";
import { ISOLATION_PROVEN_PROVIDERS } from "./sdk-isolation-contract.js";

export const LIVE_ASSIGNED_PROVIDER_SOURCE = "live_assigned_agent_version" as const;

export type LiveAssignedProvider = {
  jobId: string;
  agentId: string;
  agentVersionId: string;
  providerId: string;
  source: typeof LIVE_ASSIGNED_PROVIDER_SOURCE;
};

export function resolveLiveAssignedProvider(
  store: Pick<DomainStore, "getAgent" | "getAgentVersion">,
  job: { id: string; assignedAgentId: string | null },
): DomainResult<LiveAssignedProvider> {
  if (!job.assignedAgentId) return fail("assignee_required", "job.assignedAgentId is required");
  const agent = store.getAgent(job.assignedAgentId);
  if (!agent) return fail("not_found", `agent ${job.assignedAgentId} not found`);
  if (agent.state === "paused" || agent.state === "archived") return fail("agent_inactive", `agent ${agent.name} is ${agent.state}; activate the profile before launching`);
  const version = store.getAgentVersion(agent.currentVersionId);
  if (!version) return fail("not_found", `agent version ${agent.currentVersionId} not found`);
  if (version.agentId !== agent.id) return fail("version_mismatch", "currentVersionId must belong to this agent");
  if (!version.providerId.trim()) return fail("provider_required", "live agentVersion.providerId is empty");
  return ok({
    jobId: job.id,
    agentId: agent.id,
    agentVersionId: version.id,
    providerId: version.providerId,
    source: LIVE_ASSIGNED_PROVIDER_SOURCE,
  });
}

export function assertProvenIsolationProvider(providerId: string): DomainResult<true> {
  if (!(ISOLATION_PROVEN_PROVIDERS as readonly string[]).includes(providerId)) {
    return fail(
      "provider_isolation_unproven",
      `live assigned agentVersion provider ${providerId} is not in proven isolation set (${ISOLATION_PROVEN_PROVIDERS.join(",")})`,
    );
  }
  return ok(true);
}
