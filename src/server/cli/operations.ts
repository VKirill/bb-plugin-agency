import { installStarterKitInputSchema, recordLifecycleInputSchema } from "../../shared/rpc-contract";
import { addJobDependencyRpcSchema, notifyOwnerInputSchema, ownerDigestInputSchema, removeJobDependencyRpcSchema, saveKnowledgeInputSchema, setJobNextStepRpcSchema } from "../../shared/rpc-contract";
import { dequeueLaunchRpcSchema, enqueueLaunchRpcSchema } from "../../shared/rpc-contract";
import { saveAgencyRulesInputSchema, saveTemplateInputSchema } from "../../shared/rpc-contract";
import { getWorkRulesInputSchema } from "../../shared/rpc-contract";
import { saveWorkRulesCommandSchema } from "../../shared/contracts/work-rules";
import { listDashboardUsageInputSchema } from "../../shared/contracts/dashboard-usage";
import type { ZodType } from "zod";
import {
  attachJobInputRpcSchema,
  acceptArtifactRpcSchema,
  capabilityCatalogInputSchema,
  createArtifactRpcSchema,
  createJobRpcSchema,
  getAgentInputSchema,
  getDepartmentInputSchema,
  getJobInputSchema,
  linkDepartmentRpcSchema,
  bindingLifecycleRpcSchema,
  readProjectRulesInputSchema,
  saveProjectRulesInputSchema,
  unlinkDepartmentRpcSchema,
  listArtifactVersionsInputSchema,
  listWorkspaceInputSchema,
  openArtifactRpcSchema,
  cancelLaunchCommandSchema,
  returnJobForReworkCommandSchema,
  getIsolationReadinessRpcSchema,
  getLaunchRpcSchema,
  interpretWorkerCompletionRpcSchema,
  listJobAttemptsRpcSchema,
  prepareLaunchRpcSchema,
  answerNeedsInputRpcSchema,
  approveActionIntentCommandSchema,
  claimActionIntentCommandSchema,
  completeActionIntentCommandSchema,
  dispatchTickCommandSchema,
  ingestInboxEventCommandSchema,
  listActionIntentsCommandSchema,
  listDispatcherCatalogCommandSchema,
  reportNeedsInputRpcSchema,
  saveEventDefinitionCommandSchema,
  saveEventSourceCommandSchema,
  saveRuleVersionCommandSchema,
  provisionAgentRpcSchema,
  reconcileLaunchRpcSchema,
  provisionDepartmentRpcSchema,
  publishArtifactRpcSchema,
  transitionJobRpcSchema,
  updateJobRpcSchema,
} from "../../shared/rpc-contract";
import { z } from "zod";
import {
  createJobCommentRpcSchema,
  createMembershipCommandSchema,
  createPolicyVersionCommandSchema,
  setDepartmentAvailabilityCommandSchema,
  createProjectBindingCommandSchema,
  removeMembershipCommandSchema,
  saveAgentProfileCommandSchema,
  saveDepartmentProfileCommandSchema,
} from "../../shared/contracts";

const emptyObjectSchema = z.object({}).strict();

