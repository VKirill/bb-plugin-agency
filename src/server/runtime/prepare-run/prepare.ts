import { assertDepartmentOnBinding, assertJobTransition, fail, ok, type DomainResult } from "../../../domain";
import type { HostFilePort } from "../../../host/file-port.js";
import { requestIdSchema } from "../../../shared/contracts";
import type { Job } from "../../../shared/contracts/job.js";
import { assertBindingScope, type ServiceContext } from "../../services/context.js";
import type { DomainStore } from "../../services/domain-store.js";
import { compileContextSnapshot } from "../context-snapshot/compile.js";
import type { CatalogSkillEntry, ContextSnapshot } from "../context-snapshot/types.js";
import type { ReservedPreparedRun, RunStore } from "../run-store/types.js";
import { selectCatalogRoles } from "./catalog-roles.js";
import {
  isHandshakeReady,
  type IsolatedCapabilityHandshake,
  type IsolatedCapabilityHandshakePort,
} from "./handshake.js";
import type { SkillCatalogPort } from "./ports.js";
import {
  bindingHostFilePorts,
  deriveTrustedSources,
  readProjectRules,
  type LoadedProjectRules,
  type ProjectRulesFilePorts,
} from "./project-rules.js";
import type { VerifiedPrepareConfig } from "./server-config.js";
import type { JobInputPort } from "./job-input.js";
import { hashCatalogSkillPackage } from "./skill-package.js";

const PREPARE_JOB_STATES = new Set(["backlog", "queued"]);

/** Public integration input. Rules/catalog/attestation/readiness are not client fields. */
export type PrepareRunPublicInput = {
  requestId: string;
  jobId: string;
  expectedRevision: number;
};

export type PreparedRun = {
  snapshot: ContextSnapshot;
  reserved: ReservedPreparedRun;
  handshake: IsolatedCapabilityHandshake;
  handshakeReady: boolean;
  projectRules: LoadedProjectRules;
  catalogSkills: readonly CatalogSkillEntry[];
  roles: {
    coreSkillIds: readonly string[];
    helperSkillIds: readonly string[];
    methodSkillIds: readonly string[];
  };
};

export type PrepareRunDeps = {
  store: DomainStore;
  files: HostFilePort;
  catalog: SkillCatalogPort;
  handshake: IsolatedCapabilityHandshakePort;
  runs: RunStore;
  server: VerifiedPrepareConfig;
  ruleFiles?: ProjectRulesFilePorts;
  jobInputs?: JobInputPort;
};

function jobReady(job: Job): DomainResult<true> {
  if (!PREPARE_JOB_STATES.has(job.state)) {
    return fail("illegal_job_state", `prepare accepts backlog|queued, job is ${job.state}`);
  }
  const queued = assertJobTransition("backlog", "queued", {
    assignedAgentId: job.assignedAgentId,
    bindingId: job.bindingId,
    brief: job.brief,
    acceptance: job.acceptance,
  });
  if (!queued.ok) return queued;
  return ok(true);
}

