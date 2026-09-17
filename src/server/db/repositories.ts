import { currentAgencyRules } from "../templates/store";
import { contractIsEmpty, jobContractSchema, type JobContract } from "../../shared/contracts/job";
import type {
  Activity,
  ActivityActor,
  Agent,
  AgentVersion,
  Artifact,
  ArtifactAuthor,
  ArtifactVersion,
  Department,
  Job,
  JobDependency,
  JobState,
  Membership,
  PolicyVersion,
  ProcessVersion,
  ProjectBinding,
  ProjectDepartment,
} from "../../shared/contracts";
import { parseJson, toJson, type SqlDatabase } from "./sql";

function isClosedJobState(state: JobState): boolean {
  return state === "done" || state === "canceled";
}
import { optionalPluginIds, optionalReasoningEffort, optionalServiceTier, reasoningEffortSchema, serviceTierSchema } from "../../shared/contracts/versions";

type AgentRow = {
  id: string;
  name: string;
  state: Agent["state"];
  current_version_id: string;
  revision: number;
  updated_at: string;
  workplace_binding_id?: string | null;
};

type DepartmentRow = {
  id: string;
  name: string;
  lead_agent_id: string;
  process_version_id: string;
  revision: number;
  updated_at: string;
  availability?: string | null;
  archived_at?: string | null;
};

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
};

type AgentVersionRow = {
  id: string;
  agent_id: string;
  version: number;
  role: string;
  instructions: string;
  provider_id: string;
  model: string;
  skill_ids: string;
  mcp_ids: string;
  policy_version_id: string;
  reasoning_effort?: string | null;
  plugin_ids?: string | null;
  service_tier?: string | null;
};

export function mapStoredAgentVersion(row: AgentVersionRow): AgentVersion {
  const parsed = reasoningEffortSchema.safeParse(row.reasoning_effort);
  return {
    id: row.id,
    agentId: row.agent_id,
    version: row.version,
    role: row.role,
    instructions: row.instructions,
    providerId: row.provider_id,
    model: row.model,
    skillIds: parseJson(row.skill_ids),
    mcpIds: parseJson(row.mcp_ids),
    policyVersionId: row.policy_version_id,
    ...optionalReasoningEffort(parsed.success ? parsed.data : undefined),
    ...optionalPluginIds(row.plugin_ids ? parseJson<string[]>(row.plugin_ids) : undefined),
    ...optionalServiceTier(serviceTierSchema.safeParse(row.service_tier).data),
  };
}

type ArtifactVersionRow = {
  artifact_id: string;
  job_id: string;
  version: number;
  host_id: string;
  relative_path: string;
  mime: string;
  size: number;
  hash: string;
  author: string;
};

export type JobFacts = {
  jobId: string;
  threadBound: boolean;
  confirmedContinuation: boolean;
  openQuestions: boolean;
};

export type RequestRecord = {
  requestId: string;
  kind: string;
  result: unknown;
  payload: unknown;
  actor: unknown;
  scopeBindingIds: readonly string[];
};

function mapAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    currentVersionId: row.current_version_id,
    revision: row.revision,
    updatedAt: row.updated_at,
    ...(row.workplace_binding_id ? { workplaceBindingId: row.workplace_binding_id } : {}),
  };
}

function mapDepartment(row: DepartmentRow): Department {
  return {
    id: row.id,
    name: row.name,
    leadAgentId: row.lead_agent_id,
    processVersionId: row.process_version_id,
    revision: row.revision,
    updatedAt: row.updated_at,
    ...(row.availability === "selected" ? { availability: "selected" as const } : {}),
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
  };
}

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
  };
}

/** A stored contract, or nothing when it is absent, empty or unreadable. */
export function parseContract(raw: string | null | undefined): { contract?: JobContract } {
  if (!raw) return {};
  try {
    const parsed = jobContractSchema.safeParse(JSON.parse(raw));
    return parsed.success && !contractIsEmpty(parsed.data) ? { contract: parsed.data } : {};
  } catch {
    return {};
  }
}

