import { assertBindingActive, assertDepartmentOnBinding, assertJobTransition, fail, ok, type DomainResult } from "../../../domain";
import type { HostFilePort } from "../../../host/file-port.js";
import { requestIdSchema } from "../../../shared/contracts";
import type { AgentVersion } from "../../../shared/contracts/versions.js";
import type { Job } from "../../../shared/contracts/job.js";
import { assertBindingScope, type ServiceContext } from "../../services/context.js";
import type { DomainStore } from "../../services/domain-store.js";
import { compileContextSnapshot } from "../context-snapshot/compile.js";
import { PACK_FILE_NAMES, type AttemptPackFile, type SnapshotPack } from "../context-snapshot/pack.js";
import { agencyLanguage } from "../../i18n/language.js";
import type { CatalogSkillEntry, ContextSnapshot, PluginGrant } from "../context-snapshot/types.js";
import type { ReservedPreparedRun, RunStore } from "../run-store/types.js";
import { selectCatalogRoles } from "./catalog-roles.js";
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
import { recentJobHistory } from "./recent-history.js";
import { launchModelSource } from "../agent-fallback.js";

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
  runs: RunStore;
  server: VerifiedPrepareConfig;
  ruleFiles?: ProjectRulesFilePorts;
  jobInputs?: JobInputPort;
  /** The launch's role guidance in its job (lead, executor or reviewer). */
  roleInstructions?: (jobId: string) => string | null;
  /** Подсказка оценщика к этой работе: навыки и записи памяти под задачу. Молчит — запуск как раньше. */
  briefing?: (input: {
    job: Pick<Job, "key" | "title" | "brief" | "acceptance" | "contract" | "departmentId"> & { assignedAgentId: string };
    target: Pick<AgentVersion, "providerId" | "model" | "reasoningEffort">;
    hostId: string;
    /** Навыки сотрудника: они уедут в запуск в любом случае. */
    skills: readonly { id: string; name: string; description?: string }[];
    /** Весь каталог машины: из него берётся библиотека отдела. */
    catalog: readonly { id: string; name: string; description?: string }[];
  }) => Promise<{ text: string; addSkillIds?: readonly string[]; lessonIds?: readonly string[]; reasoningEffort?: AgentVersion["reasoningEffort"] } | null>;
  /** Agent tools of installed, running plugins; fails for a plugin that is missing or off. */
  pluginTools?: (pluginIds: readonly string[]) => Promise<DomainResult<{ pluginId: string; toolNames: string[] }[]>>;
  /** Overlay the pair this launch runs on (primary or an owner-set reserve) without rewriting the stored profile. */
  effectiveAgentVersion?: (version: AgentVersion) => AgentVersion;
  /**
   * Wraps only the slot reservation. The snapshot is compiled outside of it (files, skills, the
   * briefing), so one job's slow preparation never holds another job's launch.
   */
  reserveGate?: (reserve: () => DomainResult<ReservedPreparedRun>) => Promise<DomainResult<ReservedPreparedRun>>;
  /**
   * No longer consulted: the pack is written after the reservation, by the prepare that owns the
   * attempt, so a refused prepare never touches the pack of a thread that is starting or working.
   */
  hasLiveAttempt?: (jobId: string) => boolean;
};

