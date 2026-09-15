import { z } from "zod";
import {
  displayNameSchema,
  jobKeySchema,
  type JobPriority,
  type JobState,
} from "../../../shared/contracts";

/**
 * Tasks adapter = RPC records from builtin Tasks 0.1.2 / BB 0.43.1.
 * Copied from local source, not invented:
 * `/Users/vechkasov/.local/share/bb-source-agy-16-0431/plugins/tasks/shared/contract.ts`
 * SQL CHECKs: `.../plugins/tasks/db/schema.ts`
 *
 * Tasks ids are Crockford ULIDs. Agency ids are opaque `kind_…`.
 * Do not cast one into the other.
 *
 * DB-only `attachments.blob_path` is not in listAttachments RPC. A snapshot
 * reader must not drop it silently: keep it outside this schema and pass a
 * locator through the AttachmentLocator port.
 */
export const TASKS_PLUGIN_SOURCE = "builtin:tasks" as const;
export const TASKS_IMPORT_PLAN_VERSION = 1 as const;

export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
] as const;

export const TASK_PRIORITIES = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
] as const;

export const TASK_THREAD_LIVE_STATUSES = [
  "starting",
  "working",
  "idle",
  "completed",
  "failed",
] as const;

export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
export const PROJECT_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{0,9}$/;
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const tasksIdSchema = z.string().regex(ULID_PATTERN, "must be a ULID");

const dueDateSchema = z
  .string()
  .regex(ISO_DATE_PATTERN)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }, "must be a valid calendar date in YYYY-MM-DD format");

export const tasksTaskSchema = z
  .object({
    id: tasksIdSchema,
    projectId: tasksIdSchema,
    number: z.number().int().positive(),
    key: z.string(),
    title: z.string(),
    description: z.string(),
    status: z.enum(TASK_STATUSES),
    priority: z.enum(TASK_PRIORITIES),
    dueDate: dueDateSchema.nullable(),
    parentTaskId: tasksIdSchema.nullable(),
    position: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
    labelIds: z.array(tasksIdSchema),
  })
  .strict();

export const tasksProjectSchema = z
  .object({
    id: tasksIdSchema,
    name: z.string(),
    prefix: z.string().regex(PROJECT_PREFIX_PATTERN),
    nextTaskNumber: z.number().int().positive(),
    color: z.string(),
    folderId: tasksIdSchema.nullable(),
    linkedBbProjectId: z.string().startsWith("proj_").nullable(),
    createdAt: z.string(),
  })
  .strict();

export const tasksLabelSchema = z
  .object({
    id: tasksIdSchema,
    projectId: tasksIdSchema,
    name: z.string(),
    color: z.string(),
  })
  .strict();

export const tasksCommentSchema = z
  .object({
    id: tasksIdSchema,
    taskId: tasksIdSchema,
    kind: z.enum(["user", "agent", "system"]),
    authorName: z.string(),
    presetName: z.string().nullable(),
    threadId: z.string().startsWith("thr_").nullable(),
    body: z.string(),
    notifiedCount: z.number().int().nonnegative(),
    createdAt: z.string(),
  })
  .strict();

export const tasksAttachmentSchema = z
  .object({
    id: tasksIdSchema,
    taskId: tasksIdSchema.nullable(),
    commentId: tasksIdSchema.nullable(),
    fileName: z.string(),
    mime: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    isImage: z.boolean(),
    createdAt: z.string(),
  })
  .strict();

export const tasksThreadSchema = z
  .object({
    id: tasksIdSchema,
    taskId: tasksIdSchema,
    threadId: z.string().startsWith("thr_"),
    presetName: z.string(),
    title: z.string(),
    liveStatus: z.enum(TASK_THREAD_LIVE_STATUSES),
    attachedAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const tasksImportSnapshotSchema = z
  .object({
    source: z.literal(TASKS_PLUGIN_SOURCE),
    tasks: z.array(tasksTaskSchema),
    projects: z.array(tasksProjectSchema).default([]),
    labels: z.array(tasksLabelSchema).default([]),
    comments: z.array(tasksCommentSchema).default([]),
    attachments: z.array(tasksAttachmentSchema).default([]),
    threads: z.array(tasksThreadSchema).default([]),
  })
  .strict();

export type TasksTask = z.infer<typeof tasksTaskSchema>;
export type TasksProject = z.infer<typeof tasksProjectSchema>;
export type TasksLabel = z.infer<typeof tasksLabelSchema>;
export type TasksComment = z.infer<typeof tasksCommentSchema>;
export type TasksAttachment = z.infer<typeof tasksAttachmentSchema>;
export type TasksThread = z.infer<typeof tasksThreadSchema>;
export type TasksImportSnapshot = z.infer<typeof tasksImportSnapshotSchema>;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASKS_IMPORT_INTEGRATION_PORTS = [
  "TasksSnapshotReader",
  "ProjectBindingResolver",
  "DepartmentResolver",
  "AcceptanceAuthor",
  "JobApplyExecutor",
  "AttachmentLocator",
] as const;

export type TasksImportIntegrationPort = (typeof TASKS_IMPORT_INTEGRATION_PORTS)[number];

/** Exact Agency priority only. `medium` and `none` have no JobPriority. */
const PRIORITY_EXACT = {
  urgent: "urgent",
  high: "high",
  low: "low",
} as const satisfies Partial<Record<TaskPriority, JobPriority>>;

export function sourceTaskIdentity(taskId: string): string {
  return `${TASKS_PLUGIN_SOURCE}:task:${taskId}`;
}

export function mapPriority(priority: TaskPriority): JobPriority | null {
  if (priority === "urgent" || priority === "high" || priority === "low") {
    return PRIORITY_EXACT[priority];
  }
  return null;
}

export function mapJobState(status: TaskStatus): JobState {
  return status === "canceled" ? "canceled" : "backlog";
}

export function proposedJobKey(key: string): string | null {
  const parsed = jobKeySchema.safeParse(key);
  return parsed.success ? parsed.data : null;
}

export function proposedTitle(title: string): string | null {
  const parsed = displayNameSchema.safeParse(title);
  return parsed.success ? parsed.data : null;
}

export function proposedBrief(description: string): string | null {
  const trimmed = description.trim();
  if (trimmed.length < 1 || trimmed.length > 20_000) return null;
  return trimmed;
}

export function expectedTaskKey(prefix: string, number: number): string {
  return `${prefix}-${number}`;
}
