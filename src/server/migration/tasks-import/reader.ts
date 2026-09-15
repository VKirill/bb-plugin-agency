import { z } from "zod";
import {
  TASKS_PLUGIN_SOURCE,
  tasksAttachmentSchema,
  tasksCommentSchema,
  tasksImportSnapshotSchema,
  tasksLabelSchema,
  tasksProjectSchema,
  tasksTaskSchema,
  tasksThreadSchema,
  type TasksAttachment,
  type TasksComment,
  type TasksImportSnapshot,
  type TasksLabel,
  type TasksTask,
  type TasksThread,
} from "./adapter.js";

/** Same bounds as Tasks `shared/pagination.ts` (BB 0.43.1). */
export const TASKS_PAGE_DEFAULT_LIMIT = 100;
export const TASKS_PAGE_MAX_LIMIT = 500;

export type TasksListTasksReadInput = {
  sort: "manual";
  limit: number;
  cursor?: string;
};

export type TasksListProjectsReadInput = Record<string, never>;

export type TasksSnapshotReadPorts = {
  listTasks(input: TasksListTasksReadInput): unknown | Promise<unknown>;
  listProjects(input: TasksListProjectsReadInput): unknown | Promise<unknown>;
  listLabels(input: { projectId: string }): unknown | Promise<unknown>;
  listComments(input: { taskId: string }): unknown | Promise<unknown>;
  listAttachments(input: { taskId: string } | { commentId: string }): unknown | Promise<unknown>;
  listTaskThreads(input: { taskId: string }): unknown | Promise<unknown>;
};

export type TasksSnapshotReadError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type ReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: TasksSnapshotReadError };

export type TasksSnapshotReadResult = ReadResult<TasksImportSnapshot>;

const listTasksOutputSchema = z
  .object({
    tasks: z.array(tasksTaskSchema),
    nextCursor: z.string().trim().min(1).nullable(),
  })
  .strict();

const listProjectsOutputSchema = z.object({ projects: z.array(tasksProjectSchema) }).strict();

const listLabelsOutputSchema = z.object({ labels: z.array(tasksLabelSchema) }).strict();

const commentProviderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    logoUrl: z.string().nullable(),
    icon: z.object({ glyph: z.string() }).strict().nullable(),
    strings: z
      .object({
        iconTint: z.object({ light: z.string(), dark: z.string() }).strict().nullable(),
      })
      .strict(),
  })
  .strict();

/** listComments RPC returns display comments; snapshot keeps the core comment row. */
const displayCommentSchema = tasksCommentSchema
  .extend({
    threadTitle: z.string().nullable(),
    provider: commentProviderSchema.nullable(),
  })
  .strict();

const listCommentsOutputSchema = z.object({ comments: z.array(displayCommentSchema) }).strict();

const listAttachmentsOutputSchema = z.object({ attachments: z.array(tasksAttachmentSchema) }).strict();

const listTaskThreadsOutputSchema = z.object({ taskThreads: z.array(tasksThreadSchema) }).strict();

export type TasksSnapshotReadOptions = {
  pageLimit?: number;
};

function failRead(code: string, message: string, retryable: boolean): { ok: false; error: TasksSnapshotReadError } {
  return { ok: false, error: { code, message, retryable } };
}

async function callPort<T>(operation: string, run: () => T | Promise<T>): Promise<ReadResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch {
    return failRead(`${operation}_failed`, "port_threw", false);
  }
}

function sortById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

