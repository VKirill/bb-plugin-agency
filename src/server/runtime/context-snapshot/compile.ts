import { contractText } from "../../../shared/contracts/job";
import { catalogMcpIdSchema, catalogSkillIdSchema } from "../../../shared/contracts/ids.js";
import { AGENCY_SKILL_COMMANDS, AGENCY_SKILL_FORBIDDEN_SURFACES } from "./agency-commands.js";
import { PROMPT_PRECEDENCE_DEPARTMENT, PROMPT_PRECEDENCE_JOB } from "./prompt-precedence.js";
import { canonicalizeJson, deepFreeze, isSha256Hex, sha256Hex } from "./canonical.js";
import { effectivePolicy, policyContentHash, sortedUnique } from "./policy.js";
import { buildAttemptPack, snapshotPack, type AttemptPackFile } from "./pack.js";
import type {
  CatalogMcpEntry,
  CatalogSkillEntry,
  CatalogSkillId,
  CompileContextSnapshotInput,
  CompileContextSnapshotResult,
  ContextPromptLevels,
  ContextSnapshot,
  HandoffPackage,
  InputArtifactRef,
  SelectedMcp,
  SelectedSkill,
  SnapshotExclusion,
} from "./types.js";

const CATALOG_SKILL_ID = /^skill_[a-f0-9]{64}$/;
const CATALOG_MCP_ID = /^mcp_[a-f0-9]{64}$/;

type CompileFail = { ok: false; error: { code: string; message: string } };
type Indexed<T> = { ok: true; value: T } | CompileFail;

function fail(code: string, message: string): CompileFail {
  return { ok: false, error: { code, message } };
}

function findDuplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

function requireSource(kind: "skill" | "mcp", source: string | undefined): CompileFail | undefined {
  if (typeof source !== "string" || source.trim().length === 0) {
    return fail(
      kind === "skill" ? "catalog_skill_source_required" : "catalog_mcp_source_required",
      `catalog ${kind} source is required provenance; compiler does not guess it`,
    );
  }
  return undefined;
}

function indexSkills(entries: readonly CatalogSkillEntry[]): Indexed<Map<CatalogSkillId, CatalogSkillEntry>> {
  const index = new Map<CatalogSkillId, CatalogSkillEntry>();
  for (const entry of entries) {
    if (!CATALOG_SKILL_ID.test(entry.id) || !catalogSkillIdSchema.safeParse(entry.id).success) {
      return fail("invalid_catalog_skill_id", `catalog skill id is not skill_+64hex: ${entry.id}`);
    }
    if (!isSha256Hex(entry.hash)) {
      return fail("invalid_catalog_skill_hash", `catalog skill hash must be 64 hex: ${entry.id}`);
    }
    const sourceErr = requireSource("skill", entry.source);
    if (sourceErr) return sourceErr;
    const existing = index.get(entry.id);
    if (existing) {
      if (existing.hash !== entry.hash) {
        return fail("catalog_skill_hash_mismatch", `duplicate catalog skill with different hash: ${entry.id}`);
      }
      if (existing.source !== entry.source) {
        return fail(
          "catalog_skill_provenance_conflict",
          `catalog skill ${entry.id} hash matches but source ${existing.source} !== ${entry.source}`,
        );
      }
      continue;
    }
    index.set(entry.id, entry);
  }
  return { ok: true, value: index };
}

function indexMcps(entries: readonly CatalogMcpEntry[]): Indexed<Map<string, CatalogMcpEntry>> {
  const index = new Map<string, CatalogMcpEntry>();
  for (const entry of entries) {
    if (!CATALOG_MCP_ID.test(entry.id) || !catalogMcpIdSchema.safeParse(entry.id).success) {
      return fail("invalid_catalog_mcp_id", `catalog MCP id is not mcp_+64hex: ${entry.id}`);
    }
    if (!isSha256Hex(entry.hash)) {
      return fail("invalid_catalog_mcp_hash", `catalog MCP hash must be 64 hex: ${entry.id}`);
    }
    const sourceErr = requireSource("mcp", entry.source);
    if (sourceErr) return sourceErr;
    const existing = index.get(entry.id);
    if (existing) {
      if (existing.hash !== entry.hash) {
        return fail("catalog_mcp_hash_mismatch", `duplicate catalog MCP with different hash: ${entry.id}`);
      }
      if (existing.source !== entry.source) {
        return fail(
          "catalog_mcp_provenance_conflict",
          `catalog MCP ${entry.id} hash matches but source ${existing.source} !== ${entry.source}`,
        );
      }
      continue;
    }
    index.set(entry.id, entry);
  }
  return { ok: true, value: index };
}

