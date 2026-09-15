import { createHash } from "node:crypto";
import { z } from "zod";
import { fail, ok, type DomainResult } from "../../../domain";
import {
  agentSchema,
  bbProjectIdSchema,
  canonicalRootSchema,
  createJobCommandSchema,
  departmentSchema,
  hostIdSchema,
  jobKeySchema,
  membershipSchema,
  opaqueIdSchema,
  projectBindingSchema,
  projectDepartmentSchema,
  requestIdSchema,
  revisionSchema,
  type CreateJobCommand,
  type JobPriority,
} from "../../../shared/contracts";
import { uuidV5 } from "../../runtime/launch/operation-ids.js";
import { sourceTaskIdentity, TASKS_IMPORT_PLAN_VERSION, TASKS_PLUGIN_SOURCE, tasksIdSchema } from "./adapter.js";
import type { JsonValue, PlanIssue, TasksImportConflict } from "./types.js";

const PLANNER_MAPPING_GAPS = new Set([
  "missing_acceptance",
  "missing_binding",
  "missing_department",
  "missing_assignee",
]);

const projectMappingSchema = z
  .object({
    sourceProjectId: tasksIdSchema,
    bindingId: opaqueIdSchema,
    departmentId: opaqueIdSchema,
    expectedBindingRevision: revisionSchema,
    expectedDepartmentRevision: revisionSchema,
  })
  .strict();

const taskMappingSchema = z
  .object({
    sourceTaskId: tasksIdSchema,
    assignedAgentId: opaqueIdSchema,
    expectedAgentRevision: revisionSchema,
    acceptance: z.string().trim().min(1).max(20_000),
    jobKey: jobKeySchema,
  })
  .strict();

const workspaceSchema = z
  .object({
    bindings: z.array(projectBindingSchema),
    departments: z.array(departmentSchema),
    agents: z.array(agentSchema),
    memberships: z.array(membershipSchema),
    projectDepartments: z.array(projectDepartmentSchema),
  })
  .strict();

const mappingsSchema = z
  .object({
    batchId: requestIdSchema,
    expectedHostId: hostIdSchema,
    expectedCanonicalRoot: canonicalRootSchema,
    claimedBbProjectId: bbProjectIdSchema.optional(),
    workspace: workspaceSchema,
    projects: z.array(projectMappingSchema),
    tasks: z.array(taskMappingSchema),
  })
  .strict();

const planIssueSchema = z
  .object({
    code: z.string(),
    field: z.string().nullable(),
    message: z.string(),
    sourceValue: z.unknown(),
  })
  .passthrough();

const planConflictSchema = z
  .object({
    code: z.string(),
    sourceIdentity: z.string().nullable(),
    sourceTaskId: z.string().nullable(),
    message: z.string(),
    sourceValue: z.unknown(),
  })
  .passthrough();

const planItemSchema = z
  .object({
    sourceIdentity: z.string().min(1),
    sourceTaskId: z.string().min(1),
    source: z
      .object({
        id: z.string().min(1),
        projectId: z.string().min(1),
        status: z.string().min(1),
        parentTaskId: z.string().nullable().optional(),
      })
      .passthrough(),
    proposed: z
      .object({
        title: z.string().nullable(),
        brief: z.string().nullable(),
        parentSourceIdentity: z.string().nullable(),
        priority: z.enum(["low", "normal", "high", "urgent"]).nullable(),
        dueAt: z.null(),
        acceptArtifact: z.literal(false),
      })
      .passthrough(),
    blockers: z.array(planIssueSchema),
  })
  .passthrough();

const planSchema = z
  .object({
    schemaVersion: z.literal(TASKS_IMPORT_PLAN_VERSION),
    source: z.literal(TASKS_PLUGIN_SOURCE),
    dryRun: z.literal(true),
    mutatesDatabase: z.literal(false),
    applyOrder: z.array(z.string().min(1)),
    items: z.array(planItemSchema),
    conflicts: z.array(planConflictSchema),
    globalBlockers: z.array(planIssueSchema),
  })
  .passthrough();

type PlanItem = z.infer<typeof planItemSchema>;
type Plan = z.infer<typeof planSchema>;

export type TasksImportMappings = z.infer<typeof mappingsSchema>;

export type DeferredCreateJob = {
  parentSourceIdentity: string;
  payload: {
    key: string;
    bindingId: string;
    departmentId: string;
    title: string;
    brief: string;
    acceptance: string;
    assignedAgentId: string;
    priority: JobPriority;
    dueAt: null;
  };
  contentPin: string;
};

