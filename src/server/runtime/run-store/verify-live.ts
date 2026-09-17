import { contractText } from "../../../shared/contracts/job";
import { fail, ok, type DomainResult } from "../../../domain";
import type { Job, PolicyVersion, ProjectBinding } from "../../../shared/contracts";
import type { Repositories } from "../../db/repositories";
import { assertBindingAccess, assertBindingScope, type ServiceContext } from "../../services/context";
import { sameCanonical } from "../../services/request-identity";
import { sha256Hex } from "../context-snapshot/canonical.js";
import { effectivePolicy, policyContentHash } from "../context-snapshot/policy.js";
import type { ContextSnapshot } from "../context-snapshot/types.js";

function listsEqual(left: readonly string[], right: readonly string[]): boolean {
  return sameCanonical([...left].sort(), [...right].sort());
}

function requireJobBindingAccess(
  ctx: ServiceContext,
  repos: Repositories,
  jobId: string,
  reason: string,
): DomainResult<true> {
  const job = repos.job.get(jobId);
  if (!job) return fail("unauthorized_record", reason);
  const binding = repos.binding.get(job.bindingId);
  if (!binding) return fail("unauthorized_record", reason);
  const access = assertBindingAccess(ctx, binding.id);
  if (!access.ok) return fail("unauthorized_record", reason);
  return ok(true);
}

export function verifyAuthorizedRecords(
  ctx: ServiceContext,
  repos: Repositories,
  snapshot: ContextSnapshot,
  lookupPriorAttempt?: (attemptId: string) => { jobId: string } | undefined,
): DomainResult<true> {
  const allowedJobs = new Set(snapshot.authorizedInputJobIds);
  if (!allowedJobs.has(snapshot.job.id)) {
    return fail("unauthorized_record", "authorizedInputJobIds must include the snapshot job");
  }
  for (const jobId of snapshot.authorizedInputJobIds) {
    const scoped = requireJobBindingAccess(ctx, repos, jobId, `job ${jobId} is not an authorized in-scope record`);
    if (!scoped.ok) return scoped;
  }
  for (const artifact of snapshot.inputArtifacts) {
    if (!allowedJobs.has(artifact.jobId)) {
      return fail("unauthorized_record", `artifact ${artifact.artifactId} job is outside authorizedInputJobIds`);
    }
    const stored = repos.artifactVersion.get(artifact.artifactId, artifact.jobId, artifact.version);
    if (!stored || stored.hash !== artifact.hash) {
      return fail("unauthorized_record", `artifact ${artifact.artifactId}@${artifact.version} is not an authorized live record`);
    }
    const scoped = requireJobBindingAccess(
      ctx,
      repos,
      artifact.jobId,
      `artifact ${artifact.artifactId} job is outside caller scope`,
    );
    if (!scoped.ok) return scoped;
  }
  if (snapshot.handoff) {
    const prior = lookupPriorAttempt?.(snapshot.handoff.priorRunAttemptId);
    if (!prior) {
      return fail("unauthorized_record", "handoff priorRunAttemptId is not an authorized live attempt");
    }
    const scoped = requireJobBindingAccess(
      ctx,
      repos,
      prior.jobId,
      "handoff prior attempt is outside caller scope",
    );
    if (!scoped.ok) return scoped;
    for (const artifact of snapshot.handoff.acceptedArtifacts) {
      if (!allowedJobs.has(artifact.jobId)) {
        return fail("unauthorized_record", "handoff accepted artifact is outside authorizedInputJobIds");
      }
      const stored = repos.artifactVersion.get(artifact.artifactId, artifact.jobId, artifact.version);
      if (!stored || stored.hash !== artifact.hash) {
        return fail("unauthorized_record", "handoff accepted artifact is not an authorized live record");
      }
    }
  }
  return ok(true);
}

