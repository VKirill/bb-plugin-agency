import type { JobPriority, JobState } from "../../../shared/contracts";
import type {
  TASKS_IMPORT_PLAN_VERSION,
  TASKS_PLUGIN_SOURCE,
  TasksAttachment,
  TasksComment,
  TasksLabel,
  TasksTask,
  TasksThread,
} from "./adapter.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type PlanIssue = {
  code: string;
  field: string | null;
  message: string;
  sourceValue: JsonValue;
};

export type UnsupportedField = {
  field: string;
  reason: string;
  sourceValue: JsonValue;
};

export type PreservedLink = {
  kind: "parent" | "bb_project" | "thread" | "comment_thread";
  value: string;
};

export type PlannedJobProposed = {
  title: string | null;
  brief: string | null;
  acceptance: null;
  assignedAgentId: null;
  bindingId: null;
  departmentId: null;
  parentSourceIdentity: string | null;
  jobKey: string | null;
  priority: JobPriority | null;
  dueAt: null;
  jobState: JobState;
  acceptArtifact: false;
};

export type PlannedJob = {
  sourceIdentity: string;
  sourceTaskId: string;
  source: TasksTask & {
    linkedBbProjectId: string | null;
  };
  proposed: PlannedJobProposed;
  graphOk: boolean;
  createJobReady: boolean;
  blockers: readonly PlanIssue[];
  unsupported: readonly UnsupportedField[];
  preserved: {
    comments: readonly TasksComment[];
    attachments: readonly TasksAttachment[];
    threads: readonly TasksThread[];
    labels: readonly TasksLabel[];
    links: readonly PreservedLink[];
  };
};

export type TasksImportConflict = {
  code: string;
  sourceIdentity: string | null;
  sourceTaskId: string | null;
  message: string;
  sourceValue: JsonValue;
};

export type TasksImportPlan = {
  schemaVersion: typeof TASKS_IMPORT_PLAN_VERSION;
  source: typeof TASKS_PLUGIN_SOURCE;
  dryRun: true;
  mutatesDatabase: false;
  disablesTasks: false;
  createsAcceptedArtifacts: false;
  applyOrder: readonly string[];
  items: readonly PlannedJob[];
  conflicts: readonly TasksImportConflict[];
  globalBlockers: readonly PlanIssue[];
  summary: {
    tasks: number;
    uniqueTasks: number;
    graphOk: number;
    createJobReady: number;
    unsupportedFieldCount: number;
  };
};