function uniqueSorted(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
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

function coreComment(row: z.infer<typeof displayCommentSchema>): TasksComment {
  return {
    id: row.id,
    taskId: row.taskId,
    kind: row.kind,
    authorName: row.authorName,
    presetName: row.presetName,
    threadId: row.threadId,
    body: row.body,
    notifiedCount: row.notifiedCount,
    createdAt: row.createdAt,
  };
}

async function paginateTasks(ports: TasksSnapshotReadPorts, limit: number): Promise<ReadResult<TasksTask[]>> {
  const tasks: TasksTask[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const raw = await callPort("list_tasks", () =>
      ports.listTasks({
        sort: "manual",
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    if (!raw.ok) return { ok: false, error: raw.error };
    const parsed = listTasksOutputSchema.safeParse(raw.value);
    if (!parsed.success) return failRead("invalid_list_tasks", "schema_invalid", false);
    if (parsed.data.tasks.length > limit) {
      return failRead("page_overflow", "page_overflow", false);
    }
    for (const task of parsed.data.tasks) {
      if (seenIds.has(task.id)) {
        return failRead("duplicate_task_id", "duplicate_task_id", false);
      }
      seenIds.add(task.id);
      tasks.push({ ...task, labelIds: [...task.labelIds] });
    }
    if (parsed.data.nextCursor === null) return { ok: true, value: tasks };
    if (parsed.data.tasks.length === 0) {
      return failRead("empty_page_with_cursor", "empty_page_with_cursor", false);
    }
    if (seenCursors.has(parsed.data.nextCursor)) {
      return failRead("cursor_loop", "cursor_loop", false);
    }
    seenCursors.add(parsed.data.nextCursor);
    cursor = parsed.data.nextCursor;
  }
}

async function parseList<T>(
  operation: string,
  schema: z.ZodType<T>,
  run: () => unknown | Promise<unknown>,
): Promise<ReadResult<T>> {
  const raw = await callPort(operation, run);
  if (!raw.ok) return { ok: false, error: raw.error };
  const parsed = schema.safeParse(raw.value);
  if (!parsed.success) return failRead(`invalid_${operation}`, "schema_invalid", false);
  return { ok: true, value: parsed.data };
}

function mergeAttachments(rows: readonly TasksAttachment[]): ReadResult<TasksAttachment[]> {
  const byId = new Map<string, TasksAttachment>();
  for (const row of rows) {
    const existing = byId.get(row.id);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(row)) {
        return failRead("attachment_conflict", "attachment_conflict", false);
      }
      continue;
    }
    byId.set(row.id, row);
  }
  return { ok: true, value: sortById([...byId.values()]) };
}

async function loadSnapshotOnce(
  ports: TasksSnapshotReadPorts,
  pageLimit: number,
): Promise<ReadResult<TasksImportSnapshot>> {
  const listed = await paginateTasks(ports, pageLimit);
  if (!listed.ok) return { ok: false, error: listed.error };
  const tasks = listed.value;

  const projectsRaw = await parseList("list_projects", listProjectsOutputSchema, () => ports.listProjects({}));
  if (!projectsRaw.ok) return { ok: false, error: projectsRaw.error };
  const projects = sortById(projectsRaw.value.projects);

  const projectIds = uniqueSorted([...projects.map((row) => row.id), ...tasks.map((row) => row.projectId)]);

  const labels: TasksLabel[] = [];
  const seenLabelIds = new Set<string>();
  for (const projectId of projectIds) {
    const page = await parseList("list_labels", listLabelsOutputSchema, () => ports.listLabels({ projectId }));
    if (!page.ok) return { ok: false, error: page.error };
    for (const label of page.value.labels) {
      if (seenLabelIds.has(label.id)) {
        return failRead("duplicate_label_id", "duplicate_label_id", false);
      }
      seenLabelIds.add(label.id);
      labels.push(label);
    }
  }

  const comments: TasksComment[] = [];
  const seenCommentIds = new Set<string>();
  for (const task of sortById(tasks)) {
    const page = await parseList("list_comments", listCommentsOutputSchema, () => ports.listComments({ taskId: task.id }));
    if (!page.ok) return { ok: false, error: page.error };
    for (const row of page.value.comments) {
      if (seenCommentIds.has(row.id)) {
        return failRead("duplicate_comment_id", "duplicate_comment_id", false);
      }
      seenCommentIds.add(row.id);
      comments.push(coreComment(row));
    }
  }

  const attachmentRows: TasksAttachment[] = [];
  for (const task of sortById(tasks)) {
    const page = await parseList("list_attachments", listAttachmentsOutputSchema, () =>
      ports.listAttachments({ taskId: task.id }),
    );
    if (!page.ok) return { ok: false, error: page.error };
    attachmentRows.push(...page.value.attachments);
  }
  for (const comment of sortById(comments)) {
    const page = await parseList("list_attachments", listAttachmentsOutputSchema, () =>
      ports.listAttachments({ commentId: comment.id }),
    );
    if (!page.ok) return { ok: false, error: page.error };
    attachmentRows.push(...page.value.attachments);
  }
  const mergedAttachments = mergeAttachments(attachmentRows);
  if (!mergedAttachments.ok) return { ok: false, error: mergedAttachments.error };

  const threads: TasksThread[] = [];
  const seenThreadRowIds = new Set<string>();
  for (const task of sortById(tasks)) {
    const page = await parseList("list_task_threads", listTaskThreadsOutputSchema, () =>
      ports.listTaskThreads({ taskId: task.id }),
    );
    if (!page.ok) return { ok: false, error: page.error };
    for (const row of page.value.taskThreads) {
      if (seenThreadRowIds.has(row.id)) {
        return failRead("duplicate_thread_id", "duplicate_thread_id", false);
      }
      seenThreadRowIds.add(row.id);
      threads.push(row);
    }
  }

  const parsed = tasksImportSnapshotSchema.safeParse({
    source: TASKS_PLUGIN_SOURCE,
    tasks: sortById(tasks),
    projects,
    labels: sortById(labels),
    comments: sortById(comments),
    attachments: mergedAttachments.value,
    threads: sortById(threads),
  });
  if (!parsed.success) return failRead("invalid_snapshot", "schema_invalid", false);
  return { ok: true, value: parsed.data };
}

/**
 * Read-only Tasks RPC → import snapshot. No SQL, no apply, no disable.
 *
 * Optimistic double-read: two full assemblies (tasks + relations) are compared
 * by canonical JSON. Mismatch → `source_changed` (retryable). This is not a
 * snapshot transaction. Tasks SQL `task_list_revision` is not on list* RPC;
 * comments/attachments and most project fields do not bump `tasks.updatedAt`.
 * Not a cutover guarantee without quiescence.
 */
export async function readTasksSnapshot(
  ports: TasksSnapshotReadPorts,
  options: TasksSnapshotReadOptions = {},
): Promise<TasksSnapshotReadResult> {
  const pageLimit = options.pageLimit ?? TASKS_PAGE_MAX_LIMIT;
  if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > TASKS_PAGE_MAX_LIMIT) {
    return failRead("invalid_page_limit", "invalid_page_limit", false);
  }

  const first = await loadSnapshotOnce(ports, pageLimit);
  if (!first.ok) return first;
  const second = await loadSnapshotOnce(ports, pageLimit);
  if (!second.ok) return second;
  if (canonicalJson(first.value) !== canonicalJson(second.value)) {
    return failRead("source_changed", "optimistic_double_read_mismatch", true);
  }
  return second;
}