export function verifyLiveLaunchIdentity(
  ctx: ServiceContext,
  repos: Repositories,
  snapshot: ContextSnapshot,
  claimedBbProjectId: string | undefined,
  attestation: { expectedJobRevision: number; expectedBindingRevision: number },
): DomainResult<{ job: Job; binding: ProjectBinding }> {
  const job = repos.job.get(snapshot.job.id);
  if (!job) return fail("not_found", `job ${snapshot.job.id} not found`);
  const binding = repos.binding.get(snapshot.binding.id);
  if (!binding) return fail("not_found", `binding ${snapshot.binding.id} not found`);
  if (job.bindingId !== binding.id) {
    return fail("binding_mismatch", "snapshot job is not on the snapshot binding");
  }
  const scope = assertBindingScope(ctx, binding, claimedBbProjectId);
  if (!scope.ok) return scope;
  if (job.revision !== attestation.expectedJobRevision || job.revision !== snapshot.job.revision) {
    return fail("revision_conflict", "job revision does not match live record and attestation");
  }
  if (binding.revision !== attestation.expectedBindingRevision || binding.revision !== snapshot.binding.revision) {
    return fail("revision_conflict", "binding revision does not match live record and attestation");
  }
  if (
    snapshot.binding.canonicalRoot !== binding.canonicalRoot ||
    snapshot.binding.environmentId !== binding.environmentId ||
    snapshot.binding.bbProjectId !== binding.bbProjectId ||
    snapshot.binding.hostId !== binding.hostId ||
    snapshot.binding.policyVersionId !== binding.policyVersionId
  ) {
    return fail("live_binding_mismatch", "snapshot binding host/root/env/project/policy does not match live record");
  }
  if (
    snapshot.job.assignedAgentId !== job.assignedAgentId ||
    snapshot.job.departmentId !== job.departmentId ||
    snapshot.job.key !== job.key ||
    snapshot.job.title !== job.title ||
    snapshot.job.briefHash !== sha256Hex(job.brief) ||
    snapshot.job.acceptanceHash !== sha256Hex(job.acceptance) ||
    (snapshot.job.contractHash ?? null) !== (contractText(job.contract) ? sha256Hex(contractText(job.contract)) : null)
  ) {
    return fail("live_job_mismatch", "snapshot job assignee/department/content does not match live record");
  }
  // Agency rules changed after the launch was prepared: the employee would work by an outdated top layer.
  if ((snapshot.agencyRules?.versionId ?? null) !== (repos.agencyRules.current()?.id ?? null)) {
    return fail("live_agency_rules_mismatch", "snapshot agency rules version is not the rules in force");
  }
  const agent = job.assignedAgentId ? repos.agent.get(job.assignedAgentId) : undefined;
  if (!agent) return fail("live_job_mismatch", "live job has no assigned agent");
  if (snapshot.agentVersion.id !== agent.currentVersionId || snapshot.agentVersion.agentId !== agent.id) {
    return fail("live_version_mismatch", "snapshot agentVersion is not the live current version");
  }
  const agentVersion = repos.agentVersion.get(agent.currentVersionId);
  if (!agentVersion) return fail("not_found", `agentVersion ${agent.currentVersionId} not found`);
  const department = repos.department.get(job.departmentId);
  if (!department) return fail("not_found", `department ${job.departmentId} not found`);
  if (snapshot.processVersion.id !== department.processVersionId) {
    return fail("live_version_mismatch", "snapshot processVersion is not the live current version");
  }
  const processVersion = repos.processVersion.get(department.processVersionId);
  if (!processVersion) return fail("not_found", `processVersion ${department.processVersionId} not found`);
  if (
    snapshot.agentVersion.model !== agentVersion.model ||
    snapshot.agentVersion.providerId !== agentVersion.providerId ||
    snapshot.agentVersion.version !== agentVersion.version ||
    snapshot.agentVersion.role !== agentVersion.role ||
    snapshot.agentVersion.instructionsHash !== sha256Hex(agentVersion.instructions) ||
    snapshot.agentVersion.policyVersionId !== agentVersion.policyVersionId ||
    !listsEqual(snapshot.agentVersion.skillIds, agentVersion.skillIds) ||
    !listsEqual(snapshot.agentVersion.mcpIds, agentVersion.mcpIds)
  ) {
    return fail("live_version_mismatch", "snapshot agentVersion content/model does not match live record");
  }
  if (
    snapshot.processVersion.departmentId !== processVersion.departmentId ||
    snapshot.processVersion.instructionsHash !== sha256Hex(processVersion.instructions) ||
    snapshot.processVersion.acceptanceHash !== sha256Hex(processVersion.acceptance) ||
    snapshot.processVersion.reviewPolicy.required !== processVersion.reviewPolicy.required
  ) {
    return fail("live_version_mismatch", "snapshot processVersion content does not match live record");
  }
  const bindingPolicy = repos.policy.get(binding.policyVersionId);
  const agentPolicy = repos.policy.get(agentVersion.policyVersionId);
  if (!bindingPolicy || !agentPolicy) return fail("not_found", "live policy version not found");
  const liveEffective = effectivePolicy(bindingPolicy, agentPolicy);
  if (!liveEffective.ok) return fail(liveEffective.error.code, liveEffective.error.message);
  if (
    snapshot.policy.binding.id !== binding.policyVersionId ||
    snapshot.policy.agent.id !== agentVersion.policyVersionId ||
    snapshot.policy.binding.contentHash !== policyContentHash(bindingPolicy) ||
    snapshot.policy.agent.contentHash !== policyContentHash(agentPolicy) ||
    snapshot.policy.effective.contentHash !== liveEffective.value.contentHash
  ) {
    return fail("live_policy_mismatch", "snapshot policies do not match live PolicyVersion content");
  }
  return ok({ job, binding });
}