export type ResolvedImportItem = {
  sourceIdentity: string;
  sourceTaskId: string;
  parentSourceIdentity: string | null;
  bindingId: string | null;
  departmentId: string | null;
  assignedAgentId: string | null;
  acceptance: string | null;
  jobKey: string | null;
  createJobReady: boolean;
  blockers: readonly PlanIssue[];
  createJob: CreateJobCommand | null;
  deferred: DeferredCreateJob | null;
};

export type TasksImportResolution = {
  schemaVersion: typeof TASKS_IMPORT_PLAN_VERSION;
  source: typeof TASKS_PLUGIN_SOURCE;
  dryRun: true;
  mutatesDatabase: false;
  disablesTasks: false;
  createsAcceptedArtifacts: false;
  applyOrder: readonly string[];
  items: readonly ResolvedImportItem[];
  drafts: readonly CreateJobCommand[];
  conflicts: readonly TasksImportConflict[];
  globalBlockers: readonly PlanIssue[];
  summary: {
    tasks: number;
    createJobReady: number;
    drafts: number;
  };
};

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = jsonValue(Reflect.get(value, key));
    }
    return out;
  }
  return String(value);
}

function issue(code: string, field: string | null, sourceValue: unknown): PlanIssue {
  return { code, field, message: code, sourceValue: jsonValue(sourceValue) };
}

function asIssue(row: z.infer<typeof planIssueSchema>): PlanIssue {
  return {
    code: row.code,
    field: row.field,
    message: row.message,
    sourceValue: jsonValue(row.sourceValue),
  };
}

function asConflict(row: z.infer<typeof planConflictSchema>): TasksImportConflict {
  return {
    code: row.code,
    sourceIdentity: row.sourceIdentity,
    sourceTaskId: row.sourceTaskId,
    message: row.message,
    sourceValue: jsonValue(row.sourceValue),
  };
}

function compareIssue(a: PlanIssue, b: PlanIssue): number {
  return a.code < b.code ? -1 : a.code > b.code ? 1 : (a.field ?? "").localeCompare(b.field ?? "");
}

function compareConflict(a: TasksImportConflict, b: TasksImportConflict): number {
  const code = a.code.localeCompare(b.code);
  if (code !== 0) return code;
  return (a.sourceTaskId ?? "").localeCompare(b.sourceTaskId ?? "");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const sorted: { [key: string]: unknown } = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalValue(Reflect.get(value, key));
    }
    return sorted;
  }
  return value;
}

function contentRevision(value: unknown): string {
  return createHash("sha1").update(canonicalJson(value), "utf8").digest("hex");
}

function createJobRequestId(batchId: string, sourceIdentity: string, revision: string): string {
  return uuidV5(batchId, `agency.tasks-import.createJob:${sourceIdentity}:${revision}`);
}

function commandPin(input: {
  payload: DeferredCreateJob["payload"];
  parentSourceIdentity: string | null;
  parentJobId: string | null;
}): string {
  return contentRevision({
    ...input.payload,
    parentSourceIdentity: input.parentSourceIdentity,
    parentJobId: input.parentJobId,
  });
}

function duplicateKeys(ids: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dup.add(id);
    else seen.add(id);
  }
  return dup;
}

function uniqueById<T extends { id: string }>(rows: readonly T[]): DomainResult<Map<string, T>> {
  if (duplicateKeys(rows.map((row) => row.id)).size > 0) {
    return fail("duplicate_workspace_id", "duplicate_workspace_id");
  }
  const map = new Map<string, T>();
  for (const row of rows) map.set(row.id, row);
  return ok(map);
}

function conflict(
  code: string,
  sourceIdentity: string | null,
  sourceTaskId: string | null,
  sourceValue: unknown,
): TasksImportConflict {
  return { code, sourceIdentity, sourceTaskId, message: code, sourceValue: jsonValue(sourceValue) };
}

function mappedPayload(
  fields: {
    bindingId: string | null;
    departmentId: string | null;
    assignedAgentId: string | null;
    acceptance: string | null;
    jobKey: string | null;
  },
  title: string | null,
  brief: string | null,
  priority: JobPriority | null,
  dueAt: null,
): DeferredCreateJob["payload"] | null {
  if (
    fields.bindingId === null ||
    fields.departmentId === null ||
    fields.assignedAgentId === null ||
    fields.acceptance === null ||
    fields.jobKey === null ||
    title === null ||
    brief === null ||
    priority === null
  ) {
    return null;
  }
  return {
    key: fields.jobKey,
    bindingId: fields.bindingId,
    departmentId: fields.departmentId,
    title,
    brief,
    acceptance: fields.acceptance,
    assignedAgentId: fields.assignedAgentId,
    priority,
    dueAt,
  };
}

