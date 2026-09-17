import { tr } from "../i18n";
import { normalizeBbCatalog } from "./capability-catalog";
import { failureNotice } from "./persist";
import { isUnknownRpcMethod, parseDomainResult, type MutationOutcome } from "./envelope";
import { DISPATCHER_RPC, STAGE1_RPC, type DispatcherRpcName, type Stage1RpcName } from "./methods";
import {
  actionIntentRecordSchema,
  catalogRuleRecordSchema,
  dispatchTickRecordSchema,
  eventDefinitionRecordSchema,
  eventSourceRecordSchema,
  inboxEventRecordSchema,
  listedActionIntentSchema,
  ruleVersionRecordSchema,
} from "../../shared/contracts";
import {
  LAUNCH_LIST_UNREGISTERED,
  LAUNCH_RPC_UNREGISTERED,
  parseCompletion,
  parseCoordinator,
  parseIsolationReadiness,
  parseJobAttempts,
  parseLaunchReceipt,
  parsePrepareLaunch,
} from "./launch-rpc";
import { parseJobArtifactGroups } from "./job-artifacts";
import { parseNeedsInputRecord } from "./needs-input";
import { answerNeedsInputRecordSchema } from "../../shared/contracts";
import { listDashboardUsageOutputSchema } from "../../shared/contracts/dashboard-usage";
import { STAGE1_UNAVAILABLE } from "./runtime-unavailable";
import { isWorkspaceSnapshot } from "./snapshot";
import type { AgencyApi, JobDetail, LoadWorkspaceResult } from "./agency-api";

const LAUNCH_METHODS = new Set<string>([
  STAGE1_RPC.prepareLaunch,
  STAGE1_RPC.getLaunch,
  STAGE1_RPC.reconcileLaunch,
  STAGE1_RPC.interpretWorkerCompletion,
  STAGE1_RPC.listJobAttempts,
  STAGE1_RPC.getIsolationReadiness,
]);

export type RpcCaller = {
  call: (method: string, input?: unknown) => Promise<unknown>;
};

async function mutate<T>(rpc: RpcCaller, method: Stage1RpcName | DispatcherRpcName, input: unknown): Promise<MutationOutcome<T>> {
  try {
    return parseDomainResult<T>(await rpc.call(method, input));
  } catch (error) {
    if (isUnknownRpcMethod(error)) {
      const message = method === STAGE1_RPC.listJobAttempts
        ? LAUNCH_LIST_UNREGISTERED
        : LAUNCH_METHODS.has(method)
          ? LAUNCH_RPC_UNREGISTERED
          : method in DISPATCHER_RPC
            ? STAGE1_UNAVAILABLE.dispatcher
            : STAGE1_UNAVAILABLE.autonomy;
      return { ok: false, failure: { kind: "unavailable", message } };
    }
    return { ok: false, failure: { kind: "transport", message: error instanceof Error ? error.message : tr("Не удалось сохранить.") } };
  }
}

