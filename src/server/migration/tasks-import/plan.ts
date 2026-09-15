import { fail, ok, type DomainResult } from "../../../domain";
import {
  expectedTaskKey,
  mapJobState,
  mapPriority,
  proposedBrief,
  proposedJobKey,
  proposedTitle,
  sourceTaskIdentity,
  TASKS_IMPORT_PLAN_VERSION,
  TASKS_PLUGIN_SOURCE,
  tasksImportSnapshotSchema,
  type TasksImportSnapshot,
  type TasksLabel,
  type TasksProject,
  type TasksTask,
  type TaskStatus,
} from "./adapter.js";
import type {
  JsonValue,
  PlannedJob,
  PlannedJobProposed,
  PlanIssue,
  PreservedLink,
  TasksImportConflict,
  TasksImportPlan,
  UnsupportedField,
} from "./types.js";

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

function issue(code: string, field: string | null, message: string, sourceValue: unknown): PlanIssue {
  return { code, field, message, sourceValue: jsonValue(sourceValue) };
}

function unsupported(field: string, reason: string, sourceValue: unknown): UnsupportedField {
  return { field, reason, sourceValue: jsonValue(sourceValue) };
}

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(item.id, item);
  return map;
}

function sortById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function compareIssue(a: PlanIssue, b: PlanIssue): number {
  return a.code < b.code ? -1 : a.code > b.code ? 1 : (a.field ?? "").localeCompare(b.field ?? "");
}

function compareUnsupported(a: UnsupportedField, b: UnsupportedField): number {
  return a.field < b.field ? -1 : a.field > b.field ? 1 : a.reason.localeCompare(b.reason);
}

function compareLink(a: PreservedLink, b: PreservedLink): number {
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.value.localeCompare(b.value);
}

function duplicateIds(ids: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dup.add(id);
    else seen.add(id);
  }
  return dup;
}

function statusUnsupported(status: TaskStatus): UnsupportedField | null {
  if (status === "backlog" || status === "canceled") return null;
  const reason =
    status === "done"
      ? "Tasks done is not Agency Job done and is not artifact acceptance"
      : status === "todo"
        ? "Agency queued requires assignee, binding, brief and acceptance; not invented"
        : status === "in_progress"
          ? "Agency running requires a bound thread; task_threads are not RunAttempts"
          : "Agency review requires a published current artifact version";
  return unsupported("status", reason, status);
}

function statusBlockers(status: TaskStatus): PlanIssue[] {
  if (status === "todo") {
    return [
      issue(
        "todo_is_not_agency_queued",
        "status",
        "todo is not queued; queued guards are not invented from Tasks",
        status,
      ),
    ];
  }
  if (status === "in_progress") {
    return [
      issue(
        "in_progress_is_not_agency_running",
        "status",
        "in_progress is not running; thread bind and assignee are not invented",
        status,
      ),
    ];
  }
  if (status === "in_review") {
    return [
      issue(
        "in_review_is_not_agency_review",
        "status",
        "in_review is not review; no published ArtifactVersion is invented",
        status,
      ),
    ];
  }
  if (status === "done") {
    return [
      issue(
        "done_is_not_agency_done",
        "status",
        "Tasks done does not satisfy Agency done (accepted current version)",
        status,
      ),
      issue(
        "done_is_not_accepted_artifact",
        "status",
        "Tasks done must not become acceptArtifactVersion",
        status,
      ),
    ];
  }
  return [];
}

function parentChainCycle(taskId: string, byTask: Map<string, TasksTask>): string[] | null {
  const seen: string[] = [];
  const visiting = new Set<string>();
  let current: string | null = taskId;
  while (current) {
    if (visiting.has(current)) {
      const start = seen.indexOf(current);
      return seen.slice(start).concat(current);
    }
    visiting.add(current);
    seen.push(current);
    const row = byTask.get(current);
    current = row?.parentTaskId ?? null;
    if (current && !byTask.has(current)) break;
  }
  return null;
}

