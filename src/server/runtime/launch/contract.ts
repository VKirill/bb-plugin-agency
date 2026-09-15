import { fail, ok, type DomainResult } from "../../../domain";
import type { ContextSnapshot } from "../context-snapshot/types.js";
import type { LaunchContract } from "./ports.js";

export function launchContractFromSnapshot(
  snapshot: ContextSnapshot,
  ids: { snapshotId: string; attemptId: string; launchId: string },
): DomainResult<LaunchContract> {
  const model = snapshot.agentVersion.model;
  const providerId = snapshot.agentVersion.providerId;
  const hostId = snapshot.binding.hostId;
  const canonicalRoot = snapshot.binding.canonicalRoot;
  const environmentId = snapshot.binding.environmentId;
  const bbProjectId = snapshot.binding.bbProjectId;
  if (!model || !providerId || !hostId || !canonicalRoot || !environmentId || !bbProjectId) {
    return fail("incomplete_launch_contract", "snapshot is missing model, provider, host, path or environment; no fallback");
  }
  if (!snapshot.digest || !ids.snapshotId || !ids.attemptId || !ids.launchId) {
    return fail("incomplete_launch_contract", "snapshotId, digest, attemptId and launchId are required; no fallback");
  }
  return ok({
    snapshotId: ids.snapshotId,
    digest: snapshot.digest,
    attemptId: ids.attemptId,
    launchId: ids.launchId,
    providerId,
    model,
    skillIds: snapshot.selectedSkills.map((skill) => skill.id),
    mcpIds: snapshot.selectedMcps.map((mcp) => mcp.id),
    hostId,
    canonicalRoot,
    environmentId,
    bbProjectId,
  });
}

export function hostEnvRootMatches(snapshot: ContextSnapshot, live: {
  hostId: string;
  environmentId: string;
  canonicalRoot: string;
  bbProjectId: string;
}): boolean {
  return (
    snapshot.binding.hostId === live.hostId &&
    snapshot.binding.environmentId === live.environmentId &&
    snapshot.binding.canonicalRoot === live.canonicalRoot &&
    snapshot.binding.bbProjectId === live.bbProjectId
  );
}
