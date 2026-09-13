import type { CustomMcp } from "./mcp-config";
import type { ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk";

export const states = ["backlog", "queued", "running", "review", "blocked", "done", "canceled"] as const;
export type State = typeof states[number];
export const stateNames: Record<State, string> = { backlog: "Бэклог", queued: "К запуску", running: "В работе", review: "На проверке", blocked: "Ожидает решения", done: "Готово", canceled: "Отменено" };
export const sections = [
  ["jobs", "Задачи", "ListTodo"],
  ["agents", "Сотрудники", "Users"], ["departments", "Отделы", "Layers"],
  ["projects", "Проекты", "Folder"], ["automations", "Автоматизации", "Workflow"],
  ["inbox", "Входящие", "MessageSquare"], ["runs", "Запуски", "Terminal"],
  ["knowledge", "Знания", "Info"], ["settings", "Настройки", "Settings"],
] as const;
export interface TaskFile { id:string; name:string; size:number; content:string; kind:"text"|"image"; }
export interface TaskActivity {id:string;kind:"comment"|"event";text:string;at:string;author?:string;role?:string;providerId?:string;fileIds?:string[];}
export interface Job { id: string; title: string; state: State; project: string; department: string; agent: string; priority: string; due: string; description: string; comments: string[]; parentId?: string; activity?: TaskActivity[]; files?:TaskFile[]; }
export interface Agent { shell?:boolean; delegate?:boolean; id: string; name: string; role: string; department: string; instructions: string; skills: string[]; mcps: string[]; customMcps?: CustomMcp[]; selection: ExperimentalProviderModelPickerValue; permission: "auto" | "full" | "accept-edits"; hostId: string; concurrency: number; enabled: boolean; }
export interface Group { returnLimit?:string; acceptance?: string; id: string; name: string; description: string; lead: string; members: string[]; instructions: string; enabled: boolean; }
export interface WebhookDraft { source:string; topic:string; auth:string; mode:string; status:string; overlap:string; }
export interface Automation { missed?:string; overlap?:string; tries?:string; webhook?: WebhookDraft; id: string; name: string; kind: string; topic: string; cron: string; timezone: string; project: string; department: string; prompt: string; enabled: boolean; }
export const skillOptions = ["copywriter", "ru-text", "ru-check", "ui-review", "app-architect", "social-insights", "text-insights", "google-search-console", "yandex-metrica", "video-to-reels", "browser-automation"];
export const mcpOptions = ["Документы", "Браузер", "Google Search Console", "Яндекс Метрика", "Генерация изображений", "Telegram", "GitHub"];
export const seedAgents: Agent[] = [
  ["lead", "Мария", "Руководитель маркетинга", "Маркетинг", ["app-architect", "copywriter"]],
  ["writer", "Анна", "Копирайтер", "Редакция", ["copywriter", "ru-text"]],
  ["critic", "Марк", "Редактор и критик", "Редакция", ["ru-check"]],
  ["designer", "Илья", "Дизайнер", "Дизайн", ["ui-review"]],
  ["research", "София", "Исследователь", "Исследования", ["social-insights", "text-insights"]],
].map(([id, name, role, department, skills]) => ({ id: id as string, name: name as string, role: role as string, department: department as string, skills: skills as string[], mcps: ["Документы"], instructions: "Выполняй назначенное поручение. Используй канон проекта и входные материалы. Передай результат с источниками и критериями проверки. Если вводных недостаточно — запроси решение руководителя.", selection: { providerId: "codex", model: "", reasoningLevel: "high" }, permission: "auto", hostId: "", concurrency: 1, enabled: true }));
export const seedDepartments: Group[] = [
  { id: "marketing", name: "Маркетинг", description: "Запуски, кампании и координация отделов", lead: "Мария", members: ["Мария"], instructions: "Разбей поручение на этапы. Запроси тексты и дизайн. Собери комплект и передай на приёмку.", enabled: true },
  { id: "editorial", name: "Редакция", description: "Тексты, офферы, редактура и проверка", lead: "Марк", members: ["Анна", "Марк"], instructions: "Бриф → текст → независимая проверка → исправления. Не более двух возвратов.", enabled: true },
  { id: "design", name: "Дизайн", description: "Прототипы, макеты и рекламные материалы", lead: "Илья", members: ["Илья"], instructions: "Запроси утверждённый текст, формат и бренд-материалы. Верни исходник и экспорт.", enabled: true },
  { id: "research", name: "Исследования", description: "Аудитория, источники, данные и выводы", lead: "София", members: ["София"], instructions: "Каждый вывод сопровождай источником. Отделяй наблюдение от интерпретации.", enabled: true },
];
export const seedProjects: Group[] = [
  { id: "selfy", name: "SelfyStudio", description: "Запуск новых услуг и развитие маркетинга", lead: "Мария", members: ["Маркетинг", "Редакция", "Дизайн", "Исследования"], instructions: "Пишем понятно. Проверяем факты. Публикации и расходы требуют приёмки владельца.", enabled: true },
  { id: "bb", name: "BB-сервис", description: "Инструменты, плагины и внутренняя документация", lead: "Мария", members: ["Редакция", "Дизайн"], instructions: "Сохраняй проверенные результаты и ссылки на исходники.", enabled: true },
];
export const seedJobs: Job[] = [
  ["AG-101", "Исследовать сомнения перед AI-фотосессией", "done", "Исследования", "София"],
  ["AG-102", "Подготовить оффер новой услуги", "review", "Редакция", "Анна"],
  ["AG-103", "Собрать прототип посадочной страницы", "running", "Дизайн", "Илья"],
  ["AG-104", "Написать три варианта объявления", "queued", "Редакция", "Анна"],
  ["AG-105", "Согласовать стиль рекламных изображений", "blocked", "Дизайн", "Илья"],
  ["AG-106", "Подготовить серию коротких видео", "backlog", "Маркетинг", "Мария"],
  ["AG-107", "Проверить комплект перед запуском", "queued", "Маркетинг", "Мария"],
  ["AG-108", "Повторить прошлую рекламную концепцию", "canceled", "Маркетинг", "Мария"],
].map(([id,title,state,department,agent],i) => ({ id, title, state: state as State, department, agent, project: i === 6 ? "BB-сервис" : "SelfyStudio", priority: i < 3 ? "Высокий" : "Обычный", due: "2026-09-18", description: "Подготовить результат для запуска SelfyStudio. Использовать канон проекта и исследование аудитории.\n\nКритерии приёмки:\n- Все утверждения подтверждены.\n- Приложен файл результата.\n- Замечания независимого проверяющего учтены.", comments: ["Мария: вводные и критерии согласованы."] }));
export const seedAutomations: Automation[] = [
  { id: "review", name: "Проверка готового текста", kind: "event", topic: "job.ready_for_review", cron: "0 10 * * 1", timezone: "Europe/Madrid", project: "SelfyStudio", department: "Редакция", prompt: "Проверь приложенный текст и верни замечания к конкретной версии.", enabled: true },
  { id: "weekly", name: "Обзор аудитории по понедельникам", kind: "cron", topic: "research.delivered", cron: "0 10 * * 1", timezone: "Europe/Madrid", project: "SelfyStudio", department: "Исследования", prompt: "Собери новые вопросы аудитории за неделю, укажи источники и изменения.", enabled: false },
  { id: "handoff", name: "Передать принятый текст дизайнеру", kind: "event", topic: "review.accepted", cron: "0 10 * * 1", timezone: "Europe/Madrid", project: "SelfyStudio", department: "Дизайн", prompt: "Подготовь макет по утверждённому тексту.", enabled: true },
];