function requireSkill(
  index: Map<CatalogSkillId, CatalogSkillEntry>,
  id: string,
  role: string,
): Indexed<CatalogSkillEntry> {
  if (!CATALOG_SKILL_ID.test(id)) {
    return fail("invalid_skill_id", `${role} skill id is not skill_+64hex: ${id}`);
  }
  const entry = index.get(id as CatalogSkillId);
  if (!entry) {
    return fail("unknown_skill", `${role} skill is not in supplied catalog: ${id}`);
  }
  return { ok: true, value: entry };
}

function artifactKey(item: Pick<InputArtifactRef, "artifactId" | "version" | "hash" | "jobId" | "hostId">): string {
  return `${item.artifactId}:${item.version}:${item.hash}:${item.jobId}:${item.hostId}`;
}

function handoffBodyHash(handoff: Omit<HandoffPackage, "hash">): string {
  return sha256Hex(
    canonicalizeJson({
      priorRunAttemptId: handoff.priorRunAttemptId,
      fromSnapshotDigest: handoff.fromSnapshotDigest,
      acceptedArtifacts: [...handoff.acceptedArtifacts].sort(
        (a, b) => a.artifactId.localeCompare(b.artifactId) || a.version - b.version,
      ),
      openQuestions: handoff.openQuestions,
      returnReason: handoff.returnReason,
    }),
  );
}

function compileHandoff(
  handoff: HandoffPackage | null,
  allowedArtifacts: readonly InputArtifactRef[],
): Indexed<HandoffPackage | null> {
  if (handoff === null) return { ok: true, value: null };
  if (!handoff.priorRunAttemptId || !handoff.fromSnapshotDigest) {
    return fail("handoff_required_fields", "handoff priorRunAttemptId and fromSnapshotDigest are required");
  }
  if (!isSha256Hex(handoff.fromSnapshotDigest)) {
    return fail("handoff_required_fields", "handoff fromSnapshotDigest must be 64 hex");
  }
  if (!Array.isArray(handoff.acceptedArtifacts) || !Array.isArray(handoff.openQuestions)) {
    return fail("handoff_required_fields", "handoff acceptedArtifacts and openQuestions are required");
  }
  const allowed = new Map(allowedArtifacts.map((item) => [artifactKey(item), item]));
  const accepted: InputArtifactRef[] = [];
  for (const item of handoff.acceptedArtifacts) {
    if (!item.artifactId || item.version == null || !item.hash || !item.jobId || !item.hostId) {
      return fail("handoff_required_fields", "accepted artifact needs artifactId/version/hash/jobId/hostId");
    }
    if (!isSha256Hex(item.hash)) {
      return fail("handoff_required_fields", `accepted artifact ${item.artifactId} hash must be 64 hex`);
    }
    const match = allowed.get(artifactKey(item));
    if (!match || match.relativePath !== item.relativePath) {
      return fail(
        "handoff_artifact_unauthorized",
        `handoff accepted artifact ${item.artifactId}@${item.version} must match an authorized input artifact version/hash/job/host`,
      );
    }
    accepted.push({
      artifactId: match.artifactId,
      version: match.version,
      hash: match.hash,
      jobId: match.jobId,
      hostId: match.hostId,
      relativePath: match.relativePath,
    });
  }
  accepted.sort((a, b) => a.artifactId.localeCompare(b.artifactId) || a.version - b.version);
  const compiled: Omit<HandoffPackage, "hash"> = {
    priorRunAttemptId: handoff.priorRunAttemptId,
    fromSnapshotDigest: handoff.fromSnapshotDigest,
    acceptedArtifacts: accepted,
    openQuestions: handoff.openQuestions,
    returnReason: handoff.returnReason,
  };
  const hash = handoffBodyHash(compiled);
  if (handoff.hash !== hash) {
    return fail("handoff_hash_mismatch", "handoff.hash does not match sha256(canonical(handoff without hash))");
  }
  return { ok: true, value: { ...compiled, hash } };
}

