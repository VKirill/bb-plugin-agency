import { parseContract } from "../db/repositories";
import type {
  Agent,
  AgentVersion,
  Department,
  Job,
  JobState,
  Membership,
  PolicyVersion,
  ProcessVersion,
  ProjectBinding,
  ProjectDepartment,
} from "../../shared/contracts";
import type { SqlDatabase } from "../db/sql";
import { mapStoredAgentVersion } from "../db/repositories";

type BindingRow = {
  id: string;
  bb_project_id: string;
  environment_id: string;
  host_id: string;
  canonical_root: string;
  policy_version_id: string;
  section_id: string | null;
  revision: number;
  updated_at: string;
  archived_at?: string | null;
};

type JobRow = {
  id: string;
  key: Job["key"];
  binding_id: string;
  department_id: string;
  title: string;
  brief: string;
  acceptance: string;
  state: JobState;
  parent_job_id: string | null;
  assigned_agent_id: string | null;
  reviewer_agent_ids?: string | null;
  observer_agent_ids?: string | null;
  priority: Job["priority"];
  due_at: string | null;
  contract_json?: string | null;
  revision: number;
  updated_at: string;
  closed_at?: string | null;
};

type AgentRow = {
  id: string;
  name: string;
  state: Agent["state"];
  current_version_id: string;
  revision: number;
  updated_at: string;
};

type DepartmentRow = {
  id: string;
  name: string;
  lead_agent_id: string;
  process_version_id: string;
  revision: number;
  updated_at: string;
  availability?: string | null;
};

function mapBinding(row: BindingRow): ProjectBinding {
  return {
    id: row.id,
    bbProjectId: row.bb_project_id,
    environmentId: row.environment_id,
    hostId: row.host_id,
    canonicalRoot: row.canonical_root,
    policyVersionId: row.policy_version_id,
    sectionId: row.section_id,
    revision: row.revision,
    updatedAt: row.updated_at,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
  };
}

function parseTeamIds(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    key: row.key,
    bindingId: row.binding_id,
    departmentId: row.department_id,
    title: row.title,
    brief: row.brief,
    acceptance: row.acceptance,
    state: row.state,
    parentJobId: row.parent_job_id,
    assignedAgentId: row.assigned_agent_id,
    reviewerAgentIds: parseTeamIds(row.reviewer_agent_ids),
    observerAgentIds: parseTeamIds(row.observer_agent_ids),
    priority: row.priority,
    dueAt: row.due_at,
    ...parseContract(row.contract_json),
    revision: row.revision,
    updatedAt: row.updated_at,
    ...(row.closed_at ? { closedAt: row.closed_at } : {}),
  };
}

export function listStoredPolicies(db: SqlDatabase): PolicyVersion[] {
  return (
    db.prepare(`SELECT id, allowed_capabilities, cli_host_constraints, secret_refs FROM agency_policy_version`).all() as Array<{
      id: string;
      allowed_capabilities: string;
      cli_host_constraints: string;
      secret_refs: string;
    }>
  ).map((row) => ({
    id: row.id,
    allowedCapabilities: JSON.parse(row.allowed_capabilities) as PolicyVersion["allowedCapabilities"],
    cliHostConstraints: JSON.parse(row.cli_host_constraints) as PolicyVersion["cliHostConstraints"],
    secretRefs: JSON.parse(row.secret_refs) as PolicyVersion["secretRefs"],
  }));
}

export function listStoredBindings(db: SqlDatabase): ProjectBinding[] {
  return (db.prepare(`SELECT * FROM agency_project_binding`).all() as BindingRow[]).map(mapBinding);
}

export function listStoredAgents(db: SqlDatabase): Agent[] {
  return (db.prepare(`SELECT * FROM agency_agent`).all() as AgentRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    state: row.state,
    currentVersionId: row.current_version_id,
    revision: row.revision,
    updatedAt: row.updated_at,
  }));
}

