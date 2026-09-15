export type {
  AcceptArtifactVersionCommand,
  Activity,
  Agent,
  AgentVersion,
  CreateAgentVersionCommand,
  CreateJobCommand,
  CreateMembershipCommand,
  CreatePolicyVersionCommand,
  CreateProcessVersionCommand,
  CreateProjectBindingCommand,
  Department,
  Job,
  JobTransitionCommand,
  Membership,
  PolicyVersion,
  ProcessVersion,
  ProjectBinding,
  ProjectDepartment,
  UpdateAgentCommand,
  UpdateDepartmentCommand,
  UpdateJobCommand,
  UpdateProjectBindingCommand,
} from "../../shared/contracts";

export type CreateActivityRpc = {
  requestId: string;
  jobId: string;
  kind: string;
  causationId: string | null;
  references: { type: string; id: string }[];
  comment?: string;
  claimedBbProjectId?: string;
};

export type CreateArtifactRpc = {
  requestId: string;
  jobId: string;
  claimedBbProjectId?: string;
};

export type PublishArtifactRpc = {
  requestId: string;
  artifactId: string;
  jobId: string;
  relativePath: string;
  mime: string;
  size: number;
  hash: string;
  bytesBase64: string;
  claimedBbProjectId?: string;
};

export type OpenArtifactRpc = {
  artifactId: string;
  jobId: string;
  version: number;
  claimedBbProjectId?: string;
};

export type OpenArtifactResult = {
  hostId: string;
  size: number;
  hash: string;
  bytesBase64: string;
  target: { hostId: string; path: string };
};

export type ResolveArtifactPreviewRpc = {
  hostId: string;
  path: string;
};

export type ResolvedArtifactPreview = {
  artifactId: string;
  jobId: string;
  version: number;
  hash: string;
  mime: string;
  size: number;
  relativePath: string;
  bindingId: string;
  target: { hostId: string; path: string };
};

export type ProvisionAgentInput = {
  requestId: string;
  name: string;
  state: "active" | "paused" | "archived";
  version: {
    version: number;
    role: string;
    instructions: string;
    providerId: string;
    model: string;
    skillIds: string[];
    mcpIds: string[];
    policyVersionId: string;
  };
};

export type CatalogCapability = { id: string; label: string; source: string };

export type CapabilityCatalog = {
  skills: CatalogCapability[];
  mcps: CatalogCapability[];
  skillDiscovery: "sdk" | "unavailable";
  mcpDiscovery: "unavailable";
  isolation: {
    catalogSkillsIsolated: false;
    catalogMcpIsolated: false;
    execution: "unavailable";
    reason: string;
  };
};

export type BbCatalog = {
  projects: { id: string; name: string }[];
  environments: { id: string; projectId: string; hostId: string; hostName: string; path: string; label: string }[];
  policies: { id: string; label: string }[];
  skills: CatalogCapability[];
  mcps: CatalogCapability[];
  skillDiscovery: "sdk" | "unavailable";
  mcpDiscovery: "unavailable";
};

export type ProvisionDepartmentInput = {
  requestId: string;
  name: string;
  leadAgentId: string;
  process: {
    instructions: string;
    acceptance: string;
    reviewPolicy: { required: boolean };
  };
};