/** SchemaVersion 2. Frozen after revise tests 2026-09-14; no persist/spawn/I/O. */
export function compileContextSnapshot(input: CompileContextSnapshotInput): CompileContextSnapshotResult {
  if (input && typeof input === "object" && "secretValues" in input && (input as { secretValues?: unknown }).secretValues != null) {
    return fail("secret_value_forbidden", "secret values are not accepted; pass named secretRefs only");
  }
  if (input && typeof input === "object" && "policyVersion" in input) {
    return fail("policy_content_required", "policyVersion is removed; pass bindingPolicyVersion and agentPolicyVersion");
  }

  const { binding, job, agentVersion, processVersion, bindingPolicyVersion, agentPolicyVersion, projectRules } = input;

  if (job.bindingId !== binding.id) {
    return fail("binding_mismatch", `job.bindingId ${job.bindingId} !== binding.id ${binding.id}`);
  }
  if (processVersion.departmentId !== job.departmentId) {
    return fail("process_mismatch", `processVersion.departmentId ${processVersion.departmentId} !== job.departmentId ${job.departmentId}`);
  }
  const assignedAgentId = job.assignedAgentId;
  if (!assignedAgentId) {
    return fail("assignee_required", "job.assignedAgentId is required; compiler does not guess an agent");
  }
  if (assignedAgentId !== agentVersion.agentId) {
    return fail("agent_mismatch", `job.assignedAgentId ${assignedAgentId} !== agentVersion.agentId ${agentVersion.agentId}`);
  }
  if (agentVersion.policyVersionId !== agentPolicyVersion.id) {
    return fail("policy_mismatch", `agentVersion.policyVersionId ${agentVersion.policyVersionId} !== agentPolicyVersion.id ${agentPolicyVersion.id}`);
  }
  if (binding.policyVersionId !== bindingPolicyVersion.id) {
    return fail("policy_mismatch", `binding.policyVersionId ${binding.policyVersionId} !== bindingPolicyVersion.id ${bindingPolicyVersion.id}`);
  }
  if (!isSha256Hex(projectRules.hash)) {
    return fail("invalid_project_rules_hash", "projectRules.hash must be 64 hex");
  }
  if (sha256Hex(projectRules.text) !== projectRules.hash) {
    return fail("project_rules_hash_mismatch", "projectRules.hash does not match sha256(text)");
  }

  const policy = effectivePolicy(bindingPolicyVersion, agentPolicyVersion);
  if (!policy.ok) return policy;
  if (policy.value.cliHostConstraints.providerIds.length > 0 && !policy.value.cliHostConstraints.providerIds.includes(agentVersion.providerId)) {
    return fail(
      "provider_constraint_mismatch",
      `agentVersion.providerId ${agentVersion.providerId} is not in effective provider constraint intersection`,
    );
  }
  if (policy.value.cliHostConstraints.hostIds.length > 0 && !policy.value.cliHostConstraints.hostIds.includes(binding.hostId)) {
    return fail("host_constraint_mismatch", `binding.hostId ${binding.hostId} is not in effective host constraint intersection`);
  }

  const skillIndexOrErr = indexSkills(input.catalogSkills);
  if (!skillIndexOrErr.ok) return skillIndexOrErr;
  const skillIndex = skillIndexOrErr.value;

  const mcpIndexOrErr = indexMcps(input.catalogMcps);
  if (!mcpIndexOrErr.ok) return mcpIndexOrErr;
  const mcpIndex = mcpIndexOrErr.value;

  const coreDupes = findDuplicates(input.coreSkillIds);
  if (coreDupes.length > 0) {
    return fail("duplicate_core_skill", `coreSkillIds has duplicates: ${coreDupes.join(", ")}`);
  }
  const helperDupes = findDuplicates(input.helperSkillIds);
  if (helperDupes.length > 0) {
    return fail("duplicate_helper_skill", `helperSkillIds has duplicates: ${helperDupes.join(", ")}`);
  }
  const methodDupes = findDuplicates(agentVersion.skillIds);
  if (methodDupes.length > 0) {
    return fail("duplicate_method_skill", `agentVersion.skillIds has duplicates: ${methodDupes.join(", ")}`);
  }

  const selected: SelectedSkill[] = [];
  const selectedIds = new Set<CatalogSkillId>();

  for (const id of input.coreSkillIds) {
    const entry = requireSkill(skillIndex, id, "core");
    if (!entry.ok) return entry;
    selected.push({ id: entry.value.id, hash: entry.value.hash, role: "core", ...(entry.value.name ? { name: entry.value.name } : {}) });
    selectedIds.add(entry.value.id);
  }
  for (const id of input.helperSkillIds) {
    if (selectedIds.has(id)) {
      return fail("skill_role_conflict", `skill listed as both core and helper: ${id}`);
    }
    const entry = requireSkill(skillIndex, id, "helper");
    if (!entry.ok) return entry;
    selected.push({ id: entry.value.id, hash: entry.value.hash, role: "helper", ...(entry.value.name ? { name: entry.value.name } : {}) });
    selectedIds.add(entry.value.id);
  }
  for (const id of agentVersion.skillIds) {
    const entry = requireSkill(skillIndex, id, "method");
    if (!entry.ok) return entry;
    if (selectedIds.has(entry.value.id)) continue;
    selected.push({ id: entry.value.id, hash: entry.value.hash, role: "method", ...(entry.value.name ? { name: entry.value.name } : {}) });
    selectedIds.add(entry.value.id);
  }

  // Plugins: only ones the profile selects; their skills join the method skills.
  const grants = input.pluginGrants ?? [];
  const selectedPlugins = new Set(agentVersion.pluginIds ?? []);
  for (const grant of grants) {
    if (!selectedPlugins.has(grant.pluginId)) {
      return fail("plugin_not_selected", `plugin ${grant.pluginId} is not selected in agentVersion.pluginIds`);
    }
    for (const id of grant.skillIds) {
      const entry = requireSkill(skillIndex, id, "method");
      if (!entry.ok) return entry;
      if (selectedIds.has(entry.value.id)) continue;
      selected.push({ id: entry.value.id, hash: entry.value.hash, role: "method" });
      selectedIds.add(entry.value.id);
    }
  }
  const pluginIds = sortedUnique(grants.map((grant) => grant.pluginId));
  const pluginToolNames = sortedUnique(grants.flatMap((grant) => [...grant.toolNames]));

  const selectedMcps: SelectedMcp[] = [];
  const selectedMcpIds = new Set<string>();
  for (const mcpId of agentVersion.mcpIds) {
    if (!CATALOG_MCP_ID.test(mcpId)) {
      return fail("invalid_mcp_id", `agentVersion.mcpIds entry is not mcp_+64hex: ${mcpId}`);
    }
    const entry = mcpIndex.get(mcpId);
    if (!entry) {
      return fail("unknown_mcp", `agentVersion.mcpIds entry is not in supplied catalog: ${mcpId}`);
    }
    if (selectedMcpIds.has(entry.id)) continue;
    selectedMcps.push({ id: entry.id, hash: entry.hash });
    selectedMcpIds.add(entry.id);
  }
  selectedMcps.sort((a, b) => a.id.localeCompare(b.id));

  const authorizedJobs = new Set([job.id, ...input.authorizedInputJobIds]);
  const inputArtifacts: InputArtifactRef[] = [];
  const artifactKeys = new Set<string>();
  for (const artifact of input.inputArtifactVersions) {
    if (!authorizedJobs.has(artifact.jobId)) {
      return fail(
        "artifact_job_unauthorized",
        `artifact ${artifact.artifactId} v${artifact.version} jobId ${artifact.jobId} is not job.id or authorizedInputJobIds`,
      );
    }
    if (artifact.hostId !== binding.hostId) {
      return fail("host_mismatch", `artifact ${artifact.artifactId} hostId ${artifact.hostId} !== binding.hostId ${binding.hostId}`);
    }
    if (!isSha256Hex(artifact.hash)) {
      return fail("invalid_artifact_hash", `artifact ${artifact.artifactId} hash must be 64 hex`);
    }
    const key = `${artifact.artifactId}:${artifact.version}`;
    if (artifactKeys.has(key)) {
      return fail("duplicate_input_artifact", `duplicate input artifact ${key}`);
    }
    artifactKeys.add(key);
    inputArtifacts.push({
      artifactId: artifact.artifactId,
      version: artifact.version,
      hash: artifact.hash,
      jobId: artifact.jobId,
      hostId: artifact.hostId,
      relativePath: artifact.relativePath,
    });
  }
  inputArtifacts.sort((a, b) => a.artifactId.localeCompare(b.artifactId) || a.version - b.version);

  const handoff = compileHandoff(input.handoff, inputArtifacts);
  if (!handoff.ok) return handoff;

  const exclusions: SnapshotExclusion[] = [];
  for (const entry of skillIndex.values()) {
    if (!selectedIds.has(entry.id)) {
      exclusions.push({ kind: "catalog_skill", id: entry.id, reason: "not_selected" });
    }
  }
  for (const entry of mcpIndex.values()) {
    if (!selectedMcpIds.has(entry.id)) {
      exclusions.push({ kind: "catalog_mcp", id: entry.id, reason: "not_selected" });
    }
  }
  exclusions.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

  const selectedSkillsHash = sha256Hex(canonicalizeJson(selected.map((skill) => ({ id: skill.id, hash: skill.hash, role: skill.role }))));
  const selectedMcpsHash = sha256Hex(canonicalizeJson(selectedMcps));
  const inputArtifactsHash = sha256Hex(canonicalizeJson(inputArtifacts));

  const levelArgs: PromptLevelArgs = {
    binding,
    job,
    agentVersion,
    processVersion,
    bindingPolicyVersion,
    agentPolicyVersion,
    effective: policy.value,
    projectRules,
    agencyRules: input.agencyRules ?? null,
    knowledge: input.knowledge ?? null,
    workProfiles: input.workProfiles ?? null,
    passport: input.passport ?? null,
    briefing: input.briefing ?? null,
    selected,
    selectedMcps,
    inputArtifacts,
    handoff: handoff.value,
    plugins: { ids: pluginIds, toolNames: pluginToolNames },
    placement: input.placement ?? null,
    withoutSandbox: input.permissionMode === "full",
    roleInstructions: input.roleInstructions ?? null,
  };
  const levels = buildPromptLevels(levelArgs);
  const packFiles = buildAttemptPack(packInput(levelArgs, levels, input.memberRole ?? null, input.packLanguage ?? "en"));
  const promptDigest = sha256Hex(canonicalizeJson(levels));

  const snapshotWithoutDigest: Omit<ContextSnapshot, "digest"> = {
    schemaVersion: 2,
    binding: {
      id: binding.id,
      hostId: binding.hostId,
      canonicalRoot: binding.canonicalRoot,
      revision: binding.revision,
      bbProjectId: binding.bbProjectId,
      environmentId: binding.environmentId,
      policyVersionId: binding.policyVersionId,
    },
    job: {
      id: job.id,
      key: job.key,
      title: job.title,
      revision: job.revision,
      departmentId: job.departmentId,
      assignedAgentId,
      briefHash: sha256Hex(job.brief),
      acceptanceHash: sha256Hex(job.acceptance),
      ...(input.workProfiles?.body ? { workProfileHash: sha256Hex(input.workProfiles.body) } : {}),
      ...(input.passport?.text ? { passportHash: sha256Hex(input.passport.text) } : {}),
      ...(input.briefing?.text ? { briefingHash: sha256Hex(input.briefing.text) } : {}),
      ...(contractText(job.contract) ? { contractHash: sha256Hex(contractText(job.contract)) } : {}),
    },
    agentVersion: {
      id: agentVersion.id,
      agentId: agentVersion.agentId,
      version: agentVersion.version,
      providerId: agentVersion.providerId,
      model: agentVersion.model,
      role: agentVersion.role,
      instructionsHash: sha256Hex(agentVersion.instructions),
      policyVersionId: agentVersion.policyVersionId,
      skillIds: [...agentVersion.skillIds],
      mcpIds: [...agentVersion.mcpIds],
      ...(input.launchModelSource && input.launchModelSource !== "primary" ? { modelSource: input.launchModelSource } : {}),
    },
    processVersion: {
      id: processVersion.id,
      departmentId: processVersion.departmentId,
      instructionsHash: sha256Hex(processVersion.instructions),
      acceptanceHash: sha256Hex(processVersion.acceptance),
      reviewPolicy: { required: processVersion.reviewPolicy.required },
    },
    policy: {
      binding: { id: bindingPolicyVersion.id, contentHash: policyContentHash(bindingPolicyVersion) },
      agent: { id: agentPolicyVersion.id, contentHash: policyContentHash(agentPolicyVersion) },
      effective: policy.value,
    },
    projectRules: {
      versionId: projectRules.versionId,
      hash: projectRules.hash,
    },
    ...(input.agencyRules ? { agencyRules: { versionId: input.agencyRules.versionId, hash: input.agencyRules.hash } } : {}),
    ...(input.knowledge?.ids.length ? { knowledge: input.knowledge.ids.map((item) => ({ id: item.id, hash: item.hash })) } : {}),
    authorizedInputJobIds: sortedUnique([job.id, ...input.authorizedInputJobIds]),
    selectedSkills: selected,
    selectedSkillsHash,
    selectedMcps,
    selectedMcpsHash,
    inputArtifacts,
    inputArtifactsHash,
    handoff: handoff.value,
    exclusions,
    providerLimits: {
      ...(input.providerLimits.contextWindow !== undefined ? { contextWindow: input.providerLimits.contextWindow } : {}),
      ...(input.providerLimits.maxOutputTokens !== undefined ? { maxOutputTokens: input.providerLimits.maxOutputTokens } : {}),
    },
    ...(pluginIds.length ? { plugins: { ids: pluginIds, toolNames: pluginToolNames } } : {}),
    ...(agentVersion.reasoningEffort || agentVersion.serviceTier || input.permissionMode === "full"
      ? {
          execution: {
            ...(agentVersion.reasoningEffort ? { reasoningLevel: agentVersion.reasoningEffort } : {}),
            ...(agentVersion.serviceTier ? { serviceTier: agentVersion.serviceTier } : {}),
            ...(input.permissionMode === "full" ? { permissionMode: "full" as const } : {}),
          },
        }
      : {}),
    provenance: {
      recordsVerifiedBy: "caller",
      compilerAttestsAuth: false,
    },
    prompt: {
      levels,
      digest: promptDigest,
    },
    pack: snapshotPack(job.key, input.memberRole ?? null, packFiles),
  };

  const digest = sha256Hex(canonicalizeJson(snapshotWithoutDigest));
  const snapshot = deepFreeze({ ...snapshotWithoutDigest, digest }) as ContextSnapshot;
  return { ok: true, snapshot, packFiles };
}