export function listStoredDepartments(db: SqlDatabase): Department[] {
  return (db.prepare(`SELECT * FROM agency_department`).all() as DepartmentRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    leadAgentId: row.lead_agent_id,
    processVersionId: row.process_version_id,
    revision: row.revision,
    updatedAt: row.updated_at,
    ...(row.availability === "selected" ? { availability: "selected" as const } : {}),
  }));
}

export function listJobsForBindings(db: SqlDatabase, bindingIds: readonly string[]): Job[] {
  if (bindingIds.length === 0) return [];
  const placeholders = bindingIds.map(() => "?").join(", ");
  return (
    db.prepare(
      `SELECT * FROM agency_job WHERE binding_id IN (${placeholders})
       ORDER BY CAST(SUBSTR(key, 4) AS INTEGER), key`,
    ).all(...bindingIds) as JobRow[]
  ).map(mapJob);
}

export function countJobsByState(db: SqlDatabase, bindingIds: readonly string[]): Record<JobState, number> {
  const counts: Record<JobState, number> = {
    backlog: 0,
    queued: 0,
    running: 0,
    review: 0,
    waiting_input: 0,
    blocked: 0,
    done: 0,
    canceled: 0,
  };
  if (bindingIds.length === 0) return counts;
  const placeholders = bindingIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT state, COUNT(*) AS n FROM agency_job WHERE binding_id IN (${placeholders}) GROUP BY state`)
    .all(...bindingIds) as Array<{ state: JobState; n: number }>;
  for (const row of rows) counts[row.state] = row.n;
  return counts;
}

export function listStoredMemberships(db: SqlDatabase): Membership[] {
  return (
    db.prepare(`SELECT department_id, agent_id, role FROM agency_membership`).all() as Array<{
      department_id: string;
      agent_id: string;
      role: Membership["role"];
    }>
  ).map((row) => ({ departmentId: row.department_id, agentId: row.agent_id, role: row.role }));
}

export function listStoredProjectDepartments(db: SqlDatabase, bindingIds?: readonly string[]): ProjectDepartment[] {
  const rows = (
    bindingIds && bindingIds.length > 0
      ? db
          .prepare(
            `SELECT binding_id, department_id FROM agency_project_department WHERE binding_id IN (${bindingIds.map(() => "?").join(", ")})`,
          )
          .all(...bindingIds)
      : db.prepare(`SELECT binding_id, department_id FROM agency_project_department`).all()
  ) as Array<{ binding_id: string; department_id: string }>;
  return rows.map((row) => ({ bindingId: row.binding_id, departmentId: row.department_id }));
}

export function listCurrentAgentVersions(db: SqlDatabase, agents: readonly Agent[]): AgentVersion[] {
  return agents
    .map((agent) => {
      const row = db.prepare(`SELECT * FROM agency_agent_version WHERE id = ?`).get(agent.currentVersionId) as
        | Parameters<typeof mapStoredAgentVersion>[0]
        | undefined;
      if (!row) return undefined;
      return mapStoredAgentVersion(row);
    })
    .filter((row): row is AgentVersion => Boolean(row));
}

export function listCurrentProcessVersions(db: SqlDatabase, departments: readonly Department[]): ProcessVersion[] {
  return departments
    .map((department) => {
      const row = db.prepare(`SELECT * FROM agency_process_version WHERE id = ?`).get(department.processVersionId) as
        | {
            id: string;
            department_id: string;
            instructions: string;
            acceptance: string;
            review_policy: string;
          }
        | undefined;
      if (!row) return undefined;
      return {
        id: row.id,
        departmentId: row.department_id,
        instructions: row.instructions,
        acceptance: row.acceptance,
        reviewPolicy: JSON.parse(row.review_policy) as ProcessVersion["reviewPolicy"],
      };
    })
    .filter((row): row is ProcessVersion => Boolean(row));
}

export function listArtifactIdsForJob(db: SqlDatabase, jobId: string): string[] {
  return (db.prepare(`SELECT id FROM agency_artifact WHERE job_id = ?`).all(jobId) as Array<{ id: string }>).map(
    (row) => row.id,
  );
}