export function createPrepareRun(deps: PrepareRunDeps) {
  return {
    async prepare(ctx: ServiceContext, input: PrepareRunPublicInput): Promise<DomainResult<PreparedRun>> {
      const requestId = requestIdSchema.safeParse(input.requestId);
      if (!requestId.success) return fail("invalid_command", "requestId must be a UUID");

      const handshake = await deps.handshake.probe();
      if (!handshake.ok) return handshake;

      const job = deps.store.getJob(input.jobId);
      if (!job) return fail("not_found", `job ${input.jobId} not found`);
      const access = deps.store.assertBindingAccess(ctx, job.bindingId);
      if (!access.ok) return access;
      const ready = jobReady(job);
      if (!ready.ok) return ready;
      if (job.revision !== input.expectedRevision) {
        return fail("revision_conflict", "expectedRevision does not match the live job revision");
      }

      const binding = deps.store.getBinding(job.bindingId);
      if (!binding) return fail("not_found", `binding ${job.bindingId} not found`);
      const scoped = assertBindingScope(ctx, binding, undefined);
      if (!scoped.ok) return scoped;

      const department = deps.store.getDepartment(job.departmentId);
      if (!department) return fail("not_found", `department ${job.departmentId} not found`);
      const links = deps.store.listProjectDepartments(binding.id);
      const onBinding = assertDepartmentOnBinding(binding.id, department.id, links);
      if (!onBinding.ok) return onBinding;

      if (!job.assignedAgentId) return fail("assignee_required", "job.assignedAgentId is required");
      const agent = deps.store.getAgent(job.assignedAgentId);
      if (!agent) return fail("not_found", `agent ${job.assignedAgentId} not found`);
      const agentVersion = deps.store.getAgentVersion(agent.currentVersionId);
      if (!agentVersion) return fail("not_found", `agent version ${agent.currentVersionId} not found`);
      if (agentVersion.agentId !== agent.id) {
        return fail("version_mismatch", "currentVersionId must belong to this agent");
      }

      const processVersion = deps.store.getProcessVersion(department.processVersionId);
      if (!processVersion) return fail("not_found", `process version ${department.processVersionId} not found`);

      const bindingPolicy = deps.store.getPolicyVersion(binding.policyVersionId);
      if (!bindingPolicy) return fail("not_found", `binding policy ${binding.policyVersionId} not found`);
      const agentPolicy = deps.store.getPolicyVersion(agentVersion.policyVersionId);
      if (!agentPolicy) return fail("not_found", `agent policy ${agentVersion.policyVersionId} not found`);

      const trusted = deriveTrustedSources(
        { hostId: binding.hostId, canonicalRoot: binding.canonicalRoot },
        deps.server.parent,
        deps.server.bindingSource,
      );
      if (!trusted.ok) return trusted;

      const ruleFiles = deps.ruleFiles ?? bindingHostFilePorts(deps.files);
      const projectRules = await readProjectRules(ruleFiles, {
        applicable: deps.server.applicable,
        trustedSources: trusted.value,
      });
      if (!projectRules.ok) return projectRules;

      const listed = await deps.catalog.list({
        projectId: binding.bbProjectId,
        environmentId: binding.environmentId,
        hostId: binding.hostId,
      });
      if (!listed.ok) return listed;
      const roles = selectCatalogRoles(listed.value, agentVersion.skillIds, deps.server.catalogRoles);
      if (!roles.ok) return roles;

      const neededIds = new Set<string>([
        ...roles.value.coreSkillIds,
        ...roles.value.helperSkillIds,
        ...agentVersion.skillIds,
      ]);
      const catalogSkills: CatalogSkillEntry[] = [];
      for (const skill of listed.value) {
        if (!neededIds.has(skill.id)) continue;
        const hashed = await hashCatalogSkillPackage(deps.catalog, skill);
        if (!hashed.ok) return hashed;
        catalogSkills.push(hashed.value);
      }

      const persistedInputs = deps.jobInputs
        ? await deps.jobInputs.loadForPrepare(ctx, job.id)
        : ok({
            inputArtifactVersions: [],
            authorizedInputJobIds: [job.id],
            handoff: null,
          });
      if (!persistedInputs.ok) return persistedInputs;

      const compiled = compileContextSnapshot({
        binding,
        job,
        agentVersion,
        processVersion,
        bindingPolicyVersion: bindingPolicy,
        agentPolicyVersion: agentPolicy,
        projectRules: {
          versionId: projectRules.value.versionId,
          text: projectRules.value.text,
          hash: projectRules.value.hash,
        },
        inputArtifactVersions: persistedInputs.value.inputArtifactVersions,
        authorizedInputJobIds: persistedInputs.value.authorizedInputJobIds,
        catalogSkills,
        catalogMcps: [],
        coreSkillIds: roles.value.coreSkillIds,
        helperSkillIds: roles.value.helperSkillIds,
        providerLimits: {},
        handoff: persistedInputs.value.handoff,
      });
      if (!compiled.ok) return fail(compiled.error.code, compiled.error.message);

      const reserved = deps.runs.reservePreparedRun(ctx, {
        requestId: input.requestId,
        snapshot: compiled.snapshot,
        attestation: {
          accessVerified: true,
          revisionsVerified: true,
          expectedJobRevision: job.revision,
          expectedBindingRevision: binding.revision,
        },
      });
      if (!reserved.ok) return reserved;

      return ok({
        snapshot: compiled.snapshot,
        reserved: reserved.value,
        handshake: handshake.value,
        handshakeReady: isHandshakeReady(handshake.value),
        projectRules: projectRules.value,
        catalogSkills,
        roles: roles.value,
      });
    },
  };
}