type PromptLevelArgs = {
  binding: CompileContextSnapshotInput["binding"];
  job: CompileContextSnapshotInput["job"];
  agentVersion: CompileContextSnapshotInput["agentVersion"];
  processVersion: CompileContextSnapshotInput["processVersion"];
  bindingPolicyVersion: CompileContextSnapshotInput["bindingPolicyVersion"];
  agentPolicyVersion: CompileContextSnapshotInput["agentPolicyVersion"];
  effective: ContextSnapshot["policy"]["effective"];
  projectRules: CompileContextSnapshotInput["projectRules"];
  agencyRules: NonNullable<CompileContextSnapshotInput["agencyRules"]> | null;
  knowledge: NonNullable<CompileContextSnapshotInput["knowledge"]> | null;
  workProfiles: NonNullable<CompileContextSnapshotInput["workProfiles"]> | null;
  passport: NonNullable<CompileContextSnapshotInput["passport"]> | null;
  briefing: NonNullable<CompileContextSnapshotInput["briefing"]> | null;
  selected: SelectedSkill[];
  selectedMcps: SelectedMcp[];
  inputArtifacts: InputArtifactRef[];
  handoff: HandoffPackage | null;
  plugins: { ids: string[]; toolNames: string[] };
  placement: CompileContextSnapshotInput["placement"] | null;
  withoutSandbox: boolean;
  roleInstructions: string | null;
};

