import type { CustomMcp } from "./mcp-config";
import type { ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk";

export const states = ["backlog", "queued", "running", "review", "waiting_input", "blocked", "done", "canceled"] as const;
export type State = typeof states[number];
export const stateNames: Record<State, string> = {
  backlog: "Бэклог",
  queued: "К запуску",
  running: "В работе",
  review: "На проверке",
  waiting_input: "Ждёт ответа",
  blocked: "Ожидает решения",
  done: "Готово",
  canceled: "Отменено",
};
export const sections = [
  ["jobs", "Задачи", "ListTodo"],
  ["agents", "Сотрудники", "Users"], ["departments", "Отделы", "Layers"],
  ["projects", "Проекты", "Folder"], ["automations", "Автоматизации", "Workflow"],
  ["inbox", "Входящие", "MessageSquare"], ["runs", "Запуски", "Terminal"],
  ["usage", "Дашборд", "SlidersHorizontal"],
  ["goals", "Цели", "Target"],
  ["knowledge", "Знания", "Info"], ["settings", "Настройки", "Settings"],
] as const;
export interface TaskFile { id:string; name:string; size:number; content:string; kind:"text"|"image"; version?:number; hash?:string; mime?:string; previousVersions?:{version:number;content:string;at:string}[]; }
export interface TaskActivity {id:string;kind:"comment"|"event";text:string;at:string;author?:string;role?:string;providerId?:string;model?:string;reasoningEffort?:string;fileIds?:string[];references?:{type:string;id:string}[];}
export interface Job {
  id: string;
  title: string;
  state: State;
  project: string;
  department: string;
  agent: string;
  priority: string;
  due: string;
  /** Exact due instant from the server; `due` is its local day. */
  dueAt?: string | null;
  /** Hours before the due instant the job reads as «due soon» (department rules). */
  dueWindowHours?: number;
  /** Create only: let the server pick the member of this role type with the fewest open jobs. */
  assignment?: "executor" | "reviewer";
  /** Department the job was escalated to, while the escalation is open. */
  escalatedToId?: string;
  /** Goal of a main job. */
  goalId?: string;
  /** Waiting in the launch queue: position and why it waits. */
  launchQueue?: { position: number; waitingReason: string | null };
  /** Execution contract: may change, must not touch, checks. */
  contract?: import("../../shared/contracts/job").JobContract;
  description: string;
  comments: string[];
  parentId?: string;
  activity?: TaskActivity[];
  files?: TaskFile[];
  fileDrafts?: Record<string, string>;
  execution?: ExperimentalProviderModelPickerValue;
  question?: import("./question-contract").TaskQuestion;
  recordId?: string;
  revision?: number;
  bindingId?: string;
  departmentId?: string;
  assignedAgentId?: string | null;
  reviewerAgentIds?: readonly string[];
  observerAgentIds?: readonly string[];
  updatedAt?: string;
  /** When the job last closed (done/canceled); drives board hiding. */
  closedAt?: string;
  /** Domain JobState before asUiState; launch guard uses this when the label differs. */
  sourceState?: string;
}
export interface DemoRun {
  id: string;
  jobId: string;
  title: string;
  agent: string;
  providerId: string;
  result: string;
  project: string;
  department: string;
  duration: string;
  summary: string;
}
export interface Agent {
  /** Role type in the agent's department: lead, executor or reviewer. */
  roleType?: "lead" | "executor" | "reviewer";
  /** Every department the agent belongs to, with the role type there. */
  memberships?: { departmentId: string; departmentName: string; roleType: "lead" | "executor" | "reviewer" }[];
  /** What the profile's policy allows, in plain words. */
  policySummary?: string;
  policyVersionId?: string;
  /** Jobs of this employee a thread may still be working on. */
  liveJobs?: number;
  /** Reasoning effort stored in the profile version; absent means the CLI default. */
  /** Saved reasoning level; each provider offers its own set in BB's picker. */
  reasoningEffort?: ExperimentalProviderModelPickerValue["reasoningLevel"];
  shell?: boolean;
  delegate?: boolean;
  id: string;
  name: string;
  role: string;
  department: string;
  instructions: string;
  skills: string[];
  mcps: string[];
  /** BB plugins whose tools, instructions and skills the employee's launch receives. */
  plugins?: string[];
  /** Folder where the employee always works (File Gateway); absent means the job's folder. */
  workplaceBindingId?: string;
  customMcps?: CustomMcp[];
  selection: ExperimentalProviderModelPickerValue;
  permission: "auto" | "full" | "accept-edits";
  hostId: string;
  concurrency: number;
  enabled: boolean;
  /** In the archive: kept with its history, not offered for new work. */
  archived?: boolean;
  recordId?: string;
  revision?: number;
}
export type MemberRoleType = "executor" | "reviewer";
export const ROLE_TYPE_LABELS: Record<"lead" | "executor" | "reviewer", string> = {
  lead: "Руководитель",
  executor: "Исполнитель",
  reviewer: "Проверяющий",
};
export interface Group {
  /** Role type of each non-lead member by agent id; absent means executor. */
  memberRoles?: Record<string, MemberRoleType>;
  returnLimit?: string;
  acceptance?: string;
  /** Department process: a reviewer must check each result before acceptance. */
  reviewRequired?: boolean;
  /** Department this one reports to. */
  parentDepartmentId?: string | null;
  id: string;
  name: string;
  description: string;
  lead: string;
  members: string[];
  instructions: string;
  enabled: boolean;
  recordId?: string;
  revision?: number;
  bbProjectId?: string;
  /** Host of the bound BB environment; shown in the task rail. */
  hostName?: string | null;
  /** Project connection: BB project name, machine id and folder. */
  bbProjectName?: string;
  hostId?: string;
  environmentId?: string;
  root?: string;
  environmentName?: string | null;
  /** Project: CLIs its permission policy allows; empty means any CLI connected in BB. */
  allowedProviders?: string[];
  /** Set when the project is disconnected from the Agency. */
  archivedAt?: string;
  /** Departments only: omitted means open to all projects. */
  availability?: "all" | "selected";
}
export interface WebhookDraft { source:string; topic:string; auth:string; mode:string; status:string; overlap:string; }
export interface Automation { actionKind?:string; missed?:string; overlap?:string; tries?:string; webhook?: WebhookDraft; id: string; name: string; kind: string; topic: string; cron: string; timezone: string; project: string; department: string; prompt: string; enabled: boolean; }
export const skillOptions = ["copywriter", "ru-text", "ru-check", "ui-review", "app-architect", "social-insights", "text-insights", "google-search-console", "yandex-metrica", "video-to-reels", "browser-automation"];
export const mcpOptions = ["Документы", "Браузер", "Google Search Console", "Яндекс Метрика", "Генерация изображений", "Telegram", "GitHub"];