export const CLI_OPERATIONS = {
  listWorkspace: { input: listWorkspaceInputSchema, summary: "Снимок workspace, включая полный PolicyVersion" },
  listBbCatalog: { input: emptyObjectSchema, summary: "Каталог BB-проектов и окружений; label политики не есть права" },
  listCapabilityCatalog: { input: capabilityCatalogInputSchema, summary: "Read-only навыки/MCP из SDK" },
  getJob: { input: getJobInputSchema, summary: "Карточка задачи по id или AG-ключу" },
  listDashboardUsage: {
    input: listDashboardUsageInputSchema,
    summary: "Расход токенов и оценка стоимости: rootJobId — задача вместе с подзадачами",
  },
  getAgent: { input: getAgentInputSchema, summary: "Сотрудник и текущая версия" },
  getDepartment: { input: getDepartmentInputSchema, summary: "Отдел, процесс и membership" },
  listArtifactVersions: { input: listArtifactVersionsInputSchema, summary: "Версии артефакта задачи" },
  createPolicyVersion: { input: createPolicyVersionCommandSchema, summary: "Неизменяемая политика: полный payload, не имя" },
  provisionAgent: { input: provisionAgentRpcSchema, summary: "Создать сотрудника с первой версией" },
  saveAgentProfile: { input: saveAgentProfileCommandSchema, summary: "Атомарно сохранить профиль сотрудника (CAS)" },
  provisionDepartment: { input: provisionDepartmentRpcSchema, summary: "Создать отдел с процессом и lead membership" },
  saveDepartmentProfile: { input: saveDepartmentProfileCommandSchema, summary: "Атомарно сохранить отдел (CAS)" },
  addMembership: { input: createMembershipCommandSchema, summary: "Добавить сотрудника в отдел" },
  removeMembership: { input: removeMembershipCommandSchema, summary: "Убрать сотрудника из отдела" },
  createProjectBinding: { input: createProjectBindingCommandSchema, summary: "Привязать существующий каталог BB" },
  linkDepartment: { input: linkDepartmentRpcSchema, summary: "Связать отдел с привязкой проекта" },
  unlinkDepartment: { input: unlinkDepartmentRpcSchema, summary: "Убрать отдел из выбранных отделов проекта" },
  archiveProjectBinding: { input: bindingLifecycleRpcSchema, summary: "Отключить проект: история остаётся, новые задачи и запуски закрыты" },
  restoreProjectBinding: { input: bindingLifecycleRpcSchema, summary: "Вернуть отключённый проект" },
  deleteProjectBinding: { input: bindingLifecycleRpcSchema, summary: "Удалить подключение проекта без задач; BB-проект и файлы не трогаются" },
  setDepartmentAvailability: { input: setDepartmentAvailabilityCommandSchema, summary: "Отдел для всех проектов (all) или только для выбранных (selected)" },
  getWorkRules: { input: getWorkRulesInputSchema, summary: "Правила работы уровня: agency, department:<id> или agent:<id> — сохранённые, действующие и их источник" },
  listTemplates: { input: emptyObjectSchema, summary: "Шаблоны форм: регламент, должностные инструкции по типам ролей, бриф и критерии; custom — задан владельцем" },
  saveTemplate: { input: saveTemplateInputSchema, summary: "Сохранить шаблон (text) или сбросить к стандартному (text: null); expectedRevision из listTemplates" },
  getAgencyRules: { input: emptyObjectSchema, summary: "Общие правила Агентства: действующая версия и история" },
  saveAgencyRules: { input: saveAgencyRulesInputSchema, summary: "Новая версия общих правил Агентства; пустой текст выключает слой. expectedVersion = latestVersion" },
  listKnowledge: { input: emptyObjectSchema, summary: "Знания Агентства, отделов и проектов: принятые (идут в запуски по области), предложения и архив" },
  saveKnowledge: { input: saveKnowledgeInputSchema, summary: "Материал знаний; из треда сотрудника сохраняется как предложение до решения владельца" },
  listGoals: { input: emptyObjectSchema, summary: "Цели над главными задачами с прогрессом" },
  setJobGoal: { input: z.object({ jobId: z.string(), goalId: z.string().nullable() }).strict(), summary: "Привязать главную задачу к цели (goalId null — отвязать)" },
  searchJobs: { input: z.object({ query: z.string().max(200), limit: z.number().int().min(1).max(200).optional() }).strict(), summary: "Поиск задач по ключу, названию, брифу и комментариям, включая архив" },
  agentMetrics: { input: z.object({ agentId: z.string() }).strict(), summary: "Показатели сотрудника: загрузка, закрытые, доля без доработок, срок, расход за 30 дней" },
  listArchivedJobs: { input: z.object({ limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional() }).strict(), summary: "Архив закрытых задач" },
  starterKit: { input: z.object({ language: z.enum(["ru", "en"]).optional() }).strict(), summary: "Стартовые отделы и сотрудники: что есть в наборе, что установлено, сколько записей можно перевести" },
  installStarterKit: { input: installStarterKitInputSchema, summary: "Установить выбранные стартовые отделы с сотрудниками; language по умолчанию — язык Агентства" },
  translateStarterKit: { input: z.object({ language: z.enum(["ru", "en"]).optional() }).strict(), summary: "Перевести стартовые отделы и сотрудников, которых владелец не менял, на язык; изменённые остаются" },
  recordLifecycle: { input: recordLifecycleInputSchema, summary: "Можно ли удалить отдел или сотрудника и почему нет; дата архива отдела" },
  archiveDepartment: { input: z.object({ departmentId: z.string().max(80) }).strict(), summary: "Отдел в архив: уходит из маршрута и форм, история остаётся; нужны закрытые задачи" },
  restoreDepartment: { input: z.object({ departmentId: z.string().max(80) }).strict(), summary: "Вернуть отдел из архива" },
  deleteDepartment: { input: z.object({ departmentId: z.string().max(80) }).strict(), summary: "Удалить отдел без истории задач; сотрудники остаются" },
  deleteAgent: { input: z.object({ agentId: z.string().max(80) }).strict(), summary: "Удалить сотрудника без истории работы; иначе — архив через agent save со state archived" },
  notifyOwner: {
    input: notifyOwnerInputSchema,
    summary: "Сообщение владельцу: «Входящие → Сообщения» и Telegram, если включён; dedupeKey доставляет одно сообщение один раз",
  },
  listOwnerMessages: { input: z.object({ limit: z.number().int().min(1).max(500).optional() }).strict(), summary: "Сообщения владельцу, новые сверху, и число непрочитанных" },
  markOwnerMessagesRead: { input: z.object({ ids: z.array(z.string().max(80)).max(500).optional() }).strict(), summary: "Отметить сообщения прочитанными; без ids — все" },
  ownerDigest: {
    input: ownerDigestInputSchema,
    summary: "Сводка (summary: sinceHours) или сторож (watchdog: задачи ждут человека дольше stuckHours); notify:true отправляет владельцу",
  },
  listScriptTemplates: { input: emptyObjectSchema, summary: "Шаблоны скриптов для cron/launchd: сводка за день, сторож, регулярная задача из внешних данных" },
  listBudgets: { input: emptyObjectSchema, summary: "Бюджеты в месяц: уровни с лимитом, оценка расхода за календарный месяц (UTC) и процент" },
  saveWorkRules: { input: saveWorkRulesCommandSchema, summary: "Сохранить правила уровня целиком: отсутствующий ключ возвращает значение по умолчанию" },
  readProjectRules: { input: readProjectRulesInputSchema, summary: "Прочитать правила проекта (.bb/AGENTS.md) на машине привязки" },
  saveProjectRules: { input: saveProjectRulesInputSchema, summary: "Сохранить правила проекта, если файл не менялся после чтения (expectedHash)" },
  createJob: { input: createJobRpcSchema, summary: "Создать задачу; state задаёт переход, не create" },
  updateJob: { input: updateJobRpcSchema, summary: "Обновить поля задачи, включая назначение" },
  addJobDependency: {
    input: addJobDependencyRpcSchema,
    summary: "Задача ждёт другую: запуск откладывается, из очереди запуска стартует сама, когда та готова",
  },
  removeJobDependency: { input: removeJobDependencyRpcSchema, summary: "Убрать зависимость задачи" },
  setJobNextStep: {
    input: setJobNextStepRpcSchema,
    summary: "Следующий шаг: когда задача готова, Агентство само создаёт задачу отделу рядом с ней, прикладывает принятые версии и ставит в очередь; step null — убрать",
  },
  transitionJob: { input: transitionJobRpcSchema, summary: "Сменить состояние задачи" },
  createArtifact: { input: createArtifactRpcSchema, summary: "Создать реестровую запись артефакта" },
  publishArtifactVersion: { input: publishArtifactRpcSchema, summary: "Опубликовать версию файла" },
  attachJobInput: {
    input: attachJobInputRpcSchema,
    summary: "Привязать published input version к target job; host/root не из caller",
  },
  reportNeedsInput: {
    input: reportNeedsInputRpcSchema,
    summary: "Typed worker wait: bind verified job/attempt/thread/launch; Job+attempt waiting_input; no accept",
  },
  answerNeedsInput: {
    input: answerNeedsInputRpcSchema,
    summary: "Ответ на needsInput: waitId текущего цикла, тот же thread/attempt, official send, без spawn и accept",
  },
  acceptArtifactVersion: { input: acceptArtifactRpcSchema, summary: "Принять текущую версию" },
  openArtifact: { input: openArtifactRpcSchema, summary: "Открыть версию; bytes в CLI не печатаются" },
  enqueueLaunch: {
    input: enqueueLaunchRpcSchema,
    summary: "Поставить задачу в очередь запуска: стартует сама, когда лимиты параллельности и бюджета позволят; backlog переводится в queued",
  },
  dequeueLaunch: { input: dequeueLaunchRpcSchema, summary: "Убрать задачу из очереди запуска" },
  prepareLaunch: {
    input: prepareLaunchRpcSchema,
    summary: "Prepare launch на текущем instance; spawn только после handshake этого runtime",
  },
  getLaunch: { input: getLaunchRpcSchema, summary: "Прочитать launch receipt по launchId или attemptId" },
  reconcileLaunch: { input: reconcileLaunchRpcSchema, summary: "Сверить thread по experimental_callerLaunchId; не respawn" },
  interpretWorkerCompletion: {
    input: interpretWorkerCompletionRpcSchema,
    summary: "Сверить completion с core get + open/hash; caller flags не принимаются",
  },
  listJobAttempts: {
    input: listJobAttemptsRpcSchema,
    summary: "Список scoped RunAttempt по jobId; не выдумывает строки",
  },
  getIsolationReadiness: {
    input: getIsolationReadinessRpcSchema,
    summary: "GET spawn-contract + typed spawn; engines не готовность; только claude-code",
  },
  returnJobForRework: {
    input: returnJobForReworkCommandSchema,
    summary: "Вернуть версию на доработку: замечание уходит в тред исполнителя, задача снова в работе",
  },
  cancelLaunch: {
    input: cancelLaunchCommandSchema,
    summary: "Observed stop exact thread; attempt canceled + Job blocked; no spawn, Job not canceled",
  },
  saveEventDefinition: { input: saveEventDefinitionCommandSchema, summary: "Зарегистрировать topic/namespace EventDefinition" },
  saveEventSource: { input: saveEventSourceCommandSchema, summary: "Источник событий проекта; выключенный режет ingest" },
  saveRuleVersion: { input: saveRuleVersionCommandSchema, summary: "Новая версия правила; старые match не переписываются" },
  ingestInboxEvent: { input: ingestInboxEventCommandSchema, summary: "Typed inbox; не replay alpha notify" },
  dispatchTick: { input: dispatchTickCommandSchema, summary: "Оценить inbox→match→intent; live по умолчанию false" },
  listEventDefinitions: { input: listDispatcherCatalogCommandSchema, summary: "Каталог EventDefinition: topic + human label" },
  listEventSources: { input: listDispatcherCatalogCommandSchema, summary: "Каталог источников событий проекта" },
  listRuleVersions: { input: listDispatcherCatalogCommandSchema, summary: "Последние версии правил с label=ruleId" },
  listActionIntents: { input: listActionIntentsCommandSchema, summary: "Очередь ActionIntent + join label/topic/rule" },
  claimActionIntent: { input: claimActionIntentCommandSchema, summary: "CAS lease + fence; live=false не enqueue; unavailable не жжёт retry" },
  approveActionIntent: { input: approveActionIntentCommandSchema, summary: "CAS approve: expectedRevision + state=awaiting_approval" },
  completeActionIntent: { input: completeActionIntentCommandSchema, summary: "Завершить claimed только с текущим fencing token/generation" },
  createJobComment: {
    input: createJobCommentRpcSchema,
    summary: "Комментарий в историю задачи; kind=comment; автор сотрудник только с proof thread",
  },
} as const satisfies Record<string, { input: ZodType; summary: string }>;

export type CliRoutedOperation = keyof typeof CLI_OPERATIONS;
/** Dispatch surface in register.ts. createJobComment is CLI-routed via jobComment port, not handlers[op]. */
export type CliOperation = Exclude<CliRoutedOperation, "createJobComment">;

export const CLI_OPERATION_NAMES = Object.keys(CLI_OPERATIONS) as CliRoutedOperation[];

export function isCliOperation(value: string): value is CliRoutedOperation {
  return Object.hasOwn(CLI_OPERATIONS, value);
}