function buildPromptLevels(args: PromptLevelArgs): ContextPromptLevels {
  const {
    binding,
    job,
    agentVersion,
    processVersion,
    bindingPolicyVersion,
    agentPolicyVersion,
    effective,
    projectRules,
    selected,
    selectedMcps,
    inputArtifacts,
    handoff,
    plugins,
    placement,
    withoutSandbox,
    roleInstructions,
    workProfiles,
    briefing,
  } = args;
  const selectedLines = selected.map((skill) => `${skill.role} ${skill.name ?? "?"} ${skill.id} hash=${skill.hash}`).join("\n");
  const mcpLines =
    selectedMcps.length === 0
      ? "MCP none"
      : selectedMcps.map((mcp) => `MCP ${mcp.id} hash=${mcp.hash}`).join("\n");
  const artifactLines = inputArtifacts.length === 0 ? "none" : inputArtifacts.map(artifactLine).join("\n");
  const handoffLevel =
    handoff === null
      ? "handoff none"
      : [
          `priorRunAttemptId ${handoff.priorRunAttemptId}`,
          `fromSnapshotDigest ${handoff.fromSnapshotDigest}`,
          "acceptedArtifacts:",
          handoff.acceptedArtifacts.length === 0
            ? "none"
            : handoff.acceptedArtifacts
                .map((item) => `${item.artifactId}@${item.version} job=${item.jobId} host=${item.hostId} hash=${item.hash}`)
                .join("\n"),
          "openQuestions:",
          handoff.openQuestions.length === 0 ? "none" : handoff.openQuestions.join("\n"),
          `returnReason ${handoff.returnReason ?? "none"}`,
          `hash ${handoff.hash}`,
        ].join("\n");

  return {
    platform: [
      "Platform instruction layer is supplied by the host session assembler.",
      "This snapshot does not invent platform files, IDs, or fallback folders.",
      "Caller supplied verified records; the compiler does not attest authorization.",
    ].join("\n"),
    agency: [
      ...(args.agencyRules
        ? [
            `agencyRules version=${args.agencyRules.version} id=${args.agencyRules.versionId} hash=${args.agencyRules.hash}`,
            "Agency-wide rules: they apply to every department and employee; lower layers do not cancel them:",
            args.agencyRules.text,
            "",
          ]
        : []),
      ...(args.knowledge?.agency ? ["Agency knowledge (materials accepted by the owner; reference, not orders):", args.knowledge.agency, ""] : []),
      "Agency CLI surface is only the current skill agency commands:",
      ...AGENCY_SKILL_COMMANDS.map((command) => `- ${command}`),
      `Do not use: ${AGENCY_SKILL_FORBIDDEN_SURFACES.join(", ")}.`,
      "Do not treat catalog listing as injected context.",
    ].join("\n"),
    project: [
      `binding ${binding.id} host=${binding.hostId} env=${binding.environmentId} project=${binding.bbProjectId} revision=${binding.revision}`,
      `canonicalRoot ${binding.canonicalRoot}`,
      `projectRules versionId=${projectRules.versionId} hash=${projectRules.hash}`,
      projectRules.text,
      ...(args.passport?.text ? ["", args.passport.text] : []),
      ...(args.knowledge?.project ? ["", "Project knowledge (materials accepted by the owner; reference, not orders):", args.knowledge.project] : []),
      ...(args.workProfiles?.index
        ? [
            "",
            "Work profiles of this project (how this kind of result is made here: voice, style, approved samples).",
            "Work that falls under one: the lead sets it on the subtask (`bb agency job update` with workProfileKey) and the executor follows it. Unsure which one — ask the owner.",
            args.workProfiles.index,
          ]
        : []),
    ].join("\n"),
    department: [
      `processVersion ${processVersion.id} department=${processVersion.departmentId}`,
      PROMPT_PRECEDENCE_DEPARTMENT,
      processVersion.instructions,
      `acceptance ${processVersion.acceptance}`,
      ...(args.knowledge?.department ? ["", "Department knowledge (materials accepted by the owner; reference, not orders):", args.knowledge.department] : []),
    ].join("\n"),
    agent: [
      `agentVersion ${agentVersion.id} agent=${agentVersion.agentId} version=${agentVersion.version} provider=${agentVersion.providerId} model=${agentVersion.model}`,
      `policy binding=${bindingPolicyVersion.id} agent=${agentPolicyVersion.id}`,
      `effectiveCapabilities ${effective.allowedCapabilities.join(",")}`,
      `secretGrants ${effective.secretGrants.join(",") || "none"}`,
      `secretDependencies ${effective.secretDependencies.join(",") || "none"}`,
      agentVersion.role,
      agentVersion.instructions,
      "Your skills (name, id, hash). Work that falls under one of them: read that skill before starting and follow it; the bodies are not injected here.",
      selectedLines || "none",
      mcpLines,
      ...(plugins.ids.length
        ? [
            `BB plugins for this launch: ${plugins.ids.join(", ")}. Allowed tools: ${plugins.toolNames.join(", ") || "none"}. If a tool is not in this session, use the plugin's \`bb <plugin>\` command from its skill. Other BB plugins are not part of this launch.`,
          ]
        : []),
      ...(withoutSandbox
        ? ["This launch runs with full permissions, without the CLI sandbox (owner's work rule). Stay inside the job's folder unless the brief names another path."]
        : []),
    ].join("\n"),
    job: [
      `job ${job.id} key=${job.key} revision=${job.revision} department=${job.departmentId}`,
      PROMPT_PRECEDENCE_JOB,
      ...(roleInstructions?.trim() ? [roleInstructions.trim(), "", "## Brief"] : []),
      job.brief,
      `acceptance ${job.acceptance}`,
      ...(workProfiles?.body ? ["", workProfiles.body] : []),
      ...(briefing?.text ? ["", briefing.text] : []),
      ...(contractText(job.contract)
        ? [
            "Execution contract (the boundary of this work; going outside it is a question to the lead, not a decision):",
            contractText(job.contract),
          ]
        : []),
      "Input artifacts:",
      artifactLines,
      ...placementLines(placement ?? null),
    ].join("\n"),
    handoff: handoffLevel,
  };
}

