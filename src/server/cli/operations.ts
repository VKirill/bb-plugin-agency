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
  listArtifactVersionsInputSchema,
  listWorkspaceInputSchema,
  openArtifactRpcSchema,
  cancelLaunchCommandSchema,
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
  createJob: { input: createJobRpcSchema, summary: "Создать задачу; state задаёт переход, не create" },
  updateJob: { input: updateJobRpcSchema, summary: "Обновить поля задачи, включая назначение" },
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