/** BB accepts at most 32 skills, tools and instruction plugins per isolated thread. */
const ISOLATED_LIST_LIMIT = 32;

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
      const active = assertBindingActive(binding);
      if (!active.ok) return active;
      const links = deps.store.listProjectDepartments(binding.id);
      const onBinding = assertDepartmentOnBinding(binding.id, department.id, links, department.availability ?? "all");
      if (!onBinding.ok) return onBinding;

      if (!job.assignedAgentId) return fail("assignee_required", "job.assignedAgentId is required");
      const agent = deps.store.getAgent(job.assignedAgentId);
      if (!agent) return fail("not_found", `agent ${job.assignedAgentId} not found`);
      const storedVersion = deps.store.getAgentVersion(agent.currentVersionId);
      if (!storedVersion) return fail("not_found", `agent version ${agent.currentVersionId} not found`);
      if (storedVersion.agentId !== agent.id) {
        return fail("version_mismatch", "currentVersionId must belong to this agent");
      }
      let agentVersion = deps.effectiveAgentVersion?.(storedVersion) ?? storedVersion;

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

      const withoutSandbox = deps.store.rulesForLaunch?.(job.departmentId, agent.id, binding.hostId).runWithoutSandbox === true;
      const pluginIds = agentVersion.pluginIds ?? [];
      const pluginGrants: PluginGrant[] = [];
      if (pluginIds.length) {
        if (!deps.pluginTools) return fail("plugin_delivery_unsupported", "Каталог плагинов недоступен: запуск с плагинами не выполняется.");
        const tools = await deps.pluginTools(pluginIds);
        if (!tools.ok) return tools;
        for (const pluginId of pluginIds) {
          const toolNames = tools.value.find((item) => item.pluginId === pluginId)?.toolNames ?? [];
          const skillIds = listed.value
            .filter((skill) => skill.pluginId === pluginId || skill.source === `plugin:${pluginId}`)
            .map((skill) => skill.id);
          pluginGrants.push({ pluginId, toolNames, skillIds });
        }
        const toolCount = new Set(pluginGrants.flatMap((grant) => grant.toolNames)).size;
        if (toolCount > ISOLATED_LIST_LIMIT) {
          return fail("too_many_plugin_tools", `У выбранных плагинов ${toolCount} инструментов, BB передаёт в запуск не больше ${ISOLATED_LIST_LIMIT}.`);
        }
      }

      const neededIds = new Set<string>([
        ...roles.value.coreSkillIds,
        ...roles.value.helperSkillIds,
        ...agentVersion.skillIds,
        ...pluginGrants.flatMap((grant) => grant.skillIds),
      ]);
      if (neededIds.size > ISOLATED_LIST_LIMIT) {
        return fail("too_many_skills", `Запуску нужно ${neededIds.size} навыков с учётом плагинов, BB передаёт не больше ${ISOLATED_LIST_LIMIT}.`);
      }
      // Подсказка спрашивается до упаковки навыков: открытое из библиотеки отдела должно уехать
      // в тот же запуск, а не в следующий. Молчит — набор остаётся ровно профильным.
      const briefing = deps.briefing
        ? await deps.briefing({
            job: { key: job.key, title: job.title, brief: job.brief, acceptance: job.acceptance, contract: job.contract, departmentId: job.departmentId, assignedAgentId: job.assignedAgentId ?? "" },
            target: agentVersion,
            hostId: binding.hostId,
            // The evaluator is asked about method skills only. Core and helper skills (the agency
            // skill itself) ride in every launch: asking about them spends the question and, on a
            // short profile, drowns the hint in its own noise rule.
            skills: roles.value.methodSkillIds
              .map((id) => listed.value.find((skill) => skill.id === id))
              .filter((skill): skill is (typeof listed.value)[number] => Boolean(skill))
              .map(briefingSkill),
            // What already rides in the launch is not a library candidate either.
            catalog: listed.value.filter((skill) => !neededIds.has(skill.id)).map(briefingSkill),
          }).catch(() => null)
        : null;
      for (const skillId of briefing?.addSkillIds ?? []) {
        // Потолок BB сильнее любой подсказки: сверх него навык просто не открывается.
        if (neededIds.size >= ISOLATED_LIST_LIMIT) break;
        if (listed.value.some((skill) => skill.id === skillId)) neededIds.add(skillId);
      }
      const memberRole = deps.store.memberRole(job.departmentId, job.assignedAgentId);
      if (briefing?.reasoningEffort && (memberRole === "executor" || memberRole === "assistant")) {
        agentVersion = { ...agentVersion, reasoningEffort: briefing.reasoningEffort };
      }

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
        recentHistory: recentJobHistory(deps.store.listActivity(job.id)),
        agencyRules: agencyRulesInput(deps.store.currentAgencyRules?.() ?? null),
        knowledge: deps.store.knowledgeForLaunch?.(job.departmentId, binding.id, briefing?.lessonIds ?? null, job.sectionId) ?? null,
        workProfiles: deps.store.workProfilesForLaunch?.(binding.id, job.workProfileKey ?? null) ?? null,
        passport: deps.store.passportForLaunch?.(binding.id, job.departmentId, job.assignedAgentId ?? null, binding.hostId) ?? null,
        briefing,
        ...(pluginGrants.length ? { pluginGrants } : {}),
        placement: deps.store.placementForLaunch?.(job) ?? null,
        permissionMode: withoutSandbox ? "full" : null,
        roleInstructions: deps.roleInstructions?.(job.id) ?? null,
        launchModelSource: launchModelSource(storedVersion, agentVersion),
        memberRole,
        packLanguage: agencyLanguage(),
      });
      if (!compiled.ok) return fail(compiled.error.code, compiled.error.message);

      const reserve = () =>
        deps.runs.reservePreparedRun(ctx, {
          requestId: input.requestId,
          snapshot: compiled.snapshot,
          attestation: {
            accessVerified: true,
            revisionsVerified: true,
            expectedJobRevision: job.revision,
            expectedBindingRevision: binding.revision,
          },
        });
      const reserved = deps.reserveGate ? await deps.reserveGate(reserve) : reserve();
      if (!reserved.ok) return reserved;

      // The pack goes to disk after the reservation: only the prepare that owns the attempt writes
      // it, and what it writes is what the reserved digest pins.
      if (reserved.value.digest !== compiled.snapshot.digest || !compiled.snapshot.pack) {
        return fail("snapshot_digest_conflict", "the reserved attempt pins another snapshot; its pack is left as it is");
      }
      const written = await writeAttemptPack(deps.files, binding.canonicalRoot, compiled.snapshot.pack, compiled.packFiles);
      if (!written.ok) return written;

      return ok({
        snapshot: compiled.snapshot,
        reserved: reserved.value,
        projectRules: projectRules.value,
        catalogSkills,
        roles: roles.value,
      });
    },
  };
}