function topoApplyOrder(
  uniqueIds: readonly string[],
  byTask: Map<string, TasksTask>,
  excluded: Set<string>,
): { order: string[]; cyclic: Set<string> } {
  const ids = uniqueIds.filter((id) => !excluded.has(id));
  const idSet = new Set(ids);
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    children.set(id, []);
  }
  for (const id of ids) {
    const parentId = byTask.get(id)?.parentTaskId ?? null;
    if (parentId && idSet.has(parentId) && parentId !== id) {
      indegree.set(id, (indegree.get(id) ?? 0) + 1);
      const siblings = children.get(parentId);
      if (siblings) siblings.push(id);
    }
  }
  for (const list of children.values()) list.sort((a, b) => a.localeCompare(b));
  const queue = ids.filter((id) => indegree.get(id) === 0).sort((a, b) => a.localeCompare(b));
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    order.push(id);
    for (const child of children.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) {
        queue.push(child);
        queue.sort((a, b) => a.localeCompare(b));
      }
    }
  }
  const cyclic = new Set(ids.filter((id) => !order.includes(id)));
  return { order: order.map((id) => sourceTaskIdentity(id)), cyclic };
}


export function parseTasksImportSnapshot(input: unknown): DomainResult<TasksImportSnapshot> {
  const parsed = tasksImportSnapshotSchema.safeParse(input);
  if (!parsed.success) return fail("invalid_snapshot", parsed.error.message);
  return ok(parsed.data);
}

