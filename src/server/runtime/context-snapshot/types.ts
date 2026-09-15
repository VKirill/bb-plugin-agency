import type { ArtifactVersion } from "../../../shared/contracts/artifact.js";
import type { CatalogMcpId, CatalogSkillId } from "../../../shared/contracts/ids.js";
import type { ProjectBinding } from "../../../shared/contracts/project-binding.js";
import type { Job } from "../../../shared/contracts/job.js";
import type { AgentVersion, PolicyVersion, ProcessVersion, ReasoningEffort } from "../../../shared/contracts/versions.js";

export type { CatalogMcpId, CatalogSkillId };

export type SkillRole = "core" | "helper" | "method";

export type CatalogSkillEntry = {
  id: CatalogSkillId;
  hash: string;
  source: string;
  name?: string;
};

export type CatalogMcpEntry = {
  id: CatalogMcpId;
  hash: string;
  source: string;
  name?: string;
};

export type ProjectRulesInput = {
  versionId: string;
  text: string;
  hash: string;
};

export type ProviderLimits = {
  contextWindow?: number;
  maxOutputTokens?: number;
};

export type InputArtifactRef = {
  artifactId: string;
  version: number;
  hash: string;
  jobId: string;
  hostId: string;
  relativePath: string;
};

export type HandoffPackage = {
  priorRunAttemptId: string;
  fromSnapshotDigest: string;
  acceptedArtifacts: InputArtifactRef[];
  openQuestions: string[];
  returnReason: string | null;
  hash: string;
};

export type CompileContextSnapshotInput = {
  binding: ProjectBinding;
  job: Job;
  agentVersion: AgentVersion;
  processVersion: ProcessVersion;
  bindingPolicyVersion: PolicyVersion;
  agentPolicyVersion: PolicyVersion;
  projectRules: ProjectRulesInput;
  inputArtifactVersions: readonly ArtifactVersion[];
  authorizedInputJobIds: readonly string[];
  catalogSkills: readonly CatalogSkillEntry[];
  catalogMcps: readonly CatalogMcpEntry[];
  coreSkillIds: readonly CatalogSkillId[];
  helperSkillIds: readonly CatalogSkillId[];
  providerLimits: ProviderLimits;
  handoff: HandoffPackage | null;
};

export type SelectedSkill = {
  id: CatalogSkillId;
  hash: string;
  role: SkillRole;
};

export type SelectedMcp = {
  id: CatalogMcpId;
  hash: string;
};

export type SnapshotExclusion = {
  kind: "catalog_skill" | "catalog_mcp";
  id: string;
  reason: "not_selected";
};

export type ContextPromptLevels = {
  platform: string;
  agency: string;
  project: string;
  department: string;
  agent: string;
  job: string;
  handoff: string;
};

export type CompiledContextPrompt = {
  levels: ContextPromptLevels;
  digest: string;
};

export type PolicyContent = {
  allowedCapabilities: string[];
  cliHostConstraints: {
    providerIds: string[];
    hostIds: string[];
  };
  secretRefs: string[];
};

export type EffectivePolicy = {
  allowedCapabilities: string[];
  cliHostConstraints: {
    providerIds: string[];
    hostIds: string[];
  };
  /** Intersection of secretRef *names* that passed name-format checks. Not a secret detector. */
  secretGrants: string[];
  /** Declared names from either policy. Not authorization. */
  secretDependencies: string[];
  contentHash: string;
};

export type SnapshotProvenance = {
  recordsVerifiedBy: "caller";
  compilerAttestsAuth: false;
};

export type ContextSnapshot = {
  schemaVersion: 2;
  binding: {
    id: string;
    hostId: string;
    canonicalRoot: string;
    revision: number;
    bbProjectId: string;
    environmentId: string;
    policyVersionId: string;
  };
  job: {
    id: string;
    key: string;
    title: string;
    revision: number;
    departmentId: string;
    assignedAgentId: string;
    briefHash: string;
    acceptanceHash: string;
  };
  agentVersion: {
    id: string;
    agentId: string;
    version: number;
    providerId: string;
    model: string;
    role: string;
    instructionsHash: string;
    policyVersionId: string;
    skillIds: CatalogSkillId[];
    mcpIds: CatalogMcpId[];
  };
  processVersion: {
    id: string;
    departmentId: string;
    instructionsHash: string;
    acceptanceHash: string;
    reviewPolicy: { required: boolean };
  };
  policy: {
    binding: { id: string; contentHash: string };
    agent: { id: string; contentHash: string };
    effective: EffectivePolicy;
  };
  projectRules: {
    versionId: string;
    hash: string;
  };
  authorizedInputJobIds: string[];
  selectedSkills: SelectedSkill[];
  selectedSkillsHash: string;
  selectedMcps: SelectedMcp[];
  selectedMcpsHash: string;
  inputArtifacts: InputArtifactRef[];
  inputArtifactsHash: string;
  handoff: HandoffPackage | null;
  exclusions: SnapshotExclusion[];
  providerLimits: ProviderLimits;
  /** Frozen spawn execution. Omitted on legacy snapshots and when AgentVersion has no effort. */
  execution?: {
    reasoningLevel: ReasoningEffort;
  };
  provenance: SnapshotProvenance;
  prompt: CompiledContextPrompt;
  digest: string;
};

export type CompileContextSnapshotError = {
  code: string;
  message: string;
};

export type CompileContextSnapshotResult =
  | { ok: true; snapshot: ContextSnapshot }
  | { ok: false; error: CompileContextSnapshotError };