function expectedParentIdentity(item: PlanItem): string | null {
  const parentTaskId = item.source.parentTaskId;
  if (typeof parentTaskId === "string" && parentTaskId.length > 0) return sourceTaskIdentity(parentTaskId);
  return null;
}

function assertPlanInvariants(plan: Plan): DomainResult<true> {
  const identities = plan.items.map((item) => item.sourceIdentity);
  if (duplicateKeys(identities).size > 0) return fail("inconsistent_plan", "duplicate_identity");
  if (duplicateKeys(plan.items.map((item) => item.sourceTaskId)).size > 0) {
    return fail("inconsistent_plan", "duplicate_source_task");
  }
  for (const item of plan.items) {
    if (item.source.id !== item.sourceTaskId) return fail("inconsistent_plan", "mismatched_source_id");
    if (item.sourceIdentity !== sourceTaskIdentity(item.sourceTaskId)) {
      return fail("inconsistent_plan", "mismatched_source_identity");
    }
    if ((item.proposed.parentSourceIdentity ?? null) !== expectedParentIdentity(item)) {
      return fail("inconsistent_plan", "mismatched_parent_identity");
    }
  }
  if (duplicateKeys(plan.applyOrder).size > 0) return fail("inconsistent_plan", "duplicate_apply_order");
  const itemSet = new Set(identities);
  for (const identity of plan.applyOrder) {
    if (!itemSet.has(identity)) return fail("inconsistent_plan", "missing_apply_order_ref");
  }
  return ok(true);
}

/**
 * Payload validation of explicit Tasks → Agency mappings against supplied
 * workspace records. Not an access/permission proof. No DB writes.
 */
