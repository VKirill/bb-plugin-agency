import type {
  Agent,
  AgentVersion,
  BoardPolicy,
  Department,
  Job,
  JobState,
  Membership,
  PolicyVersion,
  ProcessVersion,
  ProjectBinding,
  ProjectDepartment,
} from "../../shared/contracts";

export type CatalogIsolation = {
  catalogSkillsIsolated: false;
  catalogMcpIsolated: false;
  execution: "unavailable";
  reason: string;
};

export type WorkspaceBinding = ProjectBinding & {
  bbProjectName: string;
  environmentName: string | null;
  hostName: string | null;
};

export type WorkspaceSnapshot = {
  contractVersion: "agency.domain.stage1.v1";
  isolation: CatalogIsolation;
  bindings: WorkspaceBinding[];
  jobs: Job[];
  counts: Partial<Record<JobState, number>>;
  agents: Agent[];
  departments: Department[];
  memberships: Membership[];
  agentVersions: AgentVersion[];
  processVersions: ProcessVersion[];
  projectDepartments: ProjectDepartment[];
  policies: PolicyVersion[];
  /** Board hygiene from plugin settings; absent on older servers. */
  board?: BoardPolicy;
  /** Hours before a due date the job reads as «due soon», by department id. */
  dueReminderHours?: Record<string, number>;
  archivedCount?: number;
  jobGoals?: Record<string, string>;
  departmentParents?: Record<string, string>;
  escalations?: Record<string, string>;
  /** Jobs waiting in the launch queue, by job id. */
  launchQueue?: Record<string, { jobId: string; position: number; requestedAt: string; waitingReason: string | null }>;
};

export const EMPTY_SNAPSHOT: WorkspaceSnapshot = {
  contractVersion: "agency.domain.stage1.v1",
  isolation: {
    catalogSkillsIsolated: false,
    catalogMcpIsolated: false,
    execution: "unavailable",
    reason: "RPC ещё не ответил.",
  },
  bindings: [],
  jobs: [],
  counts: {},
  agents: [],
  departments: [],
  memberships: [],
  agentVersions: [],
  processVersions: [],
  projectDepartments: [],
  policies: [],
};

export function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.contractVersion === "agency.domain.stage1.v1" &&
    Array.isArray(record.jobs) &&
    Array.isArray(record.agents) &&
    Array.isArray(record.departments) &&
    Array.isArray(record.bindings) &&
    Array.isArray(record.memberships) &&
    Array.isArray(record.agentVersions) &&
    Array.isArray(record.processVersions) &&
    Array.isArray(record.projectDepartments) &&
    Array.isArray(record.policies) &&
    Boolean(record.isolation)
  );
}