function briefingSkill(skill: { id: string; name: string; description?: string }) {
  return { id: skill.id, name: skill.name, ...(skill.description ? { description: skill.description } : {}) };
}

/**
 * Bring the folder to the pinned pack: a file with the pinned hash stays, another one is replaced,
 * a pack file of an earlier preparation that this pack lacks (an old handoff or hint) goes away.
 * `report.md` and everything else in the folder is the employee's and is not touched.
 */
async function writeAttemptPack(
  files: HostFilePort,
  canonicalRoot: string,
  pack: SnapshotPack,
  bodies: readonly AttemptPackFile[],
): Promise<DomainResult<true>> {
  for (const pinned of pack.files) {
    const body = bodies.find((file) => file.name === pinned.name);
    if (!body) return fail("pack_mismatch", `pack file ${pinned.name} has no body`);
    const path = `${pack.dir}/${pinned.name}`;
    const existing = await files.stat(canonicalRoot, path);
    if (!existing.ok) return existing;
    if (existing.value?.hash === pinned.hash) continue;
    if (existing.value) {
      const removed = await files.remove(canonicalRoot, path);
      if (!removed.ok) return removed;
    }
    const written = await files.writeAtomic(canonicalRoot, path, new TextEncoder().encode(body.body));
    if (!written.ok) return written;
    if (written.value.hash !== pinned.hash) return fail("pack_mismatch", `${path} on disk does not match the snapshot`);
  }
  const current = new Set(pack.files.map((file) => file.name));
  for (const name of PACK_FILE_NAMES) {
    if (current.has(name)) continue;
    const removed = await files.remove(canonicalRoot, `${pack.dir}/${name}`);
    if (!removed.ok) return removed;
  }
  return ok(true);
}

function agencyRulesInput(rules: { id: string; version: number; hash: string; text: string } | null) {
  return rules ? { versionId: rules.id, version: rules.version, hash: rules.hash, text: rules.text } : null;
}
