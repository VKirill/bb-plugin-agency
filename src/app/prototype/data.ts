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
  ["usage", "Дашборд", "Target"],
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
  shell?: boolean;
  delegate?: boolean;
  id: string;
  name: string;
  role: string;
  department: string;
  instructions: string;
  skills: string[];
  mcps: string[];
  customMcps?: CustomMcp[];
  selection: ExperimentalProviderModelPickerValue;
  permission: "auto" | "full" | "accept-edits";
  hostId: string;
  concurrency: number;
  enabled: boolean;
  recordId?: string;
  revision?: number;
}
export interface Group {
  returnLimit?: string;
  acceptance?: string;
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
}
export interface WebhookDraft { source:string; topic:string; auth:string; mode:string; status:string; overlap:string; }
export interface Automation { actionKind?:string; missed?:string; overlap?:string; tries?:string; webhook?: WebhookDraft; id: string; name: string; kind: string; topic: string; cron: string; timezone: string; project: string; department: string; prompt: string; enabled: boolean; }
export const skillOptions = ["copywriter", "ru-text", "ru-check", "ui-review", "app-architect", "social-insights", "text-insights", "google-search-console", "yandex-metrica", "video-to-reels", "browser-automation"];
export const mcpOptions = ["Документы", "Браузер", "Google Search Console", "Яндекс Метрика", "Генерация изображений", "Telegram", "GitHub"];