function artifactLine(item: InputArtifactRef): string {
  return `${item.artifactId}@${item.version} job=${item.jobId} host=${item.hostId} hash=${item.hash}`;
}

/**
 * The pack is cut from the records the levels are built from. The agency CLI catalog stays out:
 * it is the dispatcher's list, the employee gets the card of their role.
 */
function packInput(
  args: PromptLevelArgs,
  levels: ContextPromptLevels,
  memberRole: string | null,
  lang: "ru" | "en",
): Parameters<typeof buildAttemptPack>[0] {
  const block = (title: string, text: string | null | undefined) => (text?.trim() ? [`## ${title}`, text.trim(), ""] : []);
  return {
    job: args.job,
    memberRole,
    position: args.agentVersion.role,
    lang,
    contract: contractText(args.job.contract),
    inputLines: [
      ...args.inputArtifacts.map((item) => `- ${artifactLine(item)} path=${item.relativePath}`),
      ...placementLines(args.placement ?? null),
    ],
    handoff: args.handoff === null ? null : levels.handoff,
    briefing: args.briefing?.text ?? null,
    rules: [
      ...block("Agency rules", args.agencyRules?.text),
      ...block("Agency knowledge", args.knowledge?.agency),
      ...block("Role in this job", args.roleInstructions),
      ...block("Department", levels.department),
      ...block("Employee", levels.agent),
    ],
    project: [
      ...block("Passport", args.passport?.text),
      ...block("Project knowledge", args.knowledge?.project),
      ...block("Work profiles", args.workProfiles?.index),
      ...block("Work profile of this job", args.workProfiles?.body),
    ],
  };
}