export function createRpcAgencyApi(rpc: RpcCaller): AgencyApi {
  return {
    async loadWorkspace(input = {}): Promise<LoadWorkspaceResult> {
      try {
        const envelope = parseDomainResult(await rpc.call(STAGE1_RPC.listWorkspace, input));
        if (!envelope.ok) {
          if (envelope.failure.kind === "gated") return { status: "gated", message: envelope.failure.message };
          if (envelope.failure.kind === "unavailable") return { status: "unavailable", message: envelope.failure.message };
          return { status: "error", message: failureNotice(envelope.failure) };
        }
        if (!isWorkspaceSnapshot(envelope.value)) {
          return { status: "error", message: tr("Сервер вернул снимок в неизвестном формате.") };
        }
        return { status: "ready", snapshot: envelope.value };
      } catch (error) {
        if (isUnknownRpcMethod(error)) {
          return { status: "unavailable", message: tr("RPC этапа 1 ещё не зарегистрирован. Каталоги пусты, пока не включён демонстрационный режим.") };
        }
        return { status: "error", message: error instanceof Error ? error.message : tr("Не удалось загрузить данные.") };
      }
    },
    async getJob(input) {
      const result = await mutate<JobDetail>(rpc, STAGE1_RPC.getJob, input);
      if (!result.ok) return result;
      return {
        ok: true,
        value: {
          ...result.value,
          artifacts: parseJobArtifactGroups(result.value.artifacts),
          needsInput: parseNeedsInputRecord(result.value.needsInput),
        },
      };
    },
    getAgent: (input) => mutate(rpc, STAGE1_RPC.getAgent, input),
    getDepartment: (input) => mutate(rpc, STAGE1_RPC.getDepartment, input),
    listActivity: (input) => mutate(rpc, STAGE1_RPC.listActivity, input),
    listArtifactVersions: (input) => mutate(rpc, STAGE1_RPC.listArtifactVersions, input),
    async listBbCatalog() {
      const result = await mutate<unknown>(rpc, STAGE1_RPC.listBbCatalog, null);
      if (!result.ok) return result;
      return { ok: true, value: normalizeBbCatalog(result.value) };
    },
    listCapabilityCatalog: (input = {}) => mutate(rpc, STAGE1_RPC.listCapabilityCatalog, input),
    createPolicyVersion: (input) => mutate(rpc, STAGE1_RPC.createPolicyVersion, input),
    createAgentVersion: (input) => mutate(rpc, STAGE1_RPC.createAgentVersion, input),
    createProcessVersion: (input) => mutate(rpc, STAGE1_RPC.createProcessVersion, input),
    saveAgentProfile: (input) => mutate(rpc, STAGE1_RPC.saveAgentProfile, input),
    saveDepartmentProfile: (input) => mutate(rpc, STAGE1_RPC.saveDepartmentProfile, input),
    provisionAgent: (input) => mutate(rpc, STAGE1_RPC.provisionAgent, input),
    updateAgent: (input) => mutate(rpc, STAGE1_RPC.updateAgent, input),
    provisionDepartment: (input) => mutate(rpc, STAGE1_RPC.provisionDepartment, input),
    updateDepartment: (input) => mutate(rpc, STAGE1_RPC.updateDepartment, input),
    addMembership: (input) => mutate(rpc, STAGE1_RPC.addMembership, input),
    removeMembership: (input) => mutate(rpc, STAGE1_RPC.removeMembership, input),
    createProjectBinding: (input) => mutate(rpc, STAGE1_RPC.createProjectBinding, input),
    updateProjectBinding: (input) => mutate(rpc, STAGE1_RPC.updateProjectBinding, input),
    linkDepartment: (input) => mutate(rpc, STAGE1_RPC.linkDepartment, input),
    unlinkDepartment: (input) => mutate(rpc, STAGE1_RPC.unlinkDepartment, input),
    archiveProjectBinding: (input) => mutate(rpc, STAGE1_RPC.archiveProjectBinding, input),
    restoreProjectBinding: (input) => mutate(rpc, STAGE1_RPC.restoreProjectBinding, input),
    deleteProjectBinding: (input) => mutate(rpc, STAGE1_RPC.deleteProjectBinding, input),
    setDepartmentAvailability: (input) => mutate(rpc, STAGE1_RPC.setDepartmentAvailability, input),
    readProjectRules: (input) => mutate(rpc, STAGE1_RPC.readProjectRules, input),
    saveProjectRules: (input) => mutate(rpc, STAGE1_RPC.saveProjectRules, input),
    createJob: (input) => mutate(rpc, STAGE1_RPC.createJob, input),
    updateJob: (input) => mutate(rpc, STAGE1_RPC.updateJob, input),
    transitionJob: (input) => mutate(rpc, STAGE1_RPC.transitionJob, input),
    returnJobForRework: (input) => mutate(rpc, STAGE1_RPC.returnJobForRework, input),
    getWorkRules: (input) => mutate(rpc, STAGE1_RPC.getWorkRules, input),
    saveWorkRules: (input) => mutate(rpc, STAGE1_RPC.saveWorkRules, input),
    listBudgets: () => mutate(rpc, STAGE1_RPC.listBudgets, null),
    listTemplates: () => mutate(rpc, STAGE1_RPC.listTemplates, null),
    saveTemplate: (input) => mutate(rpc, STAGE1_RPC.saveTemplate, input),
    getAgencyRules: () => mutate(rpc, STAGE1_RPC.getAgencyRules, null),
    saveAgencyRules: (input) => mutate(rpc, STAGE1_RPC.saveAgencyRules, input),
    enqueueLaunch: (input) => mutate(rpc, STAGE1_RPC.enqueueLaunch, input),
    dequeueLaunch: (input) => mutate(rpc, STAGE1_RPC.dequeueLaunch, input),
    saveRuleSchedule: (input) => mutate(rpc, STAGE1_RPC.saveRuleSchedule, input),
    listRuleSchedules: () => mutate(rpc, STAGE1_RPC.listRuleSchedules, null),
    previewSchedule: (input) => mutate(rpc, STAGE1_RPC.previewSchedule, input),
    getWebhookSource: (input) => mutate(rpc, STAGE1_RPC.getWebhookSource, input),
    rotateWebhookSecret: (input) => mutate(rpc, STAGE1_RPC.rotateWebhookSecret, input),
    saveSourceTopics: (input) => mutate(rpc, STAGE1_RPC.saveSourceTopics, input),
    listBackups: () => mutate(rpc, STAGE1_RPC.listBackups, null),
    createBackup: () => mutate(rpc, STAGE1_RPC.createBackup, null),
    restoreBackup: (input) => mutate(rpc, STAGE1_RPC.restoreBackup, input),
    listKnowledge: () => mutate(rpc, STAGE1_RPC.listKnowledge, null),
    saveKnowledge: (input) => mutate(rpc, STAGE1_RPC.saveKnowledge, input),
    setKnowledgeStatus: (input) => mutate(rpc, STAGE1_RPC.setKnowledgeStatus, input),
    listGoals: () => mutate(rpc, STAGE1_RPC.listGoals, null),
    saveGoal: (input) => mutate(rpc, STAGE1_RPC.saveGoal, input),
    setJobGoal: (input) => mutate(rpc, STAGE1_RPC.setJobGoal, input),
    setDepartmentParent: (input) => mutate(rpc, STAGE1_RPC.setDepartmentParent, input),
    agentMetrics: (input) => mutate(rpc, STAGE1_RPC.agentMetrics, input),
    searchJobs: (input) => mutate(rpc, STAGE1_RPC.searchJobs, input),
    listArchivedJobs: (input) => mutate(rpc, STAGE1_RPC.listArchivedJobs, input),
    listSavedViews: () => mutate(rpc, STAGE1_RPC.listSavedViews, null),
    listPlugins: () => mutate(rpc, STAGE1_RPC.listPlugins, null),
    addJobDependency: (input) => mutate(rpc, STAGE1_RPC.addJobDependency, input),
    removeJobDependency: (input) => mutate(rpc, STAGE1_RPC.removeJobDependency, input),
    setJobNextStep: (input) => mutate(rpc, STAGE1_RPC.setJobNextStep, input),
    listOwnerMessages: (input) => mutate(rpc, STAGE1_RPC.listOwnerMessages, input),
    markOwnerMessagesRead: (input) => mutate(rpc, STAGE1_RPC.markOwnerMessagesRead, input),
    saveSavedView: (input) => mutate(rpc, STAGE1_RPC.saveSavedView, input),
    deleteSavedView: (input) => mutate(rpc, STAGE1_RPC.deleteSavedView, input),
    cancelLaunch: (input) => mutate(rpc, STAGE1_RPC.cancelLaunch, input),
    createActivity: (input) => mutate(rpc, STAGE1_RPC.createActivity, input),
    createArtifact: (input) => mutate(rpc, STAGE1_RPC.createArtifact, input),
    publishArtifactVersion: (input) => mutate(rpc, STAGE1_RPC.publishArtifactVersion, input),
    acceptArtifactVersion: (input) => mutate(rpc, STAGE1_RPC.acceptArtifactVersion, input),
    openArtifact: (input) => mutate(rpc, STAGE1_RPC.openArtifact, input),
    resolveArtifactPreview: (input) => mutate(rpc, STAGE1_RPC.resolveArtifactPreview, input),
    async prepareLaunch(input) {
      const result = await mutate<unknown>(rpc, STAGE1_RPC.prepareLaunch, input);
      if (!result.ok) return result;
      const parsed = parsePrepareLaunch(result.value);
      if (!parsed) return { ok: false, failure: { kind: "transport", message: tr("prepareLaunch вернул неизвестный формат.") } };
      return { ok: true, value: parsed };
    },
    async getLaunch(input) {
      const result = await mutate<unknown>(rpc, STAGE1_RPC.getLaunch, input);
      if (!result.ok) return result;
      const parsed = parseLaunchReceipt(result.value);
      if (!parsed) return { ok: false, failure: { kind: "transport", message: tr("getLaunch вернул неизвестный формат.") } };
      return { ok: true, value: parsed };
    },
    async reconcileLaunch(input) {
      const result = await mutate<unknown>(rpc, STAGE1_RPC.reconcileLaunch, input);
      if (!result.ok) return result;
      const parsed = parseCoordinator(result.value);
      if (!parsed) return { ok: false, failure: { kind: "transport", message: tr("reconcileLaunch вернул неизвестный формат.") } };
      return { ok: true, value: parsed };
    },
    async interpretWorkerCompletion(input) {
      const result = await mutate<unknown>(rpc, STAGE1_RPC.interpretWorkerCompletion, input);
      if (!result.ok) return result;
      const parsed = parseCompletion(result.value);
      if (!parsed) return { ok: false, failure: { kind: "transport", message: tr("interpretWorkerCompletion вернул неизвестный формат.") } };
      return { ok: true, value: parsed };
    },
    async listJobAttempts(input) {
      const result = await mutate<unknown>(rpc, STAGE1_RPC.listJobAttempts, input);
      if (!result.ok) return result;
      const parsed = parseJobAttempts(result.value);
      if (!parsed) return { ok: false, failure: { kind: "transport", message: tr("listJobAttempts вернул неизвестный формат.") } };
      return { ok: true, value: parsed };
    },
    async answerNeedsInput(input) {
      const result = await mutate<unknown>(rpc, STAGE1_RPC.answerNeedsInput, input);
      if (!result.ok) return result;
      const parsed = answerNeedsInputRecordSchema.safeParse(result.value);
      if (!parsed.success) return { ok: false, failure: { kind: "transport", message: tr("answerNeedsInput вернул неизвестный формат.") } };
      return { ok: true, value: parsed.data };
    },
    async getIsolationReadiness(input = {}) {
      const result = await mutate<unknown>(rpc, STAGE1_RPC.getIsolationReadiness, input);
      if (!result.ok) return result;
      const parsed = parseIsolationReadiness(result.value);
      if (!parsed) return { ok: false, failure: { kind: "transport", message: tr("getIsolationReadiness вернул неизвестный формат.") } };
      return { ok: true, value: parsed };
    },
    async listDashboardUsage(input = {}) {
      const result = await mutate<unknown>(rpc, STAGE1_RPC.listDashboardUsage, input);
      if (!result.ok) return result;
      const parsed = listDashboardUsageOutputSchema.safeParse(result.value);
      if (!parsed.success) return { ok: false, failure: { kind: "transport", message: tr("listDashboardUsage вернул неизвестный формат.") } };
      return { ok: true, value: parsed.data };
    },
    async saveEventDefinition(input) {
      const result = await mutate<unknown>(rpc, DISPATCHER_RPC.saveEventDefinition, input);
      if (!result.ok) return result;
      const parsed = eventDefinitionRecordSchema.safeParse(result.value);
      if (!parsed.success) return { ok: false, failure: { kind: "transport", message: tr("saveEventDefinition вернул неизвестный формат.") } };
      return { ok: true, value: parsed.data };
    },
    async saveEventSource(input) {
      const result = await mutate<unknown>(rpc, DISPATCHER_RPC.saveEventSource, input);
      if (!result.ok) return result;
      const parsed = eventSourceRecordSchema.safeParse(result.value);
      if (!parsed.success) return { ok: false, failure: { kind: "transport", message: tr("saveEventSource вернул неизвестный формат.") } };
      return { ok: true, value: parsed.data };
    },
    async saveRuleVersion(input) {
      const result = await mutate<unknown>(rpc, DISPATCHER_RPC.saveRuleVersion, input);
      if (!result.ok) return result;
      const parsed = ruleVersionRecordSchema.safeParse(result.value);
      if (!parsed.success) return { ok: false, failure: { kind: "transport", message: tr("saveRuleVersion вернул неизвестный формат.") } };
      return { ok: true, value: parsed.data };
    },
    async ingestInboxEvent(input) {
      const result = await mutate<unknown>(rpc, DISPATCHER_RPC.ingestInboxEvent, input);
      if (!result.ok) return result;
      const parsed = inboxEventRecordSchema.safeParse(result.value);
      if (!parsed.success) return { ok: false, failure: { kind: "transport", message: tr("ingestInboxEvent вернул неизвестный формат.") } };
      return { ok: true, value: parsed.data };
    },
    async dispatchTick(input) {
      const result = await mutate<unknown>(rpc, DISPATCHER_RPC.dispatchTick, { ...input, live: false });
      if (!result.ok) return result;
      const parsed = dispatchTickRecordSchema.safeParse(result.value);
      if (!parsed.success) return { ok: false, failure: { kind: "transport", message: tr("dispatchTick вернул неизвестный формат.") } };
      return { ok: true, value: parsed.data };
    },
    async listActionIntents(input = {}) {
      const result = await mutate<unknown>(rpc, DISPATCHER_RPC.listActionIntents, input);
      if (!result.ok) return result;
      const parsed = listedActionIntentSchema.array().safeParse(result.value);
      if (!parsed.success) return { ok: false, failure: { kind: "transport", message: tr("listActionIntents вернул неизвестный формат.") } };
      return { ok: true, value: parsed.data };
    },
    async listEventDefinitions(input = {}) {
      const result = await mutate<unknown>(rpc, DISPATCHER_RPC.listEventDefinitions, input);
      if (!result.ok) return result;
      const parsed = eventDefinitionRecordSchema.array().safeParse(result.value);
      if (!parsed.success) return { ok: false, failure: { kind: "transport", message: tr("listEventDefinitions вернул неизвестный формат.") } };
      return { ok: true, value: parsed.data };
    },
    async listEventSources(input = {}) {
      const result = await mutate<unknown>(rpc, DISPATCHER_RPC.listEventSources, input);
      if (!result.ok) return result;
      const parsed = eventSourceRecordSchema.array().safeParse(result.value);
      if (!parsed.success) return { ok: false, failure: { kind: "transport", message: tr("listEventSources вернул неизвестный формат.") } };
      return { ok: true, value: parsed.data };
    },
    async listRuleVersions(input = {}) {
      const result = await mutate<unknown>(rpc, DISPATCHER_RPC.listRuleVersions, input);
      if (!result.ok) return result;
      const parsed = catalogRuleRecordSchema.array().safeParse(result.value);
      if (!parsed.success) return { ok: false, failure: { kind: "transport", message: tr("listRuleVersions вернул неизвестный формат.") } };
      return { ok: true, value: parsed.data };
    },
    async claimActionIntent(input) {
      const result = await mutate<unknown>(rpc, DISPATCHER_RPC.claimActionIntent, { ...input, live: false });
      if (!result.ok) return result;
      const parsed = actionIntentRecordSchema.safeParse(result.value);
      if (!parsed.success) return { ok: false, failure: { kind: "transport", message: tr("claimActionIntent вернул неизвестный формат.") } };
      return { ok: true, value: parsed.data };
    },
    async approveActionIntent(input) {
      const result = await mutate<unknown>(rpc, DISPATCHER_RPC.approveActionIntent, input);
      if (!result.ok) return result;
      const parsed = actionIntentRecordSchema.safeParse(result.value);
      if (!parsed.success) return { ok: false, failure: { kind: "transport", message: tr("approveActionIntent вернул неизвестный формат.") } };
      return { ok: true, value: parsed.data };
    },
  };
}