function planOne(
  task: TasksTask,
  snapshot: TasksImportSnapshot,
  byTask: Map<string, TasksTask>,
  byProject: Map<string, TasksProject>,
  labelsById: Map<string, TasksLabel>,
  duplicateTaskIds: Set<string>,
): PlannedJob {
  const sourceIdentity = sourceTaskIdentity(task.id);
  const project = byProject.get(task.projectId) ?? null;
  const parent = task.parentTaskId ? (byTask.get(task.parentTaskId) ?? null) : null;
  const blockers: PlanIssue[] = [];
  const unsupportedFields: UnsupportedField[] = [];

  if (duplicateTaskIds.has(task.id)) {
    blockers.push(issue("duplicate_source_id", "id", "source task id occurs more than once", task.id));
  }

  const title = proposedTitle(task.title);
  if (title === null) {
    blockers.push(issue("invalid_title", "title", "title is not an Agency display name (1–180 after trim)", task.title));
  }
  const brief = proposedBrief(task.description);
  if (brief === null) {
    blockers.push(
      issue(
        task.description.trim().length > 20_000 ? "brief_too_long" : "missing_brief",
        "description",
        "Agency brief is required and is not invented; empty or over 20000 chars cannot be mapped",
        task.description,
      ),
    );
  }

  blockers.push(
    issue("missing_acceptance", "acceptance", "Tasks has no acceptance field; Agency createJob requires it", null),
  );
  blockers.push(
    issue("missing_binding", "bindingId", "ProjectBinding is not invented from Tasks project or linkedBbProjectId", project?.linkedBbProjectId ?? null),
  );
  blockers.push(
    issue("missing_department", "departmentId", "Department is not invented from Tasks", null),
  );
  blockers.push(
    issue("missing_assignee", "assignedAgentId", "Assignee is not invented from presets or task_threads", null),
  );

  if (!project) {
    blockers.push(issue("missing_project", "projectId", "task.projectId is not in the snapshot projects list", task.projectId));
  } else {
    const expected = expectedTaskKey(project.prefix, task.number);
    if (task.key !== expected) {
      blockers.push(issue("task_key_mismatch", "key", `computed key is ${expected}`, { key: task.key, expected }));
    }
    if (project.folderId !== null) {
      unsupportedFields.push(unsupported("project.folderId", "Agency has no Tasks folder entity", project.folderId));
    }
    if (project.linkedBbProjectId !== null) {
      unsupportedFields.push(
        unsupported(
          "project.linkedBbProjectId",
          "bb project id is a hint for ProjectBindingResolver, not a bindingId",
          project.linkedBbProjectId,
        ),
      );
    }
  }

  if (task.parentTaskId === task.id) {
    blockers.push(issue("task_parent_invalid", "parentTaskId", "A task cannot be its own parent", task.parentTaskId));
  } else if (task.parentTaskId) {
    if (duplicateTaskIds.has(task.parentTaskId)) {
      blockers.push(
        issue("duplicate_parent", "parentTaskId", "parent task id is not unique in the snapshot", task.parentTaskId),
      );
    }
    if (!parent) {
      blockers.push(issue("missing_parent", "parentTaskId", "parent task is not in the snapshot", task.parentTaskId));
    } else {
      if (parent.projectId !== task.projectId) {
        blockers.push(
          issue("subtask_project_mismatch", "parentTaskId", "A sub-task must belong to the same project as its parent", {
            parentTaskId: task.parentTaskId,
            parentProjectId: parent.projectId,
            projectId: task.projectId,
          }),
        );
      }
      if (parent.parentTaskId !== null) {
        blockers.push(
          issue("subtask_depth_exceeded", "parentTaskId", "Tasks support at most one level of sub-tasks", {
            parentTaskId: task.parentTaskId,
            parentParentTaskId: parent.parentTaskId,
          }),
        );
      }
    }
    const cycle = parentChainCycle(task.id, byTask);
    if (cycle) {
      blockers.push(issue("parent_cycle", "parentTaskId", "parent links contain a cycle", cycle));
    }
  }

  blockers.push(...statusBlockers(task.status));
  const statusField = statusUnsupported(task.status);
  if (statusField) unsupportedFields.push(statusField);

  const priority = mapPriority(task.priority);
  if (priority === null) {
    unsupportedFields.push(
      unsupported("priority", "Agency JobPriority has no medium/none; value is preserved, not coerced to normal", task.priority),
    );
  }

  if (task.dueDate !== null) {
    unsupportedFields.push(
      unsupported("dueDate", "Tasks dueDate is a calendar YYYY-MM-DD; Agency dueAt is a UTC instant and is not invented", task.dueDate),
    );
  }
  unsupportedFields.push(unsupported("position", "Agency Job has no board position", task.position));
  if (task.labelIds.length > 0) {
    unsupportedFields.push(unsupported("labelIds", "Agency Job has no labels; names are preserved on the item", task.labelIds));
  }

  const comments = sortById(snapshot.comments.filter((row) => row.taskId === task.id));
  const attachments = sortById(snapshot.attachments.filter((row) => row.taskId === task.id));
  const commentAttachments = sortById(
    snapshot.attachments.filter((row) => row.commentId !== null && comments.some((comment) => comment.id === row.commentId)),
  );
  const allAttachments = sortById([...attachments, ...commentAttachments.filter((row) => !attachments.some((a) => a.id === row.id))]);
  const threads = sortById(snapshot.threads.filter((row) => row.taskId === task.id));
  const labels = sortById(task.labelIds.map((id) => labelsById.get(id)).filter((row): row is TasksLabel => row !== undefined));
  for (const labelId of task.labelIds) {
    const label = labelsById.get(labelId);
    if (!label) {
      blockers.push(issue("missing_label", "labelIds", "label id is not in the snapshot labels list", labelId));
    } else if (label.projectId !== task.projectId) {
      blockers.push(issue("label_project_mismatch", "labelIds", "Task labels must belong to the task project", labelId));
    }
  }

  if (comments.length > 0) {
    unsupportedFields.push(unsupported("comments", "Comments are not Agency Activity; bodies are preserved", comments.map((row) => row.id)));
  }
  if (allAttachments.length > 0) {
    unsupportedFields.push(
      unsupported("attachments", "Attachments are not ArtifactVersions and are never accepted", allAttachments.map((row) => row.id)),
    );
  }
  if (threads.length > 0) {
    unsupportedFields.push(
      unsupported("threads", "task_threads are not RunAttempts or assignedAgentId", threads.map((row) => row.threadId)),
    );
  }

  const links: PreservedLink[] = [];
  if (task.parentTaskId) links.push({ kind: "parent", value: sourceTaskIdentity(task.parentTaskId) });
  if (project?.linkedBbProjectId) links.push({ kind: "bb_project", value: project.linkedBbProjectId });
  for (const thread of threads) links.push({ kind: "thread", value: thread.threadId });
  for (const comment of comments) {
    if (comment.threadId) links.push({ kind: "comment_thread", value: comment.threadId });
  }
  links.sort(compareLink);

  const proposed: PlannedJobProposed = {
    title,
    brief,
    acceptance: null,
    assignedAgentId: null,
    bindingId: null,
    departmentId: null,
    parentSourceIdentity: task.parentTaskId ? sourceTaskIdentity(task.parentTaskId) : null,
    jobKey: proposedJobKey(task.key),
    priority,
    dueAt: null,
    jobState: mapJobState(task.status),
    acceptArtifact: false,
  };
  if (proposed.jobKey === null) {
    unsupportedFields.push(unsupported("key", "Tasks key is prefix-number, not Agency AG-n, unless it already matches", task.key));
  }

  blockers.sort(compareIssue);
  unsupportedFields.sort(compareUnsupported);

  const graphBlockerCodes = new Set([
    "duplicate_source_id",
    "duplicate_parent",
    "missing_parent",
    "parent_cycle",
    "task_parent_invalid",
    "subtask_project_mismatch",
    "subtask_depth_exceeded",
  ]);
  const graphOk = blockers.every((row) => !graphBlockerCodes.has(row.code));
  // Tasks cannot satisfy Agency createJob: no acceptance, binding, department, or assignee.
  const createJobReady = false;

  return {
    sourceIdentity,
    sourceTaskId: task.id,
    source: { ...task, linkedBbProjectId: project?.linkedBbProjectId ?? null },
    proposed,
    graphOk,
    createJobReady,
    blockers,
    unsupported: unsupportedFields,
    preserved: {
      comments,
      attachments: allAttachments,
      threads,
      labels,
      links,
    },
  };
}