export function resolveTasksImport(planInput: unknown, explicitMappings: unknown): DomainResult<TasksImportResolution> {
  const planParsed = planSchema.safeParse(planInput);
  if (!planParsed.success) return fail("invalid_plan", "schema_invalid");
  const mappingsParsed = mappingsSchema.safeParse(explicitMappings);
  if (!mappingsParsed.success) return fail("invalid_mappings", "schema_invalid");

  const plan = planParsed.data;
  const consistent = assertPlanInvariants(plan);
  if (!consistent.ok) return consistent;
  const mappings = mappingsParsed.data;

  const projectIdsInPlan = new Set(plan.items.map((item) => item.source.projectId));
  const taskIdsInPlan = new Set(plan.items.map((item) => item.sourceTaskId));

  const duplicateProjects = duplicateKeys(mappings.projects.map((row) => row.sourceProjectId));
  const duplicateTasks = duplicateKeys(mappings.tasks.map((row) => row.sourceTaskId));
  const duplicateJobKeys = duplicateKeys(mappings.tasks.map((row) => row.jobKey));

  const conflicts: TasksImportConflict[] = plan.conflicts.map(asConflict);
  for (const id of [...duplicateProjects].sort()) {
    conflicts.push(conflict("duplicate_project_mapping", null, null, id));
  }
  for (const id of [...duplicateTasks].sort()) {
    conflicts.push(conflict("duplicate_task_mapping", sourceTaskIdentity(id), id, id));
  }
  for (const key of [...duplicateJobKeys].sort()) {
    conflicts.push(conflict("duplicate_job_key", null, null, key));
  }
  for (const row of mappings.projects) {
    if (!projectIdsInPlan.has(row.sourceProjectId)) {
      conflicts.push(conflict("unknown_project_mapping", null, null, row.sourceProjectId));
    }
  }
  for (const row of mappings.tasks) {
    if (!taskIdsInPlan.has(row.sourceTaskId)) {
      conflicts.push(conflict("unknown_task_mapping", sourceTaskIdentity(row.sourceTaskId), row.sourceTaskId, row.sourceTaskId));
    }
  }
  conflicts.sort(compareConflict);

  const projectBySource = new Map<string, z.infer<typeof projectMappingSchema>>();
  for (const row of mappings.projects) {
    if (duplicateProjects.has(row.sourceProjectId) || !projectIdsInPlan.has(row.sourceProjectId)) continue;
    projectBySource.set(row.sourceProjectId, row);
  }
  const taskBySource = new Map<string, z.infer<typeof taskMappingSchema>>();
  for (const row of mappings.tasks) {
    if (duplicateTasks.has(row.sourceTaskId) || duplicateJobKeys.has(row.jobKey) || !taskIdsInPlan.has(row.sourceTaskId)) {
      continue;
    }
    taskBySource.set(row.sourceTaskId, row);
  }

  const bindings = uniqueById(mappings.workspace.bindings);
  if (!bindings.ok) return bindings;
  const departments = uniqueById(mappings.workspace.departments);
  if (!departments.ok) return departments;
  const agents = uniqueById(mappings.workspace.agents);
  if (!agents.ok) return agents;
  const memberships = mappings.workspace.memberships;
  const links = mappings.workspace.projectDepartments;

  const itemsByIdentity = new Map(plan.items.map((item) => [item.sourceIdentity, item]));
  const blockedByIdentity = new Map<string, PlanIssue[]>();
  const resolvedFields = new Map<
    string,
    {
      bindingId: string | null;
      departmentId: string | null;
      assignedAgentId: string | null;
      acceptance: string | null;
      jobKey: string | null;
      parentSourceIdentity: string | null;
    }
  >();

  for (const item of plan.items) {
    const identity = item.sourceIdentity;
    const blockers: PlanIssue[] = item.blockers
      .filter((row) => !PLANNER_MAPPING_GAPS.has(row.code))
      .map(asIssue);

    let bindingId: string | null = null;
    let departmentId: string | null = null;
    let assignedAgentId: string | null = null;
    let acceptance: string | null = null;
    let jobKey: string | null = null;
    const parentSourceIdentity = item.proposed.parentSourceIdentity;

    const projectMap = projectBySource.get(item.source.projectId);
    if (!projectMap) {
      blockers.push(issue("missing_project_mapping", "bindingId", item.source.projectId));
    } else {
      const binding = bindings.value.get(projectMap.bindingId);
      const department = departments.value.get(projectMap.departmentId);
      if (!binding) {
        blockers.push(issue("binding_not_found", "bindingId", projectMap.bindingId));
      } else if (binding.revision !== projectMap.expectedBindingRevision) {
        blockers.push(
          issue("stale_binding", "expectedBindingRevision", {
            expected: projectMap.expectedBindingRevision,
            actual: binding.revision,
          }),
        );
      } else if (
        binding.hostId !== mappings.expectedHostId ||
        binding.canonicalRoot !== mappings.expectedCanonicalRoot
      ) {
        blockers.push(
          issue("foreign_binding", "bindingId", {
            hostId: binding.hostId,
            canonicalRoot: binding.canonicalRoot,
          }),
        );
      } else if (
        mappings.claimedBbProjectId !== undefined &&
        mappings.claimedBbProjectId !== binding.bbProjectId
      ) {
        blockers.push(issue("foreign_binding", "claimedBbProjectId", mappings.claimedBbProjectId));
      } else {
        bindingId = binding.id;
      }

      if (!department) {
        blockers.push(issue("department_not_found", "departmentId", projectMap.departmentId));
      } else if (department.revision !== projectMap.expectedDepartmentRevision) {
        blockers.push(
          issue("stale_department", "expectedDepartmentRevision", {
            expected: projectMap.expectedDepartmentRevision,
            actual: department.revision,
          }),
        );
      } else if (bindingId !== null) {
        const linked = links.some((row) => row.bindingId === bindingId && row.departmentId === department.id);
        if (!linked) {
          blockers.push(issue("department_not_on_binding", "departmentId", department.id));
        } else {
          departmentId = department.id;
        }
      }
    }

    const taskMap = taskBySource.get(item.sourceTaskId);
    if (!taskMap) {
      blockers.push(issue("missing_task_mapping", "assignedAgentId", item.sourceTaskId));
    } else {
      const agent = agents.value.get(taskMap.assignedAgentId);
      if (!agent) {
        blockers.push(issue("agent_not_found", "assignedAgentId", taskMap.assignedAgentId));
      } else if (agent.revision !== taskMap.expectedAgentRevision) {
        blockers.push(
          issue("stale_agent", "expectedAgentRevision", {
            expected: taskMap.expectedAgentRevision,
            actual: agent.revision,
          }),
        );
      } else if (departmentId !== null) {
        const member = memberships.some((row) => row.departmentId === departmentId && row.agentId === agent.id);
        if (!member) {
          blockers.push(issue("assignee_not_member", "assignedAgentId", agent.id));
        } else {
          assignedAgentId = agent.id;
        }
      }
      acceptance = taskMap.acceptance;
      jobKey = taskMap.jobKey;
      if (parentSourceIdentity !== null) {
        blockers.push(issue("parent_binding_pending", "parentSourceIdentity", parentSourceIdentity));
      }
    }

    if (item.proposed.priority === null) {
      blockers.push(issue("unmapped_priority", "priority", null));
    }
    if (item.source.status === "done") {
      blockers.push(issue("needs_archival_policy", "status", item.source.status));
    } else if (item.source.status === "canceled") {
      blockers.push(issue("canceled_not_imported", "status", item.source.status));
    }

    blockers.sort(compareIssue);
    blockedByIdentity.set(identity, blockers);
    resolvedFields.set(identity, {
      bindingId,
      departmentId,
      assignedAgentId,
      acceptance,
      jobKey,
      parentSourceIdentity,
    });
  }

  const blocked = new Set(
    [...blockedByIdentity.entries()].filter(([, rows]) => rows.length > 0).map(([identity]) => identity),
  );
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of plan.items) {
      const parentId = item.proposed.parentSourceIdentity;
      if (!parentId) continue;
      const rows = blockedByIdentity.get(item.sourceIdentity) ?? [];
      let added = false;
      if (!itemsByIdentity.has(parentId)) {
        if (!rows.some((row) => row.code === "missing_parent")) {
          rows.push(issue("missing_parent", "parentSourceIdentity", parentId));
          added = true;
        }
      } else if (blocked.has(parentId) && !rows.some((row) => row.code === "parent_blocked")) {
        rows.push(issue("parent_blocked", "parentSourceIdentity", parentId));
        added = true;
      }
      if (added) {
        rows.sort(compareIssue);
        blockedByIdentity.set(item.sourceIdentity, rows);
        grew = true;
      }
      if (rows.length > 0) blocked.add(item.sourceIdentity);
    }
  }

  const items: ResolvedImportItem[] = [];
  const drafts: CreateJobCommand[] = [];
  for (const item of plan.items) {
    const identity = item.sourceIdentity;
    const blockers = blockedByIdentity.get(identity) ?? [];
    const fields = resolvedFields.get(identity) ?? {
      bindingId: null,
      departmentId: null,
      assignedAgentId: null,
      acceptance: null,
      jobKey: null,
      parentSourceIdentity: null,
    };
    let createJob: CreateJobCommand | null = null;
    let deferred: DeferredCreateJob | null = null;
    const payload = mappedPayload(
      fields,
      item.proposed.title,
      item.proposed.brief,
      item.proposed.priority,
      item.proposed.dueAt,
    );
    if (payload !== null && fields.parentSourceIdentity !== null) {
      deferred = {
        parentSourceIdentity: fields.parentSourceIdentity,
        payload,
        contentPin: commandPin({
          payload,
          parentSourceIdentity: fields.parentSourceIdentity,
          parentJobId: null,
        }),
      };
    } else if (
      payload !== null &&
      fields.parentSourceIdentity === null &&
      item.source.status === "backlog" &&
      blockers.length === 0 &&
      item.proposed.acceptArtifact === false
    ) {
      const pin = commandPin({
        payload,
        parentSourceIdentity: null,
        parentJobId: null,
      });
      const draft = {
        requestId: createJobRequestId(mappings.batchId, identity, pin),
        ...payload,
        parentJobId: null,
      };
      const parsed = createJobCommandSchema.safeParse(draft);
      if (!parsed.success) {
        blockers.push(issue("invalid_create_job", null, "schema_invalid"));
        blockers.sort(compareIssue);
      } else {
        createJob = parsed.data;
        drafts.push(parsed.data);
      }
    }

    items.push({
      sourceIdentity: identity,
      sourceTaskId: item.sourceTaskId,
      parentSourceIdentity: fields.parentSourceIdentity,
      bindingId: fields.bindingId,
      departmentId: fields.departmentId,
      assignedAgentId: fields.assignedAgentId,
      acceptance: fields.acceptance,
      jobKey: fields.jobKey,
      createJobReady: createJob !== null,
      blockers,
      createJob,
      deferred,
    });
  }

  return ok({
    schemaVersion: TASKS_IMPORT_PLAN_VERSION,
    source: TASKS_PLUGIN_SOURCE,
    dryRun: true,
    mutatesDatabase: false,
    disablesTasks: false,
    createsAcceptedArtifacts: false,
    applyOrder: plan.applyOrder,
    items,
    drafts,
    conflicts,
    globalBlockers: plan.globalBlockers.map(asIssue),
    summary: {
      tasks: items.length,
      createJobReady: items.filter((row) => row.createJobReady).length,
      drafts: drafts.length,
    },
  });
}
