/** Isolated demo fixtures. Installed UI loads them only in declared demo mode. */
import type { Agent, Automation, DemoRun, Group, Job, State } from "../data";

export const demoAgents: Agent[] = [
  ["lead", "Мария", "Руководитель маркетинга", "Маркетинг", ["app-architect", "copywriter"]],
  ["writer", "Анна", "Копирайтер", "Редакция", ["copywriter", "ru-text"]],
  ["critic", "Марк", "Редактор и критик", "Редакция", ["ru-check"]],
  ["designer", "Илья", "Дизайнер", "Дизайн", ["ui-review"]],
  ["research", "София", "Исследователь", "Исследования", ["social-insights", "text-insights"]],
].map(([id, name, role, department, skills]) => ({
  id: id as string, name: name as string, role: role as string, department: department as string,
  skills: skills as string[], mcps: ["Документы"],
  instructions: "Выполняй назначенное поручение. Используй канон проекта и входные материалы. Передай результат с источниками и критериями проверки. Если вводных недостаточно — запроси решение руководителя.",
  selection: { providerId: "codex", model: "", reasoningLevel: "high" }, permission: "auto", hostId: "", concurrency: 1, enabled: true,
}));

export const demoDepartments: Group[] = [
  { id: "marketing", name: "Маркетинг", description: "Запуски, кампании и координация отделов", lead: "Мария", members: ["Мария"], instructions: "Разбей поручение на этапы. Запроси тексты и дизайн. Собери комплект и передай на приёмку.", enabled: true },
  { id: "editorial", name: "Редакция", description: "Тексты, офферы, редактура и проверка", lead: "Марк", members: ["Анна", "Марк"], instructions: "Бриф → текст → независимая проверка → исправления. Не более двух возвратов.", enabled: true },
  { id: "design", name: "Дизайн", description: "Прототипы, макеты и рекламные материалы", lead: "Илья", members: ["Илья"], instructions: "Запроси утверждённый текст, формат и бренд-материалы. Верни исходник и экспорт.", enabled: true },
  { id: "research", name: "Исследования", description: "Аудитория, источники, данные и выводы", lead: "София", members: ["София"], instructions: "Каждый вывод сопровождай источником. Отделяй наблюдение от интерпретации.", enabled: true },
];

export const demoProjects: Group[] = [
  { id: "selfy", name: "SelfyStudio", description: "Запуск новых услуг и развитие маркетинга", lead: "Мария", members: ["Маркетинг", "Редакция", "Дизайн", "Исследования"], instructions: "Пишем понятно. Проверяем факты. Публикации и расходы требуют приёмки владельца.", enabled: true },
  { id: "bb", name: "BB-сервис", description: "Инструменты, плагины и внутренняя документация", lead: "Мария", members: ["Редакция", "Дизайн"], instructions: "Сохраняй проверенные результаты и ссылки на исходники.", enabled: true },
];

export const demoJobs: Job[] = [
  ["AG-101", "Исследовать сомнения перед AI-фотосессией", "done", "Исследования", "София"],
  ["AG-102", "Подготовить оффер новой услуги", "review", "Редакция", "Анна"],
  ["AG-103", "Собрать прототип посадочной страницы", "running", "Дизайн", "Илья"],
  ["AG-104", "Написать три варианта объявления", "queued", "Редакция", "Анна"],
  ["AG-105", "Согласовать стиль рекламных изображений", "blocked", "Дизайн", "Илья"],
  ["AG-106", "Подготовить серию коротких видео", "backlog", "Маркетинг", "Мария"],
  ["AG-107", "Проверить комплект перед запуском", "queued", "Маркетинг", "Мария"],
  ["AG-108", "Повторить прошлую рекламную концепцию", "canceled", "Маркетинг", "Мария"],
].map(([id, title, state, department, agent], i) => ({
  id, title, state: state as State, department, agent,
  project: i === 6 ? "BB-сервис" : "SelfyStudio",
  priority: i < 3 ? "Высокий" : "Обычный",
  due: "2026-09-18",
  description: "Подготовить результат для запуска SelfyStudio. Использовать канон проекта и исследование аудитории.\n\nКритерии приёмки:\n- Все утверждения подтверждены.\n- Приложен файл результата.\n- Замечания независимого проверяющего учтены.",
  comments: ["Мария: вводные и критерии согласованы."],
}));

export const demoRuns: DemoRun[] = [
  { id: "RUN-204", jobId: "AG-102", title: "Подготовка оффера", agent: "Анна", providerId: "codex", result: "Передан на проверку", project: "SelfyStudio", department: "Редакция", duration: "3 мин 42 с", summary: "Анна подготовила результат и передала его на проверку." },
];

export const demoAutomations: Automation[] = [
  { id: "review", name: "Проверка готового текста", kind: "event", topic: "job.ready_for_review", cron: "0 10 * * 1", timezone: "Europe/Madrid", project: "SelfyStudio", department: "Редакция", prompt: "Проверь приложенный текст и верни замечания к конкретной версии.", enabled: true },
  { id: "weekly", name: "Обзор аудитории по понедельникам", kind: "cron", topic: "research.delivered", cron: "0 10 * * 1", timezone: "Europe/Madrid", project: "SelfyStudio", department: "Исследования", prompt: "Собери новые вопросы аудитории за неделю, укажи источники и изменения.", enabled: false },
  { id: "handoff", name: "Передать принятый текст дизайнеру", kind: "event", topic: "review.accepted", cron: "0 10 * * 1", timezone: "Europe/Madrid", project: "SelfyStudio", department: "Дизайн", prompt: "Подготовь макет по утверждённому тексту.", enabled: true },
];