function contractJson(contract: JobContract | null | undefined): string | null {
  return contract && !contractIsEmpty(contract) ? JSON.stringify(contract) : null;
}

export function createRepositories(db: SqlDatabase) {
  return {
    agencyRules: {
      current: () => currentAgencyRules(db),
    },
    policy: {
      insert(row: PolicyVersion): void {
        db.prepare(
          `INSERT INTO agency_policy_version (id, allowed_capabilities, cli_host_constraints, secret_refs)
           VALUES (?, ?, ?, ?)`,
        ).run(row.id, toJson(row.allowedCapabilities), toJson(row.cliHostConstraints), toJson(row.secretRefs));
      },
      get(id: string): PolicyVersion | undefined {
        const row = db.prepare(
          `SELECT id, allowed_capabilities, cli_host_constraints, secret_refs FROM agency_policy_version WHERE id = ?`,
        ).get(id) as
          | { id: string; allowed_capabilities: string; cli_host_constraints: string; secret_refs: string }
          | undefined;
        if (!row) return undefined;
        return {
          id: row.id,
          allowedCapabilities: parseJson(row.allowed_capabilities),
          cliHostConstraints: parseJson(row.cli_host_constraints),
          secretRefs: parseJson(row.secret_refs),
        };
      },
    },
    agent: {
      insert(row: Agent): void {
        db.prepare(
          `INSERT INTO agency_agent (id, name, state, current_version_id, revision, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(row.id, row.name, row.state, row.currentVersionId, row.revision, row.updatedAt);
      },
      update(row: Agent): void {
        db.prepare(
          `UPDATE agency_agent SET name = ?, state = ?, current_version_id = ?, revision = ?, updated_at = ?
           WHERE id = ?`,
        ).run(row.name, row.state, row.currentVersionId, row.revision, row.updatedAt, row.id);
      },
      /** Written separately: older schemas without the column keep working for everything else. */
      setWorkplace(agentId: string, bindingId: string | null): void {
        db.prepare(`UPDATE agency_agent SET workplace_binding_id = ? WHERE id = ?`).run(bindingId, agentId);
      },
      get(id: string): Agent | undefined {
        const row = db.prepare(`SELECT * FROM agency_agent WHERE id = ?`).get(id) as AgentRow | undefined;
        return row ? mapAgent(row) : undefined;
      },
    },
    agentVersion: {
      insert(row: AgentVersion): void {
        const columns: [string, unknown][] = [
          ["id", row.id],
          ["agent_id", row.agentId],
          ["version", row.version],
          ["role", row.role],
          ["instructions", row.instructions],
          ["provider_id", row.providerId],
          ["model", row.model],
          ["skill_ids", toJson(row.skillIds)],
          ["mcp_ids", toJson(row.mcpIds)],
          ["policy_version_id", row.policyVersionId],
          ["reasoning_effort", row.reasoningEffort ?? null],
        ];
        // Optional columns are written only when set, so a plain profile stays valid on an older schema.
        if (row.pluginIds?.length) columns.push(["plugin_ids", toJson(row.pluginIds)]);
        if (row.serviceTier) columns.push(["service_tier", row.serviceTier]);
        db.prepare(
          `INSERT INTO agency_agent_version (${columns.map(([name]) => name).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        ).run(...columns.map(([, value]) => value));
      },
      get(id: string): AgentVersion | undefined {
        const row = db.prepare(`SELECT * FROM agency_agent_version WHERE id = ?`).get(id) as AgentVersionRow | undefined;
        return row ? mapStoredAgentVersion(row) : undefined;
      },
    },
    department: {
      insert(row: Department): void {
        db.prepare(
          `INSERT INTO agency_department (id, name, lead_agent_id, process_version_id, revision, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(row.id, row.name, row.leadAgentId, row.processVersionId, row.revision, row.updatedAt);
      },
      update(row: Department): void {
        db.prepare(
          `UPDATE agency_department SET name = ?, lead_agent_id = ?, process_version_id = ?, revision = ?, updated_at = ?,
             availability = ?
           WHERE id = ?`,
        ).run(row.name, row.leadAgentId, row.processVersionId, row.revision, row.updatedAt, row.availability ?? "all", row.id);
      },
      get(id: string): Department | undefined {
        const row = db.prepare(`SELECT * FROM agency_department WHERE id = ?`).get(id) as DepartmentRow | undefined;
        return row ? mapDepartment(row) : undefined;
      },
    },
    processVersion: {
      insert(row: ProcessVersion): void {
        db.prepare(
          `INSERT INTO agency_process_version (id, department_id, instructions, acceptance, review_policy)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(row.id, row.departmentId, row.instructions, row.acceptance, toJson(row.reviewPolicy));
      },
      get(id: string): ProcessVersion | undefined {
        const row = db.prepare(`SELECT * FROM agency_process_version WHERE id = ?`).get(id) as
          | { id: string; department_id: string; instructions: string; acceptance: string; review_policy: string }
          | undefined;
        if (!row) return undefined;
        return {
          id: row.id,
          departmentId: row.department_id,
          instructions: row.instructions,
          acceptance: row.acceptance,
          reviewPolicy: parseJson(row.review_policy),
        };
      },
    },
    membership: {
      insert(row: Membership): void {
        db.prepare(
          `INSERT INTO agency_membership (department_id, agent_id, role) VALUES (?, ?, ?)`,
        ).run(row.departmentId, row.agentId, row.role);
      },
      listByDepartment(departmentId: string): Membership[] {
        return (
          db.prepare(`SELECT department_id, agent_id, role FROM agency_membership WHERE department_id = ?`).all(
            departmentId,
          ) as Array<{ department_id: string; agent_id: string; role: Membership["role"] }>
        ).map((row) => ({ departmentId: row.department_id, agentId: row.agent_id, role: row.role }));
      },
      remove(departmentId: string, agentId: string): void {
        db.prepare(`DELETE FROM agency_membership WHERE department_id = ? AND agent_id = ?`).run(departmentId, agentId);
      },
      get(departmentId: string, agentId: string): Membership | undefined {
        const row = db.prepare(
          `SELECT department_id, agent_id, role FROM agency_membership WHERE department_id = ? AND agent_id = ?`,
        ).get(departmentId, agentId) as
          | { department_id: string; agent_id: string; role: Membership["role"] }
          | undefined;
        return row
          ? { departmentId: row.department_id, agentId: row.agent_id, role: row.role }
          : undefined;
      },
    },
    binding: {
      insert(row: ProjectBinding): void {
        db.prepare(
          `INSERT INTO agency_project_binding
            (id, bb_project_id, environment_id, host_id, canonical_root, policy_version_id, section_id, revision, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.id,
          row.bbProjectId,
          row.environmentId,
          row.hostId,
          row.canonicalRoot,
          row.policyVersionId,
          row.sectionId,
          row.revision,
          row.updatedAt,
        );
      },
      update(row: ProjectBinding): void {
        db.prepare(
          `UPDATE agency_project_binding
           SET section_id = ?, policy_version_id = ?, revision = ?, updated_at = ?, archived_at = ?
           WHERE id = ?`,
        ).run(row.sectionId, row.policyVersionId, row.revision, row.updatedAt, row.archivedAt ?? null, row.id);
      },
      /** Only for a binding without jobs: removes its department links, then the binding. */
      delete(id: string): void {
        db.prepare(`DELETE FROM agency_project_department WHERE binding_id = ?`).run(id);
        db.prepare(`DELETE FROM agency_project_binding WHERE id = ?`).run(id);
      },
      usage(id: string): { jobs: number; publishIntents: number } {
        const jobs = db.prepare(`SELECT COUNT(*) AS n FROM agency_job WHERE binding_id = ?`).get(id) as { n: number };
        const intents = db
          .prepare(`SELECT COUNT(*) AS n FROM agency_artifact_publish_intent WHERE binding_id = ?`)
          .get(id) as { n: number };
        return { jobs: jobs.n, publishIntents: intents.n };
      },
      findActiveByPlacement(environmentId: string, canonicalRoot: string): ProjectBinding | undefined {
        // Filter in code: also readable on a database migrated before archived_at existed.
        const rows = db
          .prepare(
            `SELECT * FROM agency_project_binding WHERE environment_id = ? AND canonical_root = ? ORDER BY updated_at`,
          )
          .all(environmentId, canonicalRoot) as BindingRow[];
        const row = rows.find((candidate) => !candidate.archived_at);
        return row ? mapBinding(row) : undefined;
      },
      get(id: string): ProjectBinding | undefined {
        const row = db.prepare(`SELECT * FROM agency_project_binding WHERE id = ?`).get(id) as BindingRow | undefined;
        return row ? mapBinding(row) : undefined;
      },
    },
    projectDepartment: {
      insert(row: ProjectDepartment): void {
        db.prepare(
          `INSERT INTO agency_project_department (binding_id, department_id) VALUES (?, ?)`,
        ).run(row.bindingId, row.departmentId);
      },
      remove(bindingId: string, departmentId: string): boolean {
        return (
          db
            .prepare(`DELETE FROM agency_project_department WHERE binding_id = ? AND department_id = ?`)
            .run(bindingId, departmentId).changes > 0
        );
      },
      listByDepartment(departmentId: string): ProjectDepartment[] {
        return (
          db.prepare(`SELECT binding_id, department_id FROM agency_project_department WHERE department_id = ?`).all(
            departmentId,
          ) as Array<{ binding_id: string; department_id: string }>
        ).map((row) => ({ bindingId: row.binding_id, departmentId: row.department_id }));
      },
      listByBinding(bindingId: string): ProjectDepartment[] {
        return (
          db.prepare(`SELECT binding_id, department_id FROM agency_project_department WHERE binding_id = ?`).all(
            bindingId,
          ) as Array<{ binding_id: string; department_id: string }>
        ).map((row) => ({ bindingId: row.binding_id, departmentId: row.department_id }));
      },
    },
    job: {
      insert(row: Job): void {
        db.prepare(
          `INSERT INTO agency_job
            (id, key, binding_id, department_id, title, brief, acceptance, state, parent_job_id,
             assigned_agent_id, reviewer_agent_ids, observer_agent_ids, priority, due_at, revision, updated_at,
             closed_at, contract_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.id,
          row.key,
          row.bindingId,
          row.departmentId,
          row.title,
          row.brief,
          row.acceptance,
          row.state,
          row.parentJobId,
          row.assignedAgentId,
          toJson(row.reviewerAgentIds ?? []),
          toJson(row.observerAgentIds ?? []),
          row.priority,
          row.dueAt,
          row.revision,
          row.updatedAt,
          isClosedJobState(row.state) ? row.updatedAt : null,
          contractJson(row.contract),
        );
      },
      update(row: Job): void {
        db.prepare(
          `UPDATE agency_job SET
            closed_at = CASE WHEN ? = 0 THEN NULL WHEN state = ? THEN COALESCE(closed_at, ?) ELSE ? END,
            title = ?, brief = ?, acceptance = ?, state = ?, binding_id = ?, department_id = ?,
            assigned_agent_id = ?, reviewer_agent_ids = ?, observer_agent_ids = ?, priority = ?, due_at = ?, revision = ?, updated_at = ?,
            contract_json = ?
           WHERE id = ?`,
        ).run(
          isClosedJobState(row.state) ? 1 : 0,
          row.state,
          row.updatedAt,
          row.updatedAt,
          row.title,
          row.brief,
          row.acceptance,
          row.state,
          row.bindingId,
          row.departmentId,
          row.assignedAgentId,
          toJson(row.reviewerAgentIds ?? []),
          toJson(row.observerAgentIds ?? []),
          row.priority,
          row.dueAt,
          row.revision,
          row.updatedAt,
          contractJson(row.contract),
          row.id,
        );
      },
      get(id: string): Job | undefined {
        const row = db.prepare(`SELECT * FROM agency_job WHERE id = ?`).get(id) as JobRow | undefined;
        return row ? mapJob(row) : undefined;
      },
      /** Next free AG-N; call inside the create transaction. */
      nextKey(): Job["key"] {
        const row = db
          .prepare(`SELECT MAX(CAST(SUBSTR(key, 4) AS INTEGER)) AS n FROM agency_job WHERE key LIKE 'AG-%'`)
          .get() as { n: number | null } | undefined;
        return `AG-${(row?.n ?? 0) + 1}` as Job["key"];
      },
      getByKey(key: string): Job | undefined {
        const row = db.prepare(`SELECT * FROM agency_job WHERE key = ?`).get(key) as JobRow | undefined;
        return row ? mapJob(row) : undefined;
      },
    },
    dependency: {
      insert(row: JobDependency): void {
        db.prepare(
          `INSERT INTO agency_job_dependency (job_id, depends_on_job_id) VALUES (?, ?)`,
        ).run(row.jobId, row.dependsOnJobId);
      },
      listAll(): JobDependency[] {
        return (
          db.prepare(`SELECT job_id, depends_on_job_id FROM agency_job_dependency`).all() as Array<{
            job_id: string;
            depends_on_job_id: string;
          }>
        ).map((row) => ({ jobId: row.job_id, dependsOnJobId: row.depends_on_job_id }));
      },
      listByJob(jobId: string): JobDependency[] {
        return (
          db.prepare(`SELECT job_id, depends_on_job_id FROM agency_job_dependency WHERE job_id = ?`).all(jobId) as Array<{
            job_id: string;
            depends_on_job_id: string;
          }>
        ).map((row) => ({ jobId: row.job_id, dependsOnJobId: row.depends_on_job_id }));
      },
    },
    facts: {
      insert(jobId: string): void {
        db.prepare(
          `INSERT INTO agency_job_facts (job_id, thread_bound, confirmed_continuation, open_questions)
           VALUES (?, 0, 0, 0)`,
        ).run(jobId);
      },
      get(jobId: string): JobFacts | undefined {
        const row = db.prepare(`SELECT * FROM agency_job_facts WHERE job_id = ?`).get(jobId) as
          | { job_id: string; thread_bound: number; confirmed_continuation: number; open_questions: number }
          | undefined;
        if (!row) return undefined;
        return {
          jobId: row.job_id,
          threadBound: row.thread_bound === 1,
          confirmedContinuation: row.confirmed_continuation === 1,
          openQuestions: row.open_questions === 1,
        };
      },
      update(facts: JobFacts): void {
        db.prepare(
          `UPDATE agency_job_facts SET thread_bound = ?, confirmed_continuation = ?, open_questions = ?
           WHERE job_id = ?`,
        ).run(facts.threadBound ? 1 : 0, facts.confirmedContinuation ? 1 : 0, facts.openQuestions ? 1 : 0, facts.jobId);
      },
    },
    artifact: {
      insert(row: Artifact): void {
        db.prepare(`INSERT INTO agency_artifact (id, job_id) VALUES (?, ?)`).run(row.id, row.jobId);
      },
      get(id: string): Artifact | undefined {
        const row = db.prepare(`SELECT id, job_id FROM agency_artifact WHERE id = ?`).get(id) as
          | { id: string; job_id: string }
          | undefined;
        return row ? { id: row.id, jobId: row.job_id } : undefined;
      },
    },
    artifactVersion: {
      insert(row: ArtifactVersion): void {
        db.prepare(
          `INSERT INTO agency_artifact_version
            (artifact_id, job_id, version, host_id, relative_path, mime, size, hash, author)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.artifactId,
          row.jobId,
          row.version,
          row.hostId,
          row.relativePath,
          row.mime,
          row.size,
          row.hash,
          toJson(row.author),
        );
      },
      listByScope(artifactId: string, jobId: string): ArtifactVersion[] {
        return (
          db.prepare(
            `SELECT * FROM agency_artifact_version WHERE artifact_id = ? AND job_id = ? ORDER BY version`,
          ).all(artifactId, jobId) as ArtifactVersionRow[]
        ).map((row) => ({
          artifactId: row.artifact_id,
          jobId: row.job_id,
          version: row.version,
          hostId: row.host_id,
          relativePath: row.relative_path,
          mime: row.mime,
          size: row.size,
          hash: row.hash,
          author: parseJson<ArtifactAuthor>(row.author),
        }));
      },
      get(artifactId: string, jobId: string, version: number): ArtifactVersion | undefined {
        const row = db.prepare(
          `SELECT * FROM agency_artifact_version WHERE artifact_id = ? AND job_id = ? AND version = ?`,
        ).get(artifactId, jobId, version) as ArtifactVersionRow | undefined;
        if (!row) return undefined;
        return {
          artifactId: row.artifact_id,
          jobId: row.job_id,
          version: row.version,
          hostId: row.host_id,
          relativePath: row.relative_path,
          mime: row.mime,
          size: row.size,
          hash: row.hash,
          author: parseJson<ArtifactAuthor>(row.author),
        };
      },
    },
    activity: {
      insert(row: Activity): void {
        db.prepare(
          `INSERT INTO agency_activity
            (id, job_id, actor, kind, causation_id, timestamp, references_json, comment)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.id,
          row.jobId,
          toJson(row.actor),
          row.kind,
          row.causationId,
          row.timestamp,
          toJson(row.references),
          row.comment ?? null,
        );
      },
      listByJob(jobId: string): Activity[] {
        return (
          db.prepare(`SELECT * FROM agency_activity WHERE job_id = ? ORDER BY timestamp`).all(jobId) as Array<{
            id: string;
            job_id: string;
            actor: string;
            kind: string;
            causation_id: string | null;
            timestamp: string;
            references_json: string;
            comment: string | null;
          }>
        ).map((row) => ({
          id: row.id,
          jobId: row.job_id,
          actor: parseJson<ActivityActor>(row.actor),
          kind: row.kind,
          causationId: row.causation_id,
          timestamp: row.timestamp,
          references: parseJson(row.references_json),
          ...(row.comment ? { comment: row.comment } : {}),
        }));
      },
    },
    request: {
      get(requestId: string): RequestRecord | undefined {
        const row = db.prepare(
          `SELECT request_id, kind, result_json, payload_json, actor_json, scope_json
           FROM agency_request WHERE request_id = ?`,
        ).get(requestId) as
          | {
              request_id: string;
              kind: string;
              result_json: string;
              payload_json: string;
              actor_json: string;
              scope_json: string;
            }
          | undefined;
        return row
          ? {
              requestId: row.request_id,
              kind: row.kind,
              result: parseJson(row.result_json),
              payload: parseJson(row.payload_json),
              actor: parseJson(row.actor_json),
              scopeBindingIds: parseJson(row.scope_json),
            }
          : undefined;
      },
      insert(
        requestId: string,
        kind: string,
        result: unknown,
        payload: unknown,
        actor: unknown,
        scopeBindingIds: readonly string[],
        createdAt: string,
      ): void {
        db.prepare(
          `INSERT INTO agency_request
            (request_id, kind, result_json, created_at, payload_json, actor_json, scope_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(requestId, kind, toJson(result), createdAt, toJson(payload), toJson(actor), toJson(scopeBindingIds));
      },
      updateResult(requestId: string, kind: string, result: unknown): void {
        db.prepare(`UPDATE agency_request SET result_json = ? WHERE request_id = ? AND kind = ?`).run(
          toJson(result),
          requestId,
          kind,
        );
      },
    },
    inbox: {
      count(): number {
        return (db.prepare("SELECT count(*) AS n FROM agency_inbox").get() as { n: number }).n;
      },
    },
    publishIntent: {
      insert(row: DurablePublishIntent): void {
        db.prepare(
          `INSERT INTO agency_artifact_publish_intent
            (request_id, artifact_id, job_id, binding_id, host_id, canonical_root, binding_revision,
             relative_path, mime, size, hash, author, version, state, failure_code, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.requestId,
          row.artifactId,
          row.jobId,
          row.bindingId,
          row.hostId,
          row.canonicalRoot,
          row.bindingRevision,
          row.relativePath,
          row.mime,
          row.size,
          row.hash,
          toJson(row.author),
          row.version,
          row.state,
          row.failureCode ?? null,
          row.createdAt,
        );
      },
      update(row: DurablePublishIntent): void {
        db.prepare(
          `UPDATE agency_artifact_publish_intent
           SET state = ?, failure_code = ?
           WHERE request_id = ?`,
        ).run(row.state, row.failureCode ?? null, row.requestId);
      },
      get(requestId: string): DurablePublishIntent | undefined {
        const row = db.prepare(`SELECT * FROM agency_artifact_publish_intent WHERE request_id = ?`).get(requestId) as
          | PublishIntentRow
          | undefined;
        return row ? mapIntent(row) : undefined;
      },
      listPending(): DurablePublishIntent[] {
        return (
          db.prepare(`SELECT * FROM agency_artifact_publish_intent WHERE state = 'pending'`).all() as PublishIntentRow[]
        ).map(mapIntent);
      },
      maxReservedVersion(artifactId: string, jobId: string): number {
        const row = db.prepare(
          `SELECT MAX(version) AS n FROM agency_artifact_publish_intent WHERE artifact_id = ? AND job_id = ?`,
        ).get(artifactId, jobId) as { n: number | null };
        return row.n ?? 0;
      },
    },
  };
}

type PublishIntentRow = {
  request_id: string;
  artifact_id: string;
  job_id: string;
  binding_id: string;
  host_id: string;
  canonical_root: string;
  binding_revision: number;
  relative_path: string;
  mime: string;
  size: number;
  hash: string;
  author: string;
  version: number;
  state: DurablePublishIntent["state"];
  failure_code: string | null;
  created_at: string;
};

export type DurablePublishIntent = {
  requestId: string;
  artifactId: string;
  jobId: string;
  bindingId: string;
  hostId: string;
  canonicalRoot: string;
  bindingRevision: number;
  relativePath: string;
  mime: string;
  size: number;
  hash: string;
  author: ArtifactAuthor;
  version: number;
  state: "pending" | "committed" | "failed";
  failureCode?: string;
  createdAt: string;
};

function mapIntent(row: PublishIntentRow): DurablePublishIntent {
  return {
    requestId: row.request_id,
    artifactId: row.artifact_id,
    jobId: row.job_id,
    bindingId: row.binding_id,
    hostId: row.host_id,
    canonicalRoot: row.canonical_root,
    bindingRevision: row.binding_revision,
    relativePath: row.relative_path,
    mime: row.mime,
    size: row.size,
    hash: row.hash,
    author: parseJson<ArtifactAuthor>(row.author),
    version: row.version,
    state: row.state,
    failureCode: row.failure_code ?? undefined,
    createdAt: row.created_at,
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