export function planTasksImport(input: unknown): DomainResult<TasksImportPlan> {
  const parsed = parseTasksImportSnapshot(input);
  if (!parsed.ok) return parsed;
  const snapshot = parsed.value;

  const duplicateTaskIds = duplicateIds(snapshot.tasks.map((task) => task.id));
  const duplicateProjectIds = duplicateIds(snapshot.projects.map((row) => row.id));
  const byProject = byId(snapshot.projects);
  const labelsById = byId(snapshot.labels);
  const uniqueTasks: TasksTask[] = [];
  const seenTask = new Set<string>();
  for (const task of snapshot.tasks) {
    if (seenTask.has(task.id)) continue;
    seenTask.add(task.id);
    uniqueTasks.push(task);
  }
  const byTask = byId(uniqueTasks);

  const conflicts: TasksImportConflict[] = [];
  for (const id of [...duplicateTaskIds].sort()) {
    conflicts.push({
      code: "duplicate_source_id",
      sourceIdentity: sourceTaskIdentity(id),
      sourceTaskId: id,
      message: "source task id occurs more than once",
      sourceValue: id,
    });
  }
  for (const id of [...duplicateProjectIds].sort()) {
    conflicts.push({
      code: "duplicate_project_id",
      sourceIdentity: null,
      sourceTaskId: null,
      message: "source project id occurs more than once",
      sourceValue: id,
    });
  }
  const keyCounts = new Map<string, string[]>();
  for (const task of uniqueTasks) {
    const list = keyCounts.get(task.key) ?? [];
    list.push(task.id);
    keyCounts.set(task.key, list);
  }
  for (const key of [...keyCounts.keys()].sort()) {
    const ids = keyCounts.get(key) ?? [];
    if (ids.length > 1) {
      conflicts.push({
        code: "duplicate_source_key",
        sourceIdentity: null,
        sourceTaskId: null,
        message: "source task key occurs more than once",
        sourceValue: { key, taskIds: [...ids].sort() },
      });
    }
  }

  const items = uniqueTasks
    .map((task) => planOne(task, snapshot, byTask, byProject, labelsById, duplicateTaskIds))
    .sort((a, b) => a.sourceTaskId.localeCompare(b.sourceTaskId));

  const excluded = new Set(items.filter((item) => !item.graphOk).map((item) => item.sourceTaskId));
  const { order: applyOrder, cyclic } = topoApplyOrder(
    uniqueTasks.map((task) => task.id),
    byTask,
    excluded,
  );
  for (const id of [...cyclic].sort()) {
    conflicts.push({
      code: "parent_cycle",
      sourceIdentity: sourceTaskIdentity(id),
      sourceTaskId: id,
      message: "parent links contain a cycle",
      sourceValue: id,
    });
  }

  const knownTaskIds = new Set(uniqueTasks.map((task) => task.id));
  for (const comment of snapshot.comments) {
    if (!knownTaskIds.has(comment.taskId)) {
      conflicts.push({
        code: "orphan_comment",
        sourceIdentity: null,
        sourceTaskId: comment.taskId,
        message: "comment.taskId is not in the snapshot tasks list",
        sourceValue: comment.id,
      });
    }
  }
  for (const thread of snapshot.threads) {
    if (!knownTaskIds.has(thread.taskId)) {
      conflicts.push({
        code: "orphan_thread",
        sourceIdentity: null,
        sourceTaskId: thread.taskId,
        message: "thread.taskId is not in the snapshot tasks list",
        sourceValue: thread.id,
      });
    }
  }
  conflicts.sort((a, b) => {
    const code = a.code.localeCompare(b.code);
    if (code !== 0) return code;
    return (a.sourceTaskId ?? "").localeCompare(b.sourceTaskId ?? "");
  });

  const globalBlockers = [
    issue("no_assignees_invented", null, "Presets and task_threads never become assignedAgentId", null),
    issue("no_bindings_invented", null, "linkedBbProjectId never becomes bindingId", null),
    issue("no_acceptance_in_tasks", null, "Tasks has no acceptance; AcceptanceAuthor is required before createJob", null),
    issue("done_is_not_accepted_artifact", null, "Planner never emits acceptArtifactVersion", false),
  ];

  const graphOkCount = items.filter((item) => item.graphOk).length;
  const createJobReady = items.filter((item) => item.createJobReady).length;
  const unsupportedFieldCount = items.reduce((sum, item) => sum + item.unsupported.length, 0);

  const ordered = new Map(items.map((item) => [item.sourceIdentity, item]));
  const rest = items.filter((item) => !applyOrder.includes(item.sourceIdentity));
  const itemsInOrder = [
    ...applyOrder.map((identity) => ordered.get(identity)).filter((item): item is PlannedJob => item !== undefined),
    ...rest,
  ];

  const plan: TasksImportPlan = {
    schemaVersion: TASKS_IMPORT_PLAN_VERSION,
    source: TASKS_PLUGIN_SOURCE,
    dryRun: true,
    mutatesDatabase: false,
    disablesTasks: false,
    createsAcceptedArtifacts: false,
    applyOrder,
    items: itemsInOrder,
    conflicts,
    globalBlockers,
    summary: {
      tasks: snapshot.tasks.length,
      uniqueTasks: uniqueTasks.length,
      graphOk: graphOkCount,
      createJobReady,
      unsupportedFieldCount,
    },
  };
  return ok(plan);
}