/** Folders beyond the job's own: where a subtask may go and where the main job's files are. */
function placementLines(placement: CompileContextSnapshotInput["placement"] | null): string[] {
  if (!placement) return [];
  const lines: string[] = [];
  if (placement.projectFolders.length) {
    lines.push(
      "Other folders of this project (a subtask may run there; pass that folder's bindingId):",
      ...placement.projectFolders.map((folder) => `folder bindingId=${folder.bindingId} host=${folder.hostId} root=${folder.root}`),
    );
  }
  if (placement.workplaces.length) {
    lines.push(
      "Employees of this department with their own workplace (a subtask for them goes to the workplace bindingId):",
      ...placement.workplaces.map((row) => `workplace ${row.name} agent=${row.agentId} bindingId=${row.bindingId} host=${row.hostId} root=${row.root}`),
    );
  }
  if (placement.parentFolder) {
    const parent = placement.parentFolder;
    lines.push(
      `Main job ${parent.jobKey} lives in another folder: bindingId=${parent.bindingId} host=${parent.hostId} root=${parent.root}.`,
      "You work in this job's folder. Files of the main job come as input versions; any other file from that machine is copied with File Gateway (`bb file-gateway copy <host> <absolute path> <this host>`) when that plugin is in this launch, otherwise ask the lead to attach it.",
    );
  }
  return lines;
}

export function computeHandoffHash(handoff: Omit<HandoffPackage, "hash">): string {
  return handoffBodyHash(handoff);
}
