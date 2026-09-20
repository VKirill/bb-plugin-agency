import { backupsDirFor, createBackup, listBackups, restoreBackup } from "./backup/service";
import { scanSandboxEscapes } from "./runtime/sandbox-escape/service";
import { getKnowledge, KNOWLEDGE_KINDS, knowledgeOrder, listKnowledge, markKnowledgeRead, saveKnowledge, setKnowledgeStatus, type SaveKnowledgeInput } from "./knowledge/store";
import { draftLesson, expireLessons, proposeLessonForJob, trimAllDepartments } from "./knowledge/lessons";
import { getDecisionSettings, saveDecisionSettings, type SaveDecisionSettingsInput } from "./decisions/settings";
import { askMemoryGate } from "./decisions/memory-gate";
import { askBriefingDetailed, BRIEFING_POINT } from "./decisions/briefing";
import { recordLeadIntake } from "./decisions/intake";
import { askHandInGate } from "./decisions/hand-in-gate";
import { probeDecisionPoints } from "./decisions/probe";
import { appendDecisionLog, decisionLogLine, formatDecisionAnswers, listDecisionLog } from "./decisions/log";
import { listSkillGrants, listSkillPool, logSkillGrants, setSkillPool } from "./organization/skill-pool";
import { askDecisions } from "./decisions/client";
import { DECISION_POINTS } from "../shared/decisions";
import { listEnvKeyOptions, putEnvKey, resolveDecisionKey } from "./decisions/key";
import { knowledgeDecisionRefusal } from "./knowledge/decide";
import { listGoals, saveGoal, setJobGoal } from "./organization/goals";
import { getIdea, listIdeas, saveIdea, setIdeaFileHash, setIdeaStatus } from "./ideas/store";
import { writeIdeaFile } from "./ideas/files";
import { presentIdea } from "./ideas/view";
import type { ListIdeasInput, SaveIdeaInput, SpawnIdeaThreadInput } from "../shared/contracts/idea";
import { buildIdeaThreadSpawn } from "./ideas/thread";
import { setDepartmentParent, sweepEscalations } from "./organization/hierarchy";
import { agentMetrics } from "./insights/metrics";
import { deleteSavedView, listSavedViews, saveSavedView, searchJobs } from "./insights/archive";
import { listJobsForBindings } from "./api/catalog";
import { archivedJobIds, DEFAULT_ARCHIVE_AFTER_DAYS } from "./insights/archive";
import { sweepTelegramOutbox } from "./triggers/telegram-outbox";
import { listRuleSchedules, previewSchedule, saveRuleSchedule, tickSchedules } from "./triggers/schedules";
import { rotateWebhookSecret, saveSourceTopics, sourceTopics, WEBHOOK_SECRETS_FILENAME, webhookSecretBytes, webhookSecretIssuedAt } from "./triggers/webhook-secrets";
import { createCatalogWebhookSourcePort, createDurableWebhookInbox } from "./triggers/durable-inbox";
import { handleWebhookIngress } from "./triggers/webhook-ingress/ingress";
import { createWebhookRateLimiter } from "./triggers/webhook-ingress/rate-limit";
import { reviewJobText, type AutoReviewPorts } from "./runtime/auto-review/service";
import {
  advanceAfterHandIn,
  closeBlockedReviewStation,
  productReadyMessage,
  sweepStaleReviewStations,
  type ConveyorPorts,
} from "./runtime/conveyor";
import { claimActionIntent, completeActionIntent, dispatchTick, listActionIntents } from "./dispatcher/engine";
import { createIntentJobPort } from "./dispatcher/job-port";
import { dequeueLaunch, enqueueLaunch, LAUNCH_QUEUE_SWEEP_MS, listAssignedBacklogJobIds, listLaunchQueue, refusalIfLaunchDidNotStart, reopenDroppedAssignedJobs, repairQueuedJobs, sweepLaunchQueue } from "./runtime/launch-queue/service";
import { uuidV5 } from "./runtime/launch/operation-ids";

const LAUNCH_QUEUE_NAMESPACE = "3d5f1c2e-7a4b-4c8d-9e6f-0a1b2c3d4e5f";
const DISPATCHER_SWEEP_MS = 30_000;
/** Сколько паспортов пересобирается за один обход диспетчера. */
const PASSPORT_BUILDS_PER_SWEEP = 3;
import { pinCurrentSkills, readSkillPinStatus, type SkillPinDeps } from "./runtime/isolated-sdk/skill-pin";
import { createSdkSkillCatalogPort } from "./runtime/isolated-sdk";
import { withCallerThread } from "./api/caller";
import { attachDashboardUsageCollector, USAGE_CHANGED_CHANNEL } from "./api/dashboard-usage-rpc";
import { createDashboardUsageReader, dashboardUsageCatalogFromSql } from "./runtime/dashboard-usage";
import { PROVEN_USAGE_PROVIDER_IDS } from "./runtime/dashboard-usage/units";
import { listStoredBindings, listStoredDepartments, listStoredPolicies } from "./api/catalog";
import { checkLaunchLimits, listBudgets, type LimitDeps } from "./rules/limits";
import { acceptedVersions, assertDependenciesDone, sweepNextSteps, type NextStepPorts } from "./flow/service";
import { assertSpecAccepted } from "./flow/spec-gate";
import { assertOwnershipFree } from "./flow/ownership";
import { recheckJobText, sweepNightlyRecheck, type NightlyRecheckPorts } from "./runtime/nightly-recheck/service";
import { buildDigest, listOwnerMessages, markOwnerMessagesRead, readOwnerMessage, recordOwnerMessage, scriptTemplates, setTelegramState } from "./owner-messages/service";
import { serverDay } from "./runtime/nightly-recheck/service";
import { sweepRemarkPatterns } from "./knowledge/remark-patterns";
import { agentDeleteBlocker, archiveDepartment, deleteAgent, deleteDepartment, departmentArchivedAt, departmentDeleteBlocker, restoreDepartment } from "./organization/lifecycle";
import { installStarterKit, starterKitView, translateStarterKit, type StarterKitPorts } from "./organization/starter-kit";
import { rulesForDepartment, rulesForLaunch, workRulesView } from "./rules/work-rules";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { rpcContract, type AgentModelsView, type ProviderUsageView } from "../shared/rpc-contract";
import { openDatabase } from "./db/database";
import { createInbox } from "./inbox/store";
import { receiveNotification } from "./triggers/notify";
import { STATUS_REQUIRES_READINESS_REASON } from "../shared/schemas";
import { machineDirectory } from "./runtime/machines";
import { telegramAdapter } from "./triggers/telegram";
import { createInstructionDetector, createPluginDirectory, FILE_GATEWAY_PLUGIN_ID, PROJECT_FOLDERS_PLUGIN_ID } from "./integrations/plugin-directory";
import { documentHostContract } from "../shared/document-contract";
import { createDomainStore } from "./services";
import { createDomainRpc } from "./api/domain-rpc";
import { join } from "node:path";
import { createIsolatedLaunchRpc, listBoundLaunchWatches } from "./api/launch-rpc";
import { createDispatcherRpc } from "./api/dispatcher-rpc";
import { createExecutingActivityRpc } from "./api/executing-activity-rpc";
import {
  applyVerifiedCompletionLifecycle,
  attachDisposableThreadHints,
  bindOfficialThreads,
  createIsolatedSendPort,
  createCompletionWatch,
  createReadingChangeGate,
  isolatedViewFromRecord,
  ISOLATED_CATALOG_ROLES_FILENAME,
  readJobPublishedArtifact,
  resolveIsolatedCatalogRolesPath,
} from "./runtime/isolated-sdk";
import { createInternalRunStoreReads, createRunStore } from "./runtime/run-store";
import { flushParentWakes, recoverParentWakesFromActivities } from "./runtime/parent-wake";
import { enqueueProductReady, flushClientBounces, recoverClientBouncesFromOpenWaits } from "./runtime/client-bounce";
import { presentOwnerQuestions, presentOwnerQuestionsForCli, registerOwnerQuestionTool } from "./runtime/owner-question";
import { returnJobForRework } from "./runtime/rework/service";
import { bindJobCommentHandler, readCliThreadId } from "./comments/register-glue";
import { CLI_COMMAND_SPECS, runAgencyCli, type CliOperation } from "./cli";
import { resolveRpcAccess } from "./api/auth";
import { createHash, randomUUID } from "node:crypto";
import { remindIncompleteWorker, type ReminderPorts } from "./runtime/completion-reminder/service";
import type { Job } from "../shared/contracts";
import type { ServiceContext } from "./services/context";
import { agencyLanguage, setAgencyLanguage } from "./i18n/language";
import {
  DEFAULT_MODEL_PRICES,
  MODEL_PRICES_CHECKED_AT,
  MODEL_PRICES_SOURCE,
  modelPriceOverridesJson,
  modelPriceRows,
  parseModelPriceOverrides,
  type ModelPriceTable,
} from "./runtime/dashboard-usage/pricing";
import { fail, ok } from "../domain/result";
import { deleteWorkProfile, listWorkProfiles, saveWorkProfile } from "./projects/work-profiles";
import { deletePassport, getPassport, listPassportVersions, rollbackPassport, writePassport } from "./projects/passport.js";
import { readProjectRulesFile } from "./api/project-rules.js";
import { projectAccessAllowed, type ProjectCaller } from "./api/project-access.js";
import { PASSPORT_GATE_POINT } from "./decisions/passport-gate.js";
import { getPassportSettings, savePassportSettings, type SavePassportSettingsInput } from "./projects/passport-settings.js";
import { buildPassport, collectPassportMaterial, projectsDueForPassport, type ProjectRulesRead } from "./projects/passport-build.js";
import { PASSPORT_DELIVERIES, passportText, type PassportSectionKey } from "../shared/passport.js";
import { modelChoiceNote, resolveModelChoice, type CatalogModel } from "./runtime/model-fallback";
import { fallbackSwitchText, markModelExhausted, nextFreshCandidate } from "./runtime/agent-fallback";
import { lastProgressFromDatabase, superviseRun, type RunWatchPorts } from "./runtime/run-watch/service";
import { fallbackModelKey, optionalFallbackModels } from "../shared/contracts";
import { DUE_SWEEP_INTERVAL_MS, sweepDueReminders } from "./runtime/due-reminder/service";
import { DEFAULT_BOARD_POLICY, type BoardPolicy } from "../shared/contracts";
import { buildAgencyInstructions, DELEGATION_MODES, parseDelegationMode, type DelegationMode } from "./delegation/instructions";
import { resolveSessionPolicy, saveSessionPolicy } from "./delegation/session-policy";

export function registerAgency(bb: BbPluginApi) {
  const documents = bb.hosts.experimental_client({ contract: documentHostContract });
  const prepareDemoDocument = async (
    input: Parameters<typeof documentHostContract.materialize.input.parse>[0],
  ) => {
    const parsed = documentHostContract.materialize.input.parse(input);
    const { primaryHostId } = await bb.sdk.system.config();
    if (!primaryHostId) throw new Error("Основная машина BB недоступна.");
    const result = await documents.call("materialize", parsed, { hostId: primaryHostId });
    return { hostId: primaryHostId, path: result.path, demo: true as const };
  };
  const telegram=telegramAdapter(bb);
  const machines=machineDirectory(bb);
  const db = openDatabase(bb);
  const inbox = createInbox(db);
  const plugins = createPluginDirectory({ listPlugins: () => bb.sdk.plugins.list(), addsInstructions: createInstructionDetector() });
  // Rules ask synchronously; the cache is filled at start and refreshed by the dispatcher loop.
  void plugins.list().catch(() => undefined);
  const store = createDomainStore(db, {
    features: () => ({
      projectFolders: plugins.runningCached(PROJECT_FOLDERS_PLUGIN_ID),
      fileGateway: plugins.runningCached(FILE_GATEWAY_PLUGIN_ID),
    }),
  });
  const onChanged = () => bb.realtime.publish("domain-changed", null);
  const officialThreads = bindOfficialThreads(bb.sdk.threads);
  const send = createIsolatedSendPort(officialThreads);
  const workSettings = bb.settings.define({
    delegationInstructions: {
      type: "select",
      label: "Инструкция делегирования в сессиях",
      description:
        "Запасной режим, если у проекта нет своей политики чатов. delegate — чат работает как менеджер Агентства (сам не делает, ставит поручения); suggest — спрашивает, сделать здесь или через Агентство; off — не добавлять, модель про Агентство не знает. Проект и этот чат можно сменить списком в поле ввода, слева от MoA.",
      options: [...DELEGATION_MODES],
      default: "delegate",
    },
    hideClosedSubtasksAfterHours: {
      type: "number",
      label: "Скрывать готовые подзадачи через, ч",
      description: "Готовые и отменённые подзадачи уходят с доски в «Скрытые». 0 — не скрывать.",
      default: DEFAULT_BOARD_POLICY.hideClosedSubtasksAfterHours,
    },
    hideClosedMainTasksAfterHours: {
      type: "number",
      label: "Скрывать готовые задачи без родителя через, ч",
      description: "Главные и самостоятельные задачи. 0 — не скрывать.",
      default: DEFAULT_BOARD_POLICY.hideClosedMainTasksAfterHours,
    },
    wipLimitQueued: { type: "number", label: "Лимит WIP: «К запуску»", description: "Мягкий лимит колонки канбана: при превышении заголовок подсвечивается, задачи не блокируются. 0 — без лимита.", default: 0 },
    wipLimitRunning: { type: "number", label: "Лимит WIP: «В работе»", description: "Мягкий лимит колонки канбана. 0 — без лимита.", default: 0 },
    wipLimitAttention: { type: "number", label: "Лимит WIP: «Нужен ответ»", description: "Мягкий лимит колонки канбана. 0 — без лимита.", default: 0 },
    wipLimitReview: { type: "number", label: "Лимит WIP: «На проверке»", description: "Мягкий лимит колонки канбана. 0 — без лимита.", default: 0 },
    archiveClosedAfterDays: {
      type: "number",
      label: "Убирать закрытые задачи в архив через, дней",
      description: "Главная задача и все её подзадачи закрыты дольше этого срока — дерево уходит из рабочей доски в архив (поиск и «Архив»). 0 — не архивировать.",
      default: DEFAULT_ARCHIVE_AFTER_DAYS,
    },
    language: {
      type: "select",
      label: "Язык Агентства / Agency language",
      description:
        "На каком языке сотрудники пишут задачи, отчёты, комментарии и вопросы владельцу, и на каком Агентство пишет системные комментарии. Инструкции агентам всегда на английском, язык задаётся в них одной строкой. ru — русский, en — English.",
      options: ["ru", "en"],
      default: "ru",
    },
    modelPricesJson: {
      type: "string",
      label: "Цены моделей для оценки стоимости, JSON",
      description:
        'Заполняется таблицей в Агентстве: Настройки → Цены моделей. Здесь лежит то же самое в виде JSON, USD за миллион токенов: {"gpt-5.6-sol": {"input": 1.25, "cachedInput": 0.125, "output": 10}}. Цены Claude встроены, в настройке хранятся только отличия.',
      experimental_multiline: true,
    },
  });
  // Instruction providers are synchronous; keep the last known settings in memory.
  let delegationMode: DelegationMode = "delegate";
  let boardPolicy: BoardPolicy = { ...DEFAULT_BOARD_POLICY };
  let archiveAfterDays = DEFAULT_ARCHIVE_AFTER_DAYS;
  let modelPrices: ModelPriceTable = DEFAULT_MODEL_PRICES;
  let modelPricesError: string | null = null;
  const applyWorkSettings = (values: {
    delegationInstructions: string;
    hideClosedSubtasksAfterHours: number;
    hideClosedMainTasksAfterHours: number;
    archiveClosedAfterDays?: number;
    wipLimitQueued?: number;
    wipLimitRunning?: number;
    wipLimitAttention?: number;
    wipLimitReview?: number;
    modelPricesJson?: string;
    language?: string;
  }) => {
    setAgencyLanguage(values.language);
    delegationMode = parseDelegationMode(values.delegationInstructions);
    const prices = parseModelPriceOverrides(values.modelPricesJson);
    if (prices.error) bb.log.warn(`Model prices ignored: ${prices.error}`);
    modelPrices = prices.table;
    modelPricesError = prices.error;
    archiveAfterDays = typeof values.archiveClosedAfterDays === "number" && Number.isFinite(values.archiveClosedAfterDays) ? Math.max(0, Math.min(3650, Math.round(values.archiveClosedAfterDays))) : DEFAULT_ARCHIVE_AFTER_DAYS;
    boardPolicy = {
      hideClosedSubtasksAfterHours: clampHours(values.hideClosedSubtasksAfterHours, DEFAULT_BOARD_POLICY.hideClosedSubtasksAfterHours),
      hideClosedMainTasksAfterHours: clampHours(values.hideClosedMainTasksAfterHours, DEFAULT_BOARD_POLICY.hideClosedMainTasksAfterHours),
      wipLimits: {
        queued: clampWip(values.wipLimitQueued),
        running: clampWip(values.wipLimitRunning),
        attention: clampWip(values.wipLimitAttention),
        review: clampWip(values.wipLimitReview),
      },
    };
  };
  void workSettings.get().then(applyWorkSettings, () => undefined);
  workSettings.onChange((next) => {
    applyWorkSettings(next);
    onChanged();
  });
  // Machine names for instructions; the provider is synchronous, so keep a refreshed copy.
  let hostNames = new Map<string, string>();
  let hostNamesAt = 0;
  const refreshHostNames = () => {
    hostNamesAt = Date.now();
    void Promise.resolve()
      .then(() => bb.sdk.hosts.list())
      .then(
      (hosts) => {
        hostNames = new Map(hosts.map((host) => [host.id, host.name]));
      },
      () => undefined,
    );
  };
  bb.agents.contributeInstructions((ctx) => {
    try {
      if (Date.now() - hostNamesAt > 10 * 60 * 1000) refreshHostNames();
      return buildAgencyInstructions(db, ctx, delegationMode, (hostId) => hostNames.get(hostId));
    } catch (error) {
      bb.log.warn(`Agency instructions for ${ctx.threadId}: ${String(error)}`);
      return null;
    }
  });
  const ownerQuestion = {
    bb,
    db,
    store,
    reads: createInternalRunStoreReads(db),
    runs: createRunStore(db),
    send,
  };
  const ownerQuestionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const scheduleOwnerQuestion = (originThreadId: string) => {
    const previous = ownerQuestionTimers.get(originThreadId);
    if (previous) clearTimeout(previous);
    ownerQuestionTimers.set(
      originThreadId,
      setTimeout(() => {
        ownerQuestionTimers.delete(originThreadId);
        void presentOwnerQuestions(ownerQuestion, { threadId: originThreadId }).catch((error) => {
          bb.log.warn(`Agency owner question card for ${originThreadId}: ${String(error)}`);
        });
      }, 500),
    );
  };
  bb.onDispose(() => {
    for (const timer of ownerQuestionTimers.values()) clearTimeout(timer);
    ownerQuestionTimers.clear();
  });
  if (typeof bb.agents.registerTool === "function") {
    registerOwnerQuestionTool(bb, ownerQuestion);
  }
  const domain = createDomainRpc({
    bb,
    store,
    db,
    onChanged,
    documents,
    send,
    boardPolicy: () => boardPolicy,
    archivedJobIds: () => archivedJobIds(db, archiveAfterDays, new Date()),
    onProductReady: (message) => {
      void sendOwnerMessage(message, "conveyor");
      const ready = store.getJob(message.jobId);
      if (ready) enqueueProductReady(db, ready, new Date().toISOString());
      void flushClientBounces({ db, send, now: new Date().toISOString() }).catch(() => undefined);
    },
    onOwnerQuestion: scheduleOwnerQuestion,
    onAccepted: (jobId) => {
      const job = store.getJob(jobId);
      if (!job) return;
      const rules = rulesForDepartment(db, job.departmentId);
      void (async () => {
        const now = new Date().toISOString();
        // Оценщик спрашивается до записи и только если владелец его включил; молчит — пишем как обычно.
        const draft = draftLesson(db, jobId, now);
        const verdict = draft
          ? await askMemoryGate(
              getDecisionSettings(db),
              { title: draft.title, summary: draft.summary, body: draft.body },
              listKnowledge(db, { scopeKind: "department", scopeId: draft.departmentId, status: "accepted" }),
            ).catch(() => null)
          : null;
        const written = proposeLessonForJob(db, jobId, now, {
          autoLearn: rules.autoLearn,
          memoryLimit: rules.memoryLimit,
          verdict,
        });
        if (!written.ok) return;
        if (written.value.rejected) {
          void sendOwnerMessage(
            { text: `Урок после приёмки ${job.key} не записан. ${written.value.rejected}`, dedupeKey: `lesson-skip:${job.id}` },
            "lesson",
          );
          return;
        }
        if (!written.value.proposed) return;
        const lesson = written.value.proposed;
        const archived = written.value.archived?.length ?? 0;
        void sendOwnerMessage(
          {
            text:
              lesson.status === "accepted"
                ? `Отдел запомнил: «${lesson.title}». Запись уже приходит в его запуски — поправьте или уберите её в «Знаниях».${archived ? ` Старых записей ушло в архив: ${archived}.` : ""}`
                : `Предложен урок после приёмки: «${lesson.title}». Примите или поправьте его в «Знаниях» — принятое приходит во все запуски отдела.`,
            dedupeKey: `lesson:${lesson.id}`,
          },
          "lesson",
        );
        onChanged();
      })();
    },
  });
  const catalogRolesSettings = bb.settings.define({
    isolatedCatalogRolesJson: {
      type: "string",
      label: "Isolated catalog roles JSON",
      description:
        "agency-isolated-catalog-roles-v1: hostId + core/helpers id, source, package hash. Not a public prepare field.",
      experimental_multiline: true,
    },
  });
  const dashboardUsage = attachDashboardUsageCollector({
    db,
    events: bb.sdk.threads.events,
    onUsageChanged: () => bb.realtime.publish(USAGE_CHANGED_CHANNEL, null),
    prices: () => modelPrices,
  });
  bb.onDispose(() => dashboardUsage.dispose());
  // Monthly spend for budgets counts every binding, not only the caller's.
  const spendReader = createDashboardUsageReader({
    reads: createInternalRunStoreReads(db),
    catalog: dashboardUsageCatalogFromSql(db),
    events: dashboardUsage.collector.events,
    prices: () => modelPrices,
  });
  const limitDeps: LimitDeps = {
    db,
    spend: async (filter) => {
      const ctx = { actor: { kind: "system" as const }, allowedBindingIds: listStoredBindings(db).map((row) => row.id) };
      const usage = await spendReader.listDashboardUsage(ctx, filter);
      return usage.ok ? usage.value.costUsdCents : null;
    },
  };
  /** Every launch, by hand or from the queue: the jobs it depends on are done, then the limits. */
  const checkLaunchGate = async (job: Job, pendingJobIds: readonly string[] = []) => {
    const en = agencyLanguage() === "en";
    const dependencies = assertDependenciesDone(db, job, en);
    if (!dependencies.ok) return dependencies;
    const spec = assertSpecAccepted(db, job, rulesForDepartment(db, job.departmentId), en);
    if (!spec.ok) return spec;
    const ownership = assertOwnershipFree(db, job, en, pendingJobIds);
    if (!ownership.ok) return ownership;
    return checkLaunchLimits(limitDeps, job, pendingJobIds);
  };
  const catalogRolesFile = join(bb.server.experimental_dataDir, ISOLATED_CATALOG_ROLES_FILENAME);
  const resolveCatalogRoles = async () => {
    const settings = await catalogRolesSettings.get();
    return resolveIsolatedCatalogRolesPath({
      settingsJson: settings.isolatedCatalogRolesJson,
      envFilePath: process.env.AGENCY_ISOLATED_CATALOG_ROLES_FILE,
      dataDirFilePath: catalogRolesFile,
    });
  };
  const skillPinDeps: SkillPinDeps = {
    catalog: createSdkSkillCatalogPort(bb.sdk.skills),
    scope: () => {
      const binding = listStoredBindings(db).find((row) => !row.archivedAt);
      return binding ? { projectId: binding.bbProjectId, environmentId: binding.environmentId, hostId: binding.hostId } : null;
    },
    load: resolveCatalogRoles,
    dataDirFilePath: catalogRolesFile,
    writeSettings: async (json) => {
      await catalogRolesSettings.experimental_set({ isolatedCatalogRolesJson: json });
    },
    now: () => new Date(),
  };
  /**
   * Models this BB can actually run on a machine. Asked often (kit install, launch readiness,
   * the employee card), so the answer lives a minute; an empty catalog means "unknown" and
   * nothing is blocked because of it.
   */
  const modelCatalogCache = new Map<string, { at: number; models: CatalogModel[] }>();
  const modelCatalog = async (hostId?: string): Promise<CatalogModel[]> => {
    const key = hostId ?? "";
    const cached = modelCatalogCache.get(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.models;
    const models: CatalogModel[] = [];
    try {
      const providers = await bb.sdk.providers.list(
        hostId ? { hostId, signal: AbortSignal.timeout(12_000) } : { signal: AbortSignal.timeout(12_000) },
      );
      for (const provider of providers.filter((item) => item.available)) {
        try {
          const options = await bb.sdk.providers.models(
            hostId
              ? { hostId, providerId: provider.id, signal: AbortSignal.timeout(12_000) }
              : { providerId: provider.id, signal: AbortSignal.timeout(12_000) },
          );
          for (const model of options.models) {
            models.push({ providerId: provider.id, model: model.model, isDefault: model.isDefault, displayName: model.displayName });
          }
        } catch {
          // One CLI without a catalog must not hide the models of the others.
        }
      }
    } catch {
      return [];
    }
    modelCatalogCache.set(key, { at: Date.now(), models });
    return models;
  };

  /** Before a launch: the machine really has this model, or the reason names the closest one. */
  const checkModel = async (input: { hostId: string; providerId: string; model: string }) => {
    const catalog = await modelCatalog(input.hostId);
    if (!catalog.length) return ok(undefined);
    const choice = resolveModelChoice({ providerId: input.providerId, model: input.model }, catalog);
    if (choice.status === "exact") return ok(undefined);
    const en = agencyLanguage() === "en";
    const note = modelChoiceNote(choice, en) ?? "";
    const action = en
      ? " Open the employee profile and press «Pick an available model», or choose one by hand."
      : " Откройте профиль сотрудника и нажмите «Подобрать доступную модель» или выберите её вручную.";
    return fail("model_unavailable", `${note}${action}`);
  };

  const launch = createIsolatedLaunchRpc({
    bb,
    plugins,
    store,
    db,
    documents,
    onChanged,
    send,
    checkHost: (input) => machines.checkLaunch(input),
    checkModel,
    checkLimits: checkLaunchGate,
    comment: (job, text) => void systemComment(job, text),
    // Подсказка к запуску: оценщик выбирает навыки и записи памяти под конкретную работу, а из
    // библиотеки отдела открывает недостающее — на один запуск и с записью в журнал.
    briefing: async ({ job, skills, catalog }) => {
      const settings = getDecisionSettings(db);
      const access = resolveRpcAccess(db);
      const stored = store.getJobByKey(job.key);
      const intake = stored && access.ok
        ? recordLeadIntake({
            settings,
            job: stored,
            store,
            ctx: access.value.ctx,
            log: (entry) => {
              const row = appendDecisionLog(db, entry, new Date().toISOString());
              if (row) bb.log.info(decisionLogLine(row));
            },
          }).catch(() => undefined)
        : Promise.resolve();
      const own = new Set(skills.map((skill) => skill.id));
      const poolIds = new Set(listSkillPool(db, job.departmentId));
      const pool = catalog.filter((skill) => poolIds.has(skill.id) && !own.has(skill.id));
      const asked = await askBriefingDetailed(settings, {
        job,
        skills,
        pool,
        lessons: listKnowledge(db, { scopeKind: "department", scopeId: job.departmentId, status: "accepted" }).sort(knowledgeOrder),
      });
      await intake;
      const grantNames = asked.briefing?.granted.map((row) => row.skill.name).join("|") ?? "";
      const pickNames = asked.briefing?.skills.map((skill) => skill.name).join("|") ?? "";
      if (asked.reason !== "disabled") {
        const briefRow = appendDecisionLog(
          db,
          {
            point: BRIEFING_POINT,
            jobKey: job.key,
            outcome: asked.reason,
            detail: `method=${asked.candidates.skills} pool=${asked.candidates.pool} lessons=${asked.candidates.lessons}${pickNames ? ` picked=${pickNames}` : ""}${grantNames ? ` granted=${grantNames}` : ""}`,
            answers: asked.answers,
            ms: asked.ms,
          },
          new Date().toISOString(),
        );
        if (briefRow) bb.log.info(decisionLogLine(briefRow));
      }
      const result = asked.briefing;
      if (!result) return null;
      if (result.granted.length) {
        logSkillGrants(
          db,
          result.granted.map((row) => ({
            departmentId: job.departmentId,
            agentId: job.assignedAgentId,
            jobId: job.key,
            jobKey: job.key,
            skillId: row.skill.id,
            skillName: row.skill.name,
            decidedBy: "decision-model" as const,
            confidence: row.confidence,
          })),
          new Date().toISOString(),
        );
        onChanged();
      }
      return {
        text: result.text,
        addSkillIds: result.granted.map((row) => row.skill.id),
        lessonIds: result.lessons.map((lesson) => lesson.id),
      };
    },
    loadCatalogRoles: async () => {
      const resolved = await resolveCatalogRoles();
      if (!resolved.ok) return resolved;
      return { ok: true, value: resolved.value?.config };
    },
  });
  /** Backlog → queued, then into the launch queue; the sweep launches it through every launch check. */
  const queueJobForLaunch = (job: Job, requestId: string) => {
    const access = resolveRpcAccess(db);
    if (!access.ok) return access;
    if (job.state === "backlog") {
      const moved = store.transitionJob(access.value.ctx, { requestId, jobId: job.id, expectedRevision: job.revision, to: "queued" });
      if (!moved.ok) return moved;
    } else if (job.state !== "queued") {
      return { ok: false as const, error: { code: "illegal_job_state", message: "В очередь запуска ставится задача в бэклоге или в очереди." } };
    }
    enqueueLaunch(db, job.id, new Date().toISOString());
    onChanged();
    void runLaunchQueue();
    return { ok: true as const, value: job.id };
  };
  const autoReviewPorts = (): AutoReviewPorts => ({
    db,
    getJob: (jobId) => store.getJob(jobId),
    // The employee may switch auto review off for their own work; the department rule is the default.
    enabled: (job) => {
      // An assistant's brief is material for a colleague, not a result to review independently.
      const membership = job.assignedAgentId ? store.getMembership(job.departmentId, job.assignedAgentId) : null;
      if (membership?.role === "assistant") return false;
      return rulesForLaunch(db, job.departmentId, job.assignedAgentId ?? "").autoReview;
    },
    memberRole: (departmentId, agentId) => store.memberRole(departmentId, agentId),
    latestVersion: (jobId) => {
      const row = db
        .prepare(`SELECT artifact_id, version, hash FROM agency_artifact_version WHERE job_id = ? ORDER BY rowid DESC LIMIT 1`)
        .get(jobId) as { artifact_id: string; version: number; hash: string } | undefined;
      return row ? { artifactId: row.artifact_id, version: row.version, hash: row.hash } : null;
    },
    createReview: (job, version) => {
      const text = reviewJobText(job, version);
      return store.createJob(
        { actor: { kind: "system" }, allowedBindingIds: [job.bindingId] },
        {
          requestId: uuidV5(LAUNCH_QUEUE_NAMESPACE, `auto-review:${job.id}:${version.hash}`),
          bindingId: job.bindingId,
          departmentId: job.departmentId,
          title: text.title,
          brief: text.brief,
          acceptance: text.acceptance,
          parentJobId: job.parentJobId ?? job.id,
          assignedAgentId: null,
          assignment: "reviewer",
          priority: job.priority,
          dueAt: job.dueAt,
        },
      );
    },
    attachInput: async (review, job, version) =>
      (await domain.attachJobInput({
        requestId: uuidV5(LAUNCH_QUEUE_NAMESPACE, `auto-review-input:${review.id}:${version.hash}`),
        expectedRevision: review.revision,
        targetJobId: review.id,
        sourceJobId: job.id,
        artifactId: version.artifactId,
        version: version.version,
        hash: version.hash,
      })) as { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } },
    queue: (review) => queueJobForLaunch(review, uuidV5(LAUNCH_QUEUE_NAMESPACE, `auto-review-queue:${review.id}`)),
    discard: (review) => {
      store.transitionJob(
        { actor: { kind: "system" }, allowedBindingIds: [review.bindingId] },
        { requestId: uuidV5(LAUNCH_QUEUE_NAMESPACE, `auto-review-discard:${review.id}`), jobId: review.id, expectedRevision: review.revision, to: "canceled" },
      );
    },
    comment: systemComment,
    now: () => new Date().toISOString(),
  });
  const intentJobs = createIntentJobPort({ db, store, queueLaunch: async (job, requestId) => queueJobForLaunch(job, requestId) });
  const dispatcher = createDispatcherRpc({ db, launch: intentJobs });
  const executingActivity = createExecutingActivityRpc({
    db,
    threads: officialThreads,
  });
  const webhookSecretsFile = join(bb.server.experimental_dataDir, WEBHOOK_SECRETS_FILENAME);
  const webhookUrl = () => `${(bb.server.experimental_appUrl ?? bb.server.loopbackBaseUrl).replace(/\/$/, "")}/api/v1/plugins/agency/http/notify`;
  const webhookView = (sourceId: string) => ({
    sourceId,
    url: webhookUrl(),
    issuedAt: webhookSecretIssuedAt(webhookSecretsFile, sourceId),
    topics: sourceTopics(db, sourceId),
  });
  const webhookSourceRow = (sourceId: string) =>
    db.prepare(`SELECT id, kind FROM agency_event_source WHERE id = ?`).get(sourceId) as { id: string; kind: string } | undefined;
  const ownerOnly = () => {
    const access = resolveRpcAccess(db);
    if (!access.ok) return access;
    if (access.value.ctx.caller) return { ok: false as const, error: { code: "forbidden", message: "Это действие доступно только владельцу." } };
    return access;
  };
  const readOnly = () => resolveRpcAccess(db);
  /** Stores a message to the owner and hands it to Telegram when the owner turned it on. */
  const sendOwnerMessage = async (input: { text: string; level?: "info" | "warning"; jobId?: string; dedupeKey?: string }, source: string) => {
    const job = input.jobId ? store.getJob(input.jobId) ?? store.getJobByKey(input.jobId) : undefined;
    if (input.jobId && !job) return { ok: false as const, error: { code: "not_found", message: `job ${input.jobId} not found` } };
    const recorded = recordOwnerMessage(db, { ...input, jobId: job?.id ?? null }, source, new Date().toISOString());
    if (!recorded.ok || recorded.value.duplicate) return recorded;
    const id = recorded.value.message.id;
    try {
      const pref = await telegram.preferences();
      if (pref.enabled && pref.notifications && pref.projectId) {
        await telegram.enqueue({ deliveryId: `owner:${id}`, projectId: pref.projectId, jobId: job?.key ?? "owner", title: input.text.trim().slice(0, 500), kind: "notification" });
        setTelegramState(db, id, "queued");
      }
    } catch (error) {
      setTelegramState(db, id, `failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    onChanged();
    return { ok: true as const, value: { message: readOwnerMessage(db, id)!, duplicate: false } };
  };
  /** Starter departments act as the owner: the same store commands as the forms. */
  const starterKitPorts = (ctx: ServiceContext): StarterKitPorts => ({
    db,
    now: () => new Date().toISOString(),
    newRequestId: () => randomUUID(),
    setDepartmentParent: (input) => setDepartmentParent(db, input, new Date().toISOString()),
    policyVersionId: () => {
      // The profile names the CLI; the standard policy allows any, so the owner may switch it later.
      const standard = listStoredPolicies(db).find(
        (policy) =>
          policy.cliHostConstraints.providerIds.length === 0 &&
          policy.cliHostConstraints.hostIds.length === 0 &&
          policy.secretRefs.length === 0 &&
          [...policy.allowedCapabilities].sort().join(",") === "read.files,write.files",
      );
      if (standard) return { ok: true, value: standard.id };
      const created = store.createPolicyVersion(ctx, {
        requestId: randomUUID(),
        allowedCapabilities: ["read.files", "write.files"],
        cliHostConstraints: { providerIds: [], hostIds: [] },
        secretRefs: [],
      });
      return created.ok ? { ok: true, value: created.value.id } : created;
    },
    defaults: (roleType) => {
      const rules = workRulesView(db, "agency").effective;
      return roleType === "lead"
        ? { providerId: rules.defaultProviderLead, model: rules.defaultModelLead, reasoningEffort: rules.defaultReasoningLead, serviceTier: rules.defaultServiceTierLead }
        : roleType === "reviewer"
          ? { providerId: rules.defaultProviderReviewer, model: rules.defaultModelReviewer, reasoningEffort: rules.defaultReasoningReviewer, serviceTier: rules.defaultServiceTierReviewer }
          : { providerId: rules.defaultProviderExecutor, model: rules.defaultModelExecutor, reasoningEffort: rules.defaultReasoningExecutor, serviceTier: rules.defaultServiceTierExecutor };
    },
    provisionAgent: (input) => store.provisionAgent(ctx, input as Parameters<typeof store.provisionAgent>[1]),
    provisionDepartment: (input) => store.provisionDepartment(ctx, input),
    addMembership: (input) => store.addMembership(ctx, input),
    saveAgentProfile: (input) => store.saveAgentProfile(ctx, input as Parameters<typeof store.saveAgentProfile>[1]),
    saveDepartmentProfile: (input) => store.saveDepartmentProfile(ctx, input),
  });
  const kitLanguage = (language?: "ru" | "en") => language ?? agencyLanguage();
  /** CLIs BB knows on the machine of an active project; null when the catalog is unavailable. */
  const connectedProviders = async (): Promise<Set<string> | null> => {
    const binding = listStoredBindings(db).find((row) => !row.archivedAt);
    try {
      const providers = binding
        ? await bb.sdk.providers.list({ hostId: binding.hostId, signal: AbortSignal.timeout(12_000) })
        : await bb.sdk.providers.list({ signal: AbortSignal.timeout(12_000) });
      const available = providers.filter((provider) => provider.available).map((provider) => provider.id);
      return available.length ? new Set(available) : null;
    } catch {
      return null;
    }
  };
  /**
   * Every employee against the models this BB can run. `apply` rewrites the profiles that can be
   * fixed: a new version with the closest connected model, so the card never shows a model the
   * machine does not have.
   */
  const agentModelsView = async (apply: boolean, only?: string[]) => {
    const access = apply ? ownerOnly() : readOnly();
    if (!access.ok) return access;
    const binding = listStoredBindings(db).find((row) => !row.archivedAt);
    const catalog = await modelCatalog(binding?.hostId);
    const en = agencyLanguage() === "en";
    const ids = (db.prepare(`SELECT id FROM agency_agent WHERE state <> 'archived' ORDER BY name`).all() as { id: string }[])
      .map((row) => row.id)
      .filter((id) => !only?.length || only.includes(id));
    const rows: AgentModelsView["rows"] = [];
    for (const id of ids) {
      const agent = store.getAgent(id);
      const version = agent ? store.getAgentVersion(agent.currentVersionId) : null;
      if (!agent || !version) continue;
      const base = { agentId: agent.id, name: agent.name, providerId: version.providerId, model: version.model };
      if (!catalog.length) {
        rows.push({ ...base, status: "exact" as const, suggestedProviderId: null, suggestedModel: null, note: null });
        continue;
      }
      const choice = resolveModelChoice({ providerId: version.providerId, model: version.model }, catalog);
      if (choice.status === "exact") {
        rows.push({ ...base, status: "exact" as const, suggestedProviderId: null, suggestedModel: null, note: null });
        continue;
      }
      if (choice.status === "missing") {
        rows.push({ ...base, status: "missing" as const, suggestedProviderId: null, suggestedModel: null, note: modelChoiceNote(choice, en) });
        continue;
      }
      if (!apply) {
        rows.push({
          ...base,
          status: "substituted" as const,
          suggestedProviderId: choice.providerId,
          suggestedModel: choice.model,
          note: modelChoiceNote(choice, en),
        });
        continue;
      }
      const saved = store.saveAgentProfile(access.value.ctx, {
        requestId: crypto.randomUUID(),
        expectedRevision: agent.revision,
        agentId: agent.id,
        name: agent.name,
        state: agent.state,
        version: {
          version: version.version + 1,
          role: version.role,
          instructions: version.instructions,
          providerId: choice.providerId,
          model: choice.model,
          ...(version.reasoningEffort ? { reasoningEffort: version.reasoningEffort } : {}),
          // Fast mode belongs to the CLI it was set for; a new CLI may not have it.
          ...(version.serviceTier && choice.providerId === version.providerId ? { serviceTier: version.serviceTier } : {}),
          skillIds: version.skillIds,
          mcpIds: version.mcpIds,
          policyVersionId: version.policyVersionId,
          // A reserve that became the primary leaves the list: the profile never names one pair twice.
          ...optionalFallbackModels(version.fallbackModels?.filter((pick) => fallbackModelKey(pick) !== fallbackModelKey(choice))),
        },
      });
      rows.push({
        ...base,
        status: saved.ok ? ("repaired" as const) : ("blocked" as const),
        suggestedProviderId: choice.providerId,
        suggestedModel: choice.model,
        note: saved.ok ? modelChoiceNote(choice, en) : saved.error.message,
      });
    }
    if (apply && rows.some((row) => row.status === "repaired")) onChanged();
    return { ok: true as const, value: { hostId: binding?.hostId ?? null, catalogUnavailable: !catalog.length, rows } };
  };

  /** Профили работ проекта: голос и стиль живут в проекте, а не в напоминаниях владельца. */
  /**
   * Решение по записи знаний: владелец решает всё, руководитель отдела — только по записям своего
   * отдела и только про работу (урок, процедура, справка). Предпочтения и решения владельца, а
   * также знания проекта и всего Агентства, остаются за ним.
   */
  const mayDecideKnowledge = (callerAgentId: string | null, knowledgeId: string) => {
    const item = getKnowledge(db, knowledgeId) ?? null;
    const lead = item?.scopeId ? store.getDepartment(item.scopeId)?.leadAgentId ?? null : null;
    const refusal = knowledgeDecisionRefusal(callerAgentId, item, lead);
    return refusal ? fail(refusal.code, refusal.message) : { ok: true as const };
  };

  /**
   * Оценщик: настройки, имена ключей из Env Catalog и живая проверка. Секрет сюда не приходит —
   * владелец выбирает имя переменной, а сам ключ остаётся в каталоге или в окружении машины.
   */
  const decisionHandlers = {
    getDecisionSettings: async () => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const settings = getDecisionSettings(db);
      const key = await resolveDecisionKey({ source: settings.keySource, name: settings.keyName });
      const catalog = await listEnvKeyOptions();
      return {
        ok: true as const,
        value: {
          settings,
          points: DECISION_POINTS.map((point) => ({ ...point })),
          keyReady: key.ok,
          keyProblem: key.ok ? null : key.reason,
          catalogAvailable: catalog.available,
          keyOptions: catalog.options,
          log: listDecisionLog(db, 40),
        },
      };
    },
    saveDecisionSettings: async (input: SaveDecisionSettingsInput) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const saved = saveDecisionSettings(db, input, new Date().toISOString());
      if (saved.ok) onChanged();
      return saved;
    },
    saveDecisionKey: async (input: { name: string; value: string }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      // Ключ уходит в Env Catalog и шифруется там; у себя мы запоминаем только имя.
      const stored = await putEnvKey(input.name, input.value, "Ключ оценщика Агентства");
      return stored.ok
        ? { ok: true as const, value: { name: input.name } }
        : fail("invalid_command", stored.reason === "no_catalog" ? "Плагин Env Catalog не отвечает: задайте ключ переменной окружения машины." : "Нужны имя переменной и значение ключа.");
    },
    testDecisionModel: async () => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const settings = getDecisionSettings(db);
      // Проверка идёт по настройкам как есть, но выключенный оценщик проверить всё равно можно.
      const outcome = await askDecisions(
        { ...settings, enabled: true },
        {
          state: "Запись памяти отдела: «Перед сдачей прогнать тесты — дважды возвращали работу именно из-за этого».",
          questions: [
            { id: "keep", kind: "bool", prompt: "Стоит ли хранить эту запись в памяти отдела?" },
            { id: "kind", kind: "choice", prompt: "Какой это вид записи?", choices: KNOWLEDGE_KINDS },
          ],
        },
      );
      const row = appendDecisionLog(
        db,
        outcome.ok
          ? {
              point: "test",
              jobKey: null,
              outcome: "ok",
              detail: "connection",
              answers: formatDecisionAnswers(outcome.answers),
              ms: outcome.ms,
            }
          : {
              point: "test",
              jobKey: null,
              outcome: "failed",
              detail: outcome.reason,
              ms: outcome.ms,
            },
        new Date().toISOString(),
      );
      if (row) bb.log.info(decisionLogLine(row));
      return {
        ok: true as const,
        value: outcome.ok
          ? { ok: true as const, ms: outcome.ms, answers: outcome.answers }
          : { ok: false as const, ms: outcome.ms, reason: outcome.reason, detail: outcome.detail ?? null },
      };
    },
    listDecisionLog: async (input: { limit?: number }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      return { ok: true as const, value: listDecisionLog(db, input.limit ?? 50) };
    },
    probeDecisionPoints: async () => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const settings = getDecisionSettings(db);
      const probed = await probeDecisionPoints(settings);
      const now = new Date().toISOString();
      const rows = [
        {
          point: "intake",
          jobKey: "probe-intake",
          outcome: probed.intake ? "proposal" : "silent",
          detail: probed.intake
            ? `${probed.intake.size}/${probed.intake.risk}/${probed.intake.decision}`
            : probed.intakeTrace.reason,
          answers: probed.intakeTrace.answers,
          ms: probed.intakeTrace.ms,
        },
        {
          point: "hand-in-gate",
          jobKey: "probe-junk",
          outcome: probed.junk?.action ?? "failed",
          detail: probed.junk?.action === "rework" ? "expected_rework" : probed.junk ? "unexpected_proceed" : "no_answer",
          answers: probed.junk?.answers ?? "",
          ms: probed.junk?.ms ?? 0,
        },
        {
          point: "hand-in-gate",
          jobKey: "probe-solid",
          outcome: probed.solid?.action ?? "failed",
          detail: probed.solid?.action === "proceed" ? "expected_proceed" : probed.solid ? "unexpected_rework" : "no_answer",
          answers: probed.solid?.answers ?? "",
          ms: probed.solid?.ms ?? 0,
        },
        {
          point: "launch-briefing",
          jobKey: "probe-briefing",
          outcome: probed.briefing.reason,
          detail: probed.briefing.skills.length || probed.briefing.granted.length
            ? `picked=${probed.briefing.skills.join("|")} granted=${probed.briefing.granted.join("|")}`
            : probed.briefing.reason,
          answers: probed.briefing.answers,
          ms: probed.briefing.ms,
        },
      ];
      for (const entry of rows) {
        const row = appendDecisionLog(db, entry, now);
        if (row) bb.log.info(decisionLogLine(row));
      }
      return { ok: true as const, value: probed };
    },
  };

  /**
   * Библиотека навыков отдела и журнал выдач. Библиотеку правит владелец или руководитель этого
   * отдела: это решение о правах, но принимается оно один раз для отдела, а не на каждую задачу.
   */
  const skillPoolHandlers = {
    getSkillPool: async (input: { departmentId: string }) => {
      const access = readOnly();
      if (!access.ok) return access;
      return {
        ok: true as const,
        value: { departmentId: input.departmentId, skillIds: listSkillPool(db, input.departmentId), grants: listSkillGrants(db, { departmentId: input.departmentId, limit: 50 }) },
      };
    },
    setSkillPool: async (input: { departmentId: string; skillIds: string[] }) => {
      const access = readOnly();
      if (!access.ok) return access;
      const callerAgentId = access.value.ctx.caller?.agentId ?? null;
      if (callerAgentId && store.getDepartment(input.departmentId)?.leadAgentId !== callerAgentId) {
        return fail("forbidden", "Библиотеку навыков отдела правит его руководитель или владелец.");
      }
      const saved = setSkillPool(db, input, { agentId: callerAgentId }, new Date().toISOString());
      if (saved.ok) onChanged();
      return saved;
    },
    listSkillGrants: async (input: { departmentId?: string; agentId?: string }) => {
      const access = readOnly();
      if (!access.ok) return access;
      return { ok: true as const, value: listSkillGrants(db, { ...input, limit: 200 }) };
    },
  };

  /**
   * Паспорт проекта. Собирает его фоновая модель, применяется он сразу — поэтому владельцу здесь
   * нужны три вещи: видеть, что уедет в запуск, вернуть прежнюю редакцию и выключить писаря.
   */
  /**
   * Правила проекта с машины как материал для паспорта: по ним модель понимает, что это за
   * проект. Машина не в сети — сборка идёт без них, а не откладывается.
   */
  /**
   * Проект вызывающего. У владельца треда нет, и он видит всё; сотрудник читает паспорт и профили
   * работ только того проекта, в котором сейчас работает: `allowedBindingIds` для этого не годится,
   * там лежат все привязки Агентства.
   */
  const projectOfJob = (jobId: string): string | null => {
    const job = store.getJob(jobId);
    return (job ? listStoredBindings(db).find((row) => row.id === job.bindingId)?.bbProjectId : null) ?? null;
  };
  const assertProjectAccess = (caller: ProjectCaller, bbProjectId?: string) =>
    projectAccessAllowed(caller, bbProjectId, projectOfJob)
      ? { ok: true as const }
      : fail("forbidden", "Это другой проект: паспорт и профили работ читаются только в своём.");

  /** Смотрит ли привратник новую редакцию: без него паспорт применяется без проверки на секрет. */
  const passportGateEnabled = (): boolean => {
    const decisions = getDecisionSettings(db);
    return decisions.enabled && decisions.points.includes(PASSPORT_GATE_POINT);
  };

  const passportProjectRules = async (bbProjectId: string): Promise<ProjectRulesRead> => {
    const binding = listStoredBindings(db).find((row) => row.bbProjectId === bbProjectId && !row.archivedAt);
    // Папки у проекта нет — читать нечего, и это не то же самое, что молчащая машина.
    if (!binding) return { reachable: true, text: null };
    const rules = await readProjectRulesFile(documents, binding).catch((error) => {
      bb.log.warn(`Passport rules of ${bbProjectId}: ${String(error)}`);
      return null;
    });
    if (!rules) return { reachable: false, text: null };
    if (!rules.ok) {
      bb.log.warn(`Passport rules of ${bbProjectId}: ${rules.error.code} ${rules.error.message}`);
      return { reachable: false, text: null };
    }
    return { reachable: true, text: rules.value.text };
  };

  const passportHandlers = {
    getPassportSettings: async () => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const settings = getPassportSettings(db);
      const key = await resolveDecisionKey({ source: settings.keySource, name: settings.keyName });
      return { ok: true as const, value: { settings, keyReady: key.ok, keyProblem: key.ok ? null : key.reason, gateEnabled: passportGateEnabled() } };
    },
    savePassportSettings: async (input: SavePassportSettingsInput) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const saved = savePassportSettings(db, input, new Date().toISOString());
      if (saved.ok) onChanged();
      return saved;
    },
    getProjectPassport: async (input: { bbProjectId: string }) => {
      const access = readOnly();
      if (!access.ok) return access;
      const allowed = assertProjectAccess(access.value.ctx.caller, input.bbProjectId);
      if (!allowed.ok) return allowed;
      const passport = getPassport(db, input.bbProjectId);
      const settings = getPassportSettings(db);
      const key = settings.enabled ? await resolveDecisionKey({ source: settings.keySource, name: settings.keyName }) : { ok: false as const };
      return {
        ok: true as const,
        value: {
          bbProjectId: input.bbProjectId,
          passport,
          versions: listPassportVersions(db, input.bbProjectId),
          settings,
          previews: passport
            ? PASSPORT_DELIVERIES.map((mode) => ({ mode, text: passportText(passport, mode) ?? "" })).filter((row) => row.text)
            : [],
          acceptedJobs: collectPassportMaterial(db, input.bbProjectId).acceptedJobs,
          keyReady: key.ok,
          gateEnabled: passportGateEnabled(),
        },
      };
    },
    savePassport: async (input: { bbProjectId: string; expectedRevision: number; header: string; sections: { key: string; text: string }[] }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      // Правка владельца берёт отпечаток нынешнего материала: иначе следующая сборка сочла бы
      // материал изменившимся и переписала бы правку в тот же час.
      const material = collectPassportMaterial(db, input.bbProjectId);
      const saved = writePassport(
        db,
        {
          bbProjectId: input.bbProjectId,
          header: input.header,
          sections: input.sections.map((section) => ({ key: section.key as PassportSectionKey, text: section.text })),
          sourceDigest: material.digest,
          acceptedJobs: material.acceptedJobs,
          builtBy: "owner",
          note: "Правка владельца",
          expectedRevision: input.expectedRevision,
        },
        new Date().toISOString(),
      );
      if (saved.ok) onChanged();
      return saved;
    },
    buildProjectPassport: async (input: { bbProjectId: string }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const result = await buildPassport(db, { bbProjectId: input.bbProjectId, trigger: "manual" }, { readRules: passportProjectRules });
      if (result.ok) onChanged();
      return {
        ok: true as const,
        value: result.ok
          ? { ok: true as const, revision: result.revision, ms: result.ms, reason: "built" as const }
          : { ok: false as const, reason: result.reason, detail: result.detail ?? null, ms: result.ms },
      };
    },
    rollbackPassport: async (input: { bbProjectId: string; revision: number }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const rolled = rollbackPassport(db, input.bbProjectId, input.revision, new Date().toISOString());
      if (rolled.ok) onChanged();
      return rolled;
    },
    deleteProjectPassport: async (input: { bbProjectId: string }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const removed = deletePassport(db, input.bbProjectId);
      if (removed.ok && removed.value.removed) onChanged();
      return removed;
    },
  };

  const sessionPolicyHandlers = {
    getSessionPolicy: async (input: { bbProjectId?: string; bindingId?: string; threadId?: string }) => {
      const access = readOnly();
      if (!access.ok) return access;
      let bbProjectId = input.bbProjectId;
      if (!bbProjectId && input.threadId) {
        try {
          const row = await bb.sdk.threads.get({ threadId: input.threadId });
          const view = isolatedViewFromRecord(row);
          const nested = row && typeof row === "object" ? Reflect.get(row, "project") : undefined;
          const nestedId = nested && typeof nested === "object" ? Reflect.get(nested, "id") : undefined;
          if (view.projectId) bbProjectId = view.projectId;
          else if (typeof nestedId === "string" && nestedId.length > 0) bbProjectId = nestedId;
        } catch {
          // Thread-only resolution still returns the Agency fallback.
        }
      }
      return { ok: true as const, value: resolveSessionPolicy(db, { ...input, bbProjectId }, delegationMode) };
    },
    saveSessionPolicy: async (input: { requestId: string; scope: "project" | "binding" | "thread"; scopeId: string; mode: "inherit" | "ordinary" | "suggest" | "pm" }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const saved = saveSessionPolicy(db, input, new Date().toISOString());
      if (saved.ok) onChanged();
      return saved;
    },
  };

  const workProfileHandlers = {
    listWorkProfiles: async (input: { bbProjectId?: string }) => {
      const access = readOnly();
      if (!access.ok) return access;
      const caller = access.value.ctx.caller;
      const allowed = assertProjectAccess(caller, input.bbProjectId);
      if (!allowed.ok) return allowed;
      // Сотрудник без явного проекта получает профили своего, а не всех проектов Агентства.
      if (caller && !input.bbProjectId) {
        const own = projectOfJob(caller.jobId);
        return { ok: true as const, value: own ? listWorkProfiles(db, own) : [] };
      }
      return { ok: true as const, value: listWorkProfiles(db, input.bbProjectId) };
    },
    saveWorkProfile: async (input: {
      bbProjectId: string;
      key: string;
      expectedRevision: number;
      title: string;
      triggers?: string[];
      body: string;
      samples?: { label: string; ref: string; note?: string }[];
      acceptance?: string;
    }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const saved = saveWorkProfile(
        db,
        {
          bbProjectId: input.bbProjectId,
          key: input.key,
          expectedRevision: input.expectedRevision,
          title: input.title,
          triggers: input.triggers ?? [],
          body: input.body,
          samples: input.samples ?? [],
          acceptance: input.acceptance ?? "",
        },
        new Date().toISOString(),
      );
      if (saved.ok) onChanged();
      return saved;
    },
    deleteWorkProfile: async (input: { bbProjectId: string; key: string }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const removed = deleteWorkProfile(db, input.bbProjectId, input.key);
      if (removed.ok && removed.value.removed) onChanged();
      return removed;
    },
  };

  const agentModelHandlers = {
    agentModels: () => agentModelsView(false),
    repairAgentModels: ({ agentIds }: { agentIds?: string[] }) => agentModelsView(true, agentIds),
  };

  const organization = {
    starterKit: async (input: { language?: "ru" | "en" }) => {
      const access = readOnly();
      if (!access.ok) return access;
      return { ok: true as const, value: starterKitView(db, kitLanguage(input.language), new Date().toISOString()) };
    },
    installStarterKit: async (input: { keys: string[]; language?: "ru" | "en" }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      // A starter employee meant for Grok or GPT starts on the closest model this BB has.
      const binding = listStoredBindings(db).find((row) => !row.archivedAt);
      const catalog = await modelCatalog(binding?.hostId);
      const result = installStarterKit(
        {
          ...starterKitPorts(access.value.ctx),
          ...(catalog.length ? { resolveModel: (wish: { providerId: string; model: string }) => resolveModelChoice(wish, catalog) } : {}),
        },
        { keys: input.keys, language: kitLanguage(input.language) },
        agencyLanguage() === "en",
      );
      if (result.ok && result.value.installed.length) onChanged();
      return result;
    },
    translateStarterKit: async (input: { language?: "ru" | "en" }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const result = translateStarterKit(starterKitPorts(access.value.ctx), kitLanguage(input.language));
      if (result.ok && result.value.translated) onChanged();
      return result;
    },
    recordLifecycle: async (input: { kind: "department" | "agent"; id: string }) => {
      const access = readOnly();
      if (!access.ok) return access;
      const en = agencyLanguage() === "en";
      const reason = input.kind === "department" ? departmentDeleteBlocker(db, input.id, en) : agentDeleteBlocker(db, input.id, en);
      return { ok: true as const, value: { deletable: reason === null, reason, archivedAt: input.kind === "department" ? departmentArchivedAt(db, input.id) : null } };
    },
    archiveDepartment: async (input: { departmentId: string }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const result = archiveDepartment(db, input.departmentId, new Date().toISOString(), agencyLanguage() === "en");
      if (result.ok) onChanged();
      return result;
    },
    restoreDepartment: async (input: { departmentId: string }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const result = restoreDepartment(db, input.departmentId);
      if (!result.ok) return result;
      onChanged();
      return { ok: true as const, value: { restored: true as const } };
    },
    deleteDepartment: async (input: { departmentId: string }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const result = deleteDepartment(db, input.departmentId, agencyLanguage() === "en");
      if (!result.ok) return result;
      onChanged();
      return { ok: true as const, value: { deleted: true as const } };
    },
    deleteAgent: async (input: { agentId: string }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const result = deleteAgent(db, input.agentId, agencyLanguage() === "en");
      if (!result.ok) return result;
      onChanged();
      return { ok: true as const, value: { deleted: true as const } };
    },
    notifyOwner: async (input: { text: string; level?: "info" | "warning"; jobId?: string; dedupeKey?: string }) => {
      const access = readOnly();
      if (!access.ok) return access;
      const caller = access.value.ctx.caller;
      return sendOwnerMessage(input, caller ? `employee:${caller.agentId ?? caller.threadId}` : "owner");
    },
    listOwnerMessages: async (input: { limit?: number }) => {
      const access = readOnly();
      if (!access.ok) return access;
      return { ok: true as const, value: listOwnerMessages(db, input.limit ?? 100) };
    },
    markOwnerMessagesRead: async (input: { ids?: string[] }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const marked = markOwnerMessagesRead(db, input.ids, new Date().toISOString());
      if (marked) onChanged();
      return { ok: true as const, value: { marked } };
    },
    ownerDigest: async (input: { kind: "summary" | "watchdog"; sinceHours?: number; stuckHours?: number; notify?: boolean; dedupeKey?: string }) => {
      const access = readOnly();
      if (!access.ok) return access;
      const now = new Date();
      const sinceHours = input.sinceHours ?? 24;
      const stuckHours = input.stuckHours ?? 24;
      const digest = buildDigest(db, { kind: input.kind, sinceHours, stuckHours }, now, agencyLanguage() === "en");
      const send = input.notify && (input.kind === "summary" || digest.items.length > 0);
      if (!send) return { ok: true as const, value: { ...digest, message: null, duplicate: false } };
      // A watchdog repeats only when what waits changes; a summary goes once per day and window.
      const dedupeKey =
        input.dedupeKey ??
        (input.kind === "watchdog"
          ? `watchdog:${createHash("sha256").update(digest.items.map((item) => `${item.key}:${item.state}:${item.since}`).join("|")).digest("hex").slice(0, 32)}`
          : `summary:${serverDay(now)}:${sinceHours}`);
      const sent = await sendOwnerMessage({ text: digest.text, level: digest.level, dedupeKey }, access.value.ctx.caller ? "employee-digest" : `digest:${input.kind}`);
      if (!sent.ok) return sent;
      return { ok: true as const, value: { ...digest, message: sent.value.message, duplicate: sent.value.duplicate } };
    },
    listScriptTemplates: async () => {
      const access = readOnly();
      if (!access.ok) return access;
      return { ok: true as const, value: scriptTemplates(agencyLanguage() === "en") };
    },
    listBackups: async () => {
      const access = ownerOnly();
      if (!access.ok) return access;
      return { ok: true as const, value: listBackups(backupsDirFor(db)) };
    },
    createBackup: async () => {
      const access = ownerOnly();
      if (!access.ok) return access;
      return { ok: true as const, value: await createBackup(db, backupsDirFor(db), "manual", new Date()) };
    },
    restoreBackup: async (input: { name: string }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const restored = await restoreBackup(db, backupsDirFor(db), input.name, new Date());
      if (restored.ok) onChanged();
      return restored;
    },
    listKnowledge: async (input: { scopeKind?: "agency" | "department" | "project" | "section"; scopeId?: string; parentBindingId?: string | null; status?: "proposal" | "accepted" | "archived" } | null) => {
      const access = readOnly();
      if (!access.ok) return access;
      return { ok: true as const, value: listKnowledge(db, input ?? {}) };
    },
    getKnowledge: async (input: { id: string }) => {
      const access = readOnly();
      if (!access.ok) return access;
      const item = getKnowledge(db, input.id);
      if (!item) return fail("not_found", `knowledge ${input.id} not found`);
      // Считаем только чтение из треда сотрудника: владелец листает записи в интерфейсе, это не работа.
      if (access.value.ctx.caller?.agentId) markKnowledgeRead(db, item.id, new Date().toISOString());
      return { ok: true as const, value: item };
    },
    saveKnowledge: async (input: SaveKnowledgeInput) => {
      const access = readOnly();
      if (!access.ok) return access;
      if (input.scopeKind === "section" && input.parentBindingId && !store.getBinding(input.parentBindingId)) {
        return fail("not_found", `Привязка проекта-родителя ${input.parentBindingId} не найдена.`);
      }
      // An employee's material is a proposal until the owner accepts it.
      const saved = saveKnowledge(db, input, { proposedBy: access.value.ctx.caller?.agentId ?? null }, new Date().toISOString());
      if (saved.ok) onChanged();
      return saved;
    },
    setKnowledgeStatus: async (input: { id: string; expectedRevision: number; status: "proposal" | "accepted" | "archived" }) => {
      const access = readOnly();
      if (!access.ok) return access;
      const allowed = mayDecideKnowledge(access.value.ctx.caller?.agentId ?? null, input.id);
      if (!allowed.ok) return allowed;
      const saved = setKnowledgeStatus(db, input, new Date().toISOString());
      if (saved.ok) onChanged();
      return saved;
    },
    listIdeas: async (input: ListIdeasInput) => {
      const access = readOnly();
      if (!access.ok) return access;
      const filter = input ?? {};
      const projectBindingIds = filter.bbProjectId
        ? listStoredBindings(db)
            .filter((binding) => binding.bbProjectId === filter.bbProjectId)
            .map((binding) => binding.id)
        : null;
      if (projectBindingIds && projectBindingIds.length === 0) return { ok: true as const, value: [] };
      const items = listIdeas(db, {
        bindingId: filter.bindingId,
        sectionId: filter.sectionId,
        kind: filter.kind,
        status: filter.status,
      }).filter((item) => !projectBindingIds || projectBindingIds.includes(item.bindingId));
      return {
        ok: true as const,
        value: items.map((item) => presentIdea(item, store.getBinding(item.bindingId), Boolean(item.fileHash))),
      };
    },
    getIdea: async (input: { id: string }) => {
      const access = readOnly();
      if (!access.ok) return access;
      const item = getIdea(db, input.id);
      if (!item) return fail("not_found", `idea ${input.id} not found`);
      return { ok: true as const, value: presentIdea(item, store.getBinding(item.bindingId), Boolean(item.fileHash)) };
    },
    saveIdea: async (input: SaveIdeaInput) => {
      const access = readOnly();
      if (!access.ok) return access;
      const binding = store.getBinding(input.bindingId);
      if (!binding) return fail("not_found", `Привязка проекта ${input.bindingId} не найдена.`);
      const saved = saveIdea(db, input, new Date().toISOString());
      if (!saved.ok) return saved;
      const written = await writeIdeaFile(documents, binding, saved.value);
      if (written.ok) {
        setIdeaFileHash(db, saved.value.id, written.value.hash);
        onChanged();
        return { ok: true as const, value: presentIdea({ ...saved.value, fileHash: written.value.hash }, binding, true) };
      }
      onChanged();
      return {
        ok: true as const,
        value: presentIdea(saved.value, binding, false),
      };
    },
    setIdeaStatus: async (input: { id: string; expectedRevision: number; status: "open" | "parked" | "done" | "archived" }) => {
      const access = readOnly();
      if (!access.ok) return access;
      const saved = setIdeaStatus(db, input, new Date().toISOString());
      if (!saved.ok) return saved;
      const binding = store.getBinding(saved.value.bindingId);
      if (binding) {
        const written = await writeIdeaFile(documents, binding, saved.value);
        if (written.ok) setIdeaFileHash(db, saved.value.id, written.value.hash);
        onChanged();
        return { ok: true as const, value: presentIdea({ ...saved.value, fileHash: written.ok ? written.value.hash : saved.value.fileHash }, binding, written.ok || Boolean(saved.value.fileHash)) };
      }
      onChanged();
      return { ok: true as const, value: presentIdea(saved.value, binding, Boolean(saved.value.fileHash)) };
    },
    spawnIdeaThread: async (input: SpawnIdeaThreadInput) => {
      const access = readOnly();
      if (!access.ok) return access;
      const item = getIdea(db, input.id);
      if (!item) return fail("not_found", `idea ${input.id} not found`);
      const packed = buildIdeaThreadSpawn(item, input.request);
      if (!packed.ok) return packed;
      const spawned = await bb.sdk.threads.spawn(packed.value as Parameters<typeof bb.sdk.threads.spawn>[0]);
      const threadId = spawned && typeof spawned === "object" && "id" in spawned && typeof spawned.id === "string" ? spawned.id : "";
      if (!threadId) return fail("host_error", "threads.spawn returned no thread id");
      return { ok: true as const, value: { threadId } };
    },
    listGoals: async () => {
      const access = readOnly();
      if (!access.ok) return access;
      return { ok: true as const, value: listGoals(db) };
    },
    saveGoal: async (input: { id?: string; expectedRevision: number; title: string; description: string; status: "active" | "done" | "dropped"; dueAt: string | null }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const saved = saveGoal(db, input, new Date().toISOString());
      if (saved.ok) onChanged();
      return saved;
    },
    setJobGoal: async (input: { jobId: string; goalId: string | null }) => {
      const access = readOnly();
      if (!access.ok) return access;
      const saved = setJobGoal(db, input, new Date().toISOString());
      if (saved.ok) onChanged();
      return saved;
    },
    setDepartmentParent: async (input: { departmentId: string; parentDepartmentId: string | null }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const saved = setDepartmentParent(db, input, new Date().toISOString());
      if (saved.ok) onChanged();
      return saved;
    },
    agentMetrics: async (input: { agentId: string }) => {
      const access = readOnly();
      if (!access.ok) return access;
      const now = new Date();
      const spend = await limitDeps.spend({ agentId: input.agentId, attemptsFrom: new Date(now.getTime() - 30 * 86_400_000).toISOString() });
      return { ok: true as const, value: { ...agentMetrics(db, input.agentId, now), spendUsdCents30d: spend } };
    },
    searchJobs: async (input: { query: string; limit?: number }) => {
      const access = readOnly();
      if (!access.ok) return access;
      return { ok: true as const, value: searchJobs(db, { query: input.query, limit: input.limit, archivedIds: archivedJobIds(db, archiveAfterDays, new Date()), bindingIds: access.value.ctx.allowedBindingIds }) };
    },
    listArchivedJobs: async (input: { limit?: number; offset?: number }) => {
      const access = readOnly();
      if (!access.ok) return access;
      const archived = archivedJobIds(db, archiveAfterDays, new Date());
      const jobs = listJobsForBindings(db, access.value.ctx.allowedBindingIds)
        .filter((job) => archived.has(job.id))
        .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
      const offset = input.offset ?? 0;
      return { ok: true as const, value: { total: jobs.length, jobs: jobs.slice(offset, offset + (input.limit ?? 100)) } };
    },
    listPlugins: async () => {
      const access = readOnly();
      if (!access.ok) return access;
      try {
        const installed = await plugins.list();
        const running = (id: string) => installed.some((plugin) => plugin.id === id && plugin.running);
        return {
          ok: true as const,
          value: {
            plugins: installed,
            features: { projectFolders: running(PROJECT_FOLDERS_PLUGIN_ID), fileGateway: running(FILE_GATEWAY_PLUGIN_ID) },
          },
        };
      } catch (error) {
        return { ok: false as const, error: { code: "plugins_unavailable", message: `Не удалось прочитать список плагинов BB: ${error instanceof Error ? error.message : String(error)}` } };
      }
    },
    listSavedViews: async () => {
      const access = readOnly();
      if (!access.ok) return access;
      return { ok: true as const, value: listSavedViews(db) };
    },
    saveSavedView: async (input: { id?: string; name: string; filters: Record<string, string> }) => {
      const access = readOnly();
      if (!access.ok) return access;
      return saveSavedView(db, input, new Date().toISOString());
    },
    deleteSavedView: async (input: { id: string }) => {
      const access = readOnly();
      if (!access.ok) return access;
      return { ok: true as const, value: { removed: deleteSavedView(db, input.id) } };
    },
  };
  const budgets = {
    ...organization,
    saveRuleSchedule: async (input: { ruleId: string; expression: string; timezone: string; misfire: "skip" | "last" | "catch_up" }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const saved = saveRuleSchedule(db, input, new Date().toISOString());
      if (saved.ok) onChanged();
      return saved;
    },
    listRuleSchedules: async () => {
      const access = resolveRpcAccess(db);
      if (!access.ok) return access;
      return { ok: true as const, value: listRuleSchedules(db) };
    },
    previewSchedule: async (input: { expression: string; timezone: string }) => previewSchedule(input, new Date().toISOString()),
    getWebhookSource: async (input: { sourceId: string }) => {
      const access = resolveRpcAccess(db);
      if (!access.ok) return access;
      if (webhookSourceRow(input.sourceId)?.kind !== "webhook") return { ok: false as const, error: { code: "not_found", message: "Источник с внешним адресом не найден." } };
      return { ok: true as const, value: webhookView(input.sourceId) };
    },
    rotateWebhookSecret: async (input: { sourceId: string }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      if (webhookSourceRow(input.sourceId)?.kind !== "webhook") return { ok: false as const, error: { code: "not_found", message: "Источник с внешним адресом не найден." } };
      const issued = rotateWebhookSecret(webhookSecretsFile, input.sourceId, new Date().toISOString());
      onChanged();
      return { ok: true as const, value: { ...webhookView(input.sourceId), secret: issued.secret } };
    },
    saveSourceTopics: async (input: { sourceId: string; topics: string[] }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      if (webhookSourceRow(input.sourceId)?.kind !== "webhook") return { ok: false as const, error: { code: "not_found", message: "Источник с внешним адресом не найден." } };
      const saved = saveSourceTopics(db, input.sourceId, input.topics, new Date().toISOString());
      if (!saved.ok) return saved;
      onChanged();
      return { ok: true as const, value: webhookView(input.sourceId) };
    },
    listBudgets: async () => {
      const access = resolveRpcAccess(db);
      if (!access.ok) return access;
      return { ok: true as const, value: await listBudgets(limitDeps) };
    },
    /** Subscription spending as BB sees it: the only number a CLI without token events reports. */
    providerUsage: async () => {
      const access = resolveRpcAccess(db);
      if (!access.ok) return access;
      const [limits, providers] = await Promise.all([
        bb.sdk.system.usageLimits().catch(() => ({}) as Record<string, unknown>),
        bb.sdk.providers.list().catch(() => [] as { id: string; displayName?: string }[]),
      ]);
      const names = new Map(providers.map((provider) => [provider.id, provider.displayName ?? provider.id]));
      const rows: ProviderUsageView[] = Object.entries(limits as Record<string, Record<string, unknown>>).map(([providerId, raw]) => {
        const status = typeof raw?.status === "string" ? raw.status : "error";
        const windows = Array.isArray(raw?.windows) ? (raw.windows as Record<string, unknown>[]) : [];
        return {
          providerId,
          name: names.get(providerId) ?? providerId,
          status: (["ok", "not_installed", "unauthenticated", "expired", "error"].includes(status) ? status : "error") as ProviderUsageView["status"],
          planLabel: typeof raw?.planLabel === "string" ? raw.planLabel : null,
          ...(typeof raw?.message === "string" ? { message: raw.message } : {}),
          countsTokens: (PROVEN_USAGE_PROVIDER_IDS as readonly string[]).includes(providerId),
          windows: windows.map((window) => {
            const cost = window.cost && typeof window.cost === "object" ? (window.cost as Record<string, unknown>) : null;
            return {
              label: typeof window.label === "string" ? window.label : "",
              usedPercent: typeof window.usedPercent === "number" ? window.usedPercent : 0,
              resetsAt: typeof window.resetsAt === "string" ? window.resetsAt : null,
              ...(typeof cost?.usedUsdCents === "number" ? { usedUsdCents: cost.usedUsdCents } : {}),
              ...(typeof cost?.limitUsdCents === "number" ? { limitUsdCents: cost.limitUsdCents } : {}),
            };
          }),
        };
      });
      return { ok: true as const, value: rows.sort((left, right) => left.name.localeCompare(right.name)) };
    },
    getSkillPins: async () => {
      const access = resolveRpcAccess(db);
      if (!access.ok) return access;
      return readSkillPinStatus(skillPinDeps);
    },
    enqueueLaunch: async (input: { requestId: string; jobId: string; expectedRevision: number }) => {
      const access = resolveRpcAccess(db);
      if (!access.ok) return access;
      const job = store.getJob(input.jobId);
      if (!job) return { ok: false as const, error: { code: "not_found", message: `job ${input.jobId} not found` } };
      if (job.state !== "backlog" && job.state !== "queued") {
        return { ok: false as const, error: { code: "illegal_job_state", message: "В очередь запуска ставится задача в бэклоге или в очереди." } };
      }
      if (job.revision !== input.expectedRevision) {
        return { ok: false as const, error: { code: "revision_conflict", message: "expectedRevision does not match the live job revision" } };
      }
      const queued = queueJobForLaunch(job, input.requestId);
      if (!queued.ok) return queued;
      const entry = listLaunchQueue(db).find((row) => row.jobId === job.id);
      return entry ? { ok: true as const, value: entry } : { ok: false as const, error: { code: "not_found", message: "queue entry not found" } };
    },
    dequeueLaunch: async (input: { jobId: string }) => {
      const access = resolveRpcAccess(db);
      if (!access.ok) return access;
      const removed = dequeueLaunch(db, input.jobId);
      if (removed) onChanged();
      return { ok: true as const, value: { removed } };
    },
    pinSkills: async () => {
      const access = resolveRpcAccess(db);
      if (!access.ok) return access;
      // Re-pinning changes what every launch checks: only the owner does it, never an employee thread.
      if (access.value.ctx.caller) return { ok: false as const, error: { code: "forbidden", message: "Закреплять версии навыков может только владелец." } };
      return pinCurrentSkills(skillPinDeps);
    },
  };
  const handlers = {
    ...domain,
    ...launch,
    createJob: async (input: Parameters<typeof domain.createJob>[0]) => {
      const created = await domain.createJob(input);
      if (!created.ok || !created.value.assignedAgentId) return created;
      const live = store.getJob(created.value.id);
      if (!live) return created;
      const queued = queueJobForLaunch(live, uuidV5(LAUNCH_QUEUE_NAMESPACE, `create-queue:${live.id}`));
      if (!queued.ok) return created;
      return { ok: true as const, value: store.getJob(live.id) ?? live };
    },
    updateJob: async (input: Parameters<typeof domain.updateJob>[0]) => {
      const updated = await domain.updateJob(input);
      if (updated.ok) {
        void flushClientBounces({ db, send, now: new Date().toISOString() }).catch(() => undefined);
      }
      if (!updated.ok) return updated;
      const live = store.getJob(updated.value.id);
      if (!live?.assignedAgentId || (live.state !== "backlog" && live.state !== "queued")) return updated;
      const queued = queueJobForLaunch(live, uuidV5(LAUNCH_QUEUE_NAMESPACE, `assign-queue:${live.id}`));
      if (!queued.ok) return updated;
      return { ok: true as const, value: store.getJob(live.id) ?? live };
    },
    ...dispatcher,
    ...dashboardUsage.handlers,
    ...budgets,
    ...agentModelHandlers,
    ...workProfileHandlers,
    ...sessionPolicyHandlers,
    ...passportHandlers,
    ...decisionHandlers,
    ...skillPoolHandlers,
  } satisfies Pick<
    PluginRpcHandlers<typeof rpcContract>,
    | "getSkillPool"
    | "setSkillPool"
    | "listSkillGrants"
    | "getDecisionSettings"
    | "saveDecisionSettings"
    | "testDecisionModel"
    | "listDecisionLog"
    | "probeDecisionPoints"
    | "listBudgets"
    | "providerUsage"
    | "getSkillPins"
    | "listBackups"
    | "createBackup"
    | "restoreBackup"
    | "listKnowledge"
    | "saveKnowledge"
    | "setKnowledgeStatus"
    | "listIdeas"
    | "getIdea"
    | "saveIdea"
    | "setIdeaStatus"
    | "listGoals"
    | "saveGoal"
    | "setJobGoal"
    | "setDepartmentParent"
    | "agentMetrics"
    | "searchJobs"
    | "listArchivedJobs"
    | "listSavedViews"
    | "listPlugins"
    | "notifyOwner"
    | "starterKit"
    | "installStarterKit"
    | "translateStarterKit"
    | "recordLifecycle"
    | "archiveDepartment"
    | "restoreDepartment"
    | "deleteDepartment"
    | "deleteAgent"
    | "listOwnerMessages"
    | "markOwnerMessagesRead"
    | "ownerDigest"
    | "listScriptTemplates"
    | "saveSavedView"
    | "deleteSavedView"
    | "saveRuleSchedule"
    | "listRuleSchedules"
    | "previewSchedule"
    | "getWebhookSource"
    | "rotateWebhookSecret"
    | "saveSourceTopics"
    | "enqueueLaunch"
    | "dequeueLaunch"
    | "pinSkills"
    | "listDashboardUsage"
    | "listWorkspace"
    | "listBbCatalog"
    | "listCapabilityCatalog"
    | "getJob"
    | "getAgent"
    | "getDepartment"
    | "listActivity"
    | "listArtifactVersions"
    | "createPolicyVersion"
    | "createAgentVersion"
    | "createProcessVersion"
    | "saveAgentProfile"
    | "saveDepartmentProfile"
    | "provisionAgent"
    | "updateAgent"
    | "provisionDepartment"
    | "updateDepartment"
    | "addMembership"
    | "removeMembership"
    | "createProjectBinding"
    | "updateProjectBinding"
    | "archiveProjectBinding"
    | "restoreProjectBinding"
    | "deleteProjectBinding"
    | "unlinkDepartment"
    | "setDepartmentAvailability"
    | "getWorkRules"
    | "saveWorkRules"
    | "listTemplates"
    | "saveTemplate"
    | "getAgencyRules"
    | "saveAgencyRules"
    | "readProjectRules"
    | "saveProjectRules"
    | "linkDepartment"
    | "createJob"
    | "updateJob"
    | "transitionJob"
    | "createActivity"
    | "createArtifact"
    | "publishArtifactVersion"
    | "attachJobInput"
    | "reportNeedsInput"
    | "answerNeedsInput"
    | "acceptArtifactVersion"
    | "openArtifact"
    | "resolveArtifactPreview"
    | "prepareLaunch"
    | "getLaunch"
    | "reconcileLaunch"
    | "interpretWorkerCompletion"
    | "listJobAttempts"
    | "getIsolationReadiness"
    | "cancelLaunch"
    | "returnJobForRework"
    | "saveEventDefinition"
    | "saveEventSource"
    | "saveRuleVersion"
    | "listEventDefinitions"
    | "listEventSources"
    | "listRuleVersions"
    | "ingestInboxEvent"
    | "dispatchTick"
    | "listActionIntents"
    | "claimActionIntent"
    | "approveActionIntent"
    | "completeActionIntent"
    | "getSessionPolicy"
    | "saveSessionPolicy"
  >;
  const runs = createRunStore(db);
  const runReads = createInternalRunStoreReads(db);
  const attemptForLaunch = (launchId: string) =>
    db.prepare(`SELECT id, state FROM agency_run_attempt WHERE launch_id = ?`).get(launchId) as
      | { id: string; state: string }
      | undefined;
  const systemComment = (job: Job, comment: string): boolean => {
    const access = resolveRpcAccess(db);
    if (!access.ok) return false;
    return store.createActivity(access.value.ctx, {
      requestId: randomUUID(),
      jobId: job.id,
      actor: { kind: "system" },
      kind: "comment",
      causationId: null,
      references: [],
      comment,
    }).ok;
  };
  const conveyorPorts = (): ConveyorPorts | null => {
    const access = resolveRpcAccess(db);
    if (!access.ok) return null;
    return {
      db,
      store: {
        getJob: (jobId) => store.getJob(jobId),
        acceptArtifactVersion: (ctx, input) => store.acceptArtifactVersion(ctx, input),
        transitionJob: (ctx, input) => store.transitionJob(ctx, input),
      },
      ctx: access.value.ctx,
      requestId: (seed) => uuidV5(LAUNCH_QUEUE_NAMESPACE, seed),
      comment: systemComment,
      productReady: (job, result) => {
        void sendOwnerMessage(productReadyMessage(db, job, result), "conveyor");
        enqueueProductReady(db, job, new Date().toISOString());
        void flushClientBounces({ db, send, now: new Date().toISOString() }).catch(() => undefined);
      },
      autoReview: autoReviewPorts(),
      handInGate: async (job) => {
        if (store.memberRole(job.departmentId, job.assignedAgentId) !== "executor") {
          const row = appendDecisionLog(
            db,
            { point: "hand-in-gate", jobKey: job.key, outcome: "skipped", detail: "not_executor" },
            new Date().toISOString(),
          );
          if (row) bb.log.info(decisionLogLine(row));
          return null;
        }
        const latest = [...store.listActivity(job.id)].reverse().find((row) => row.kind === "comment" && row.comment);
        const asked = await askHandInGate(getDecisionSettings(db), job, latest?.comment ?? "");
        const row = appendDecisionLog(
          db,
          asked
            ? {
                point: "hand-in-gate",
                jobKey: job.key,
                outcome: asked.action,
                detail: asked.action === "rework" ? "junk" : "not_junk",
                answers: asked.answers,
                ms: asked.ms,
              }
            : { point: "hand-in-gate", jobKey: job.key, outcome: "failed", detail: "no_answer" },
          new Date().toISOString(),
        );
        if (row) bb.log.info(decisionLogLine(row));
        if (asked?.action !== "rework") return null;
        return { action: "rework" as const, remark: asked.remark };
      },
      returnForRework: async (job, comment) =>
        returnJobForRework(
          {
            db,
            store,
            runs,
            reads: runReads,
            send,
            reworkLimit: (reworkJob) => store.rulesForDepartment(reworkJob.departmentId).reworkLimit,
            currentPublishedHash: async (jobId) => {
              const published = await readJobPublishedArtifact(
                { ctx: access.value.ctx, store, db, documents },
                jobId,
              );
              return published.ok && published.value.publishedVerified ? published.value.publishedHash : null;
            },
          },
          access.value.ctx,
          {
            requestId: uuidV5(LAUNCH_QUEUE_NAMESPACE, `conveyor-rework:${job.id}:${job.revision}`),
            jobId: job.id,
            expectedRevision: job.revision,
            comment,
          },
        ),
    };
  };
  /** Blocked with a system reason; parent wake tells the lead. */
  const blockWithReason = (job: Job, comment: string): boolean => {
    const access = resolveRpcAccess(db);
    if (!access.ok) return false;
    const moved = store.transitionJob(access.value.ctx, {
      requestId: randomUUID(),
      expectedRevision: job.revision,
      jobId: job.id,
      to: "blocked",
    });
    if (!moved.ok) return false;
    systemComment(job, comment);
    void flushParentWakes({ db, send, now: new Date().toISOString() }).catch(() => undefined);
    return true;
  };
  const reminderPorts = (): ReminderPorts => ({
    db,
    getJob: (jobId) => store.getJob(jobId),
    openChildren: (jobId) =>
      (db
        .prepare(`SELECT COUNT(*) AS n FROM agency_job WHERE parent_job_id = ? AND state NOT IN ('done', 'canceled')`)
        .get(jobId) as { n: number }).n,
    attemptForLaunch,
    send: (threadId, text) => send.send({ threadId, text }),
    block: blockWithReason,
    now: () => new Date().toISOString(),
    limit: (job) => store.rulesForDepartment(job.departmentId).completionReminders,
  });
  /** Why BB put the thread in error, from its own events; null when it did not say. */
  const providerErrorDetail = async (threadId: string): Promise<{ detail: string | null; willRetry: boolean | null }> => {
    try {
      const events = await bb.sdk.threads.events.list({ threadId, order: "desc", limit: "20", types: ["provider/error"] });
      for (const event of events as readonly { data?: unknown }[]) {
        const data = event.data as { detail?: unknown; message?: unknown; willRetry?: unknown } | undefined;
        const text = [data?.detail, data?.message].find((value) => typeof value === "string" && value.trim());
        const willRetry = typeof data?.willRetry === "boolean" ? data.willRetry : null;
        if (typeof text === "string" || willRetry !== null) return { detail: typeof text === "string" ? text : null, willRetry };
      }
    } catch {
      /* the thread could not be read: the watch decides without a reason */
    }
    return { detail: null, willRetry: null };
  };
  const jobHostOnline = async (job: Job): Promise<boolean | null> => {
    const binding = store.getBinding(job.bindingId);
    if (!binding) return null;
    try {
      return (await bb.sdk.hosts.get({ hostId: binding.hostId })).status === "connected";
    } catch {
      return null;
    }
  };
  const usedLaunchModel = (version: { providerId: string; model: string }, launchId: string) => {
    const attempt = db
      .prepare(`SELECT snapshot_id FROM agency_run_attempt WHERE launch_id = ?`)
      .get(launchId) as { snapshot_id: string } | undefined;
    if (!attempt?.snapshot_id) return { providerId: version.providerId, model: version.model };
    const snap = db
      .prepare(`SELECT snapshot_json FROM agency_context_snapshot WHERE id = ?`)
      .get(attempt.snapshot_id) as { snapshot_json: string } | undefined;
    if (!snap) return { providerId: version.providerId, model: version.model };
    try {
      const parsed = JSON.parse(snap.snapshot_json) as { agentVersion?: { providerId?: string; model?: string } };
      if (parsed.agentVersion?.providerId && parsed.agentVersion.model) {
        return { providerId: parsed.agentVersion.providerId, model: parsed.agentVersion.model };
      }
    } catch {
      /* stored profile */
    }
    return { providerId: version.providerId, model: version.model };
  };
  const canUseFallback = (job: Job, row: { launchId: string }) => {
    if (!job.assignedAgentId) return false;
    const agent = store.getAgent(job.assignedAgentId);
    const version = agent ? store.getAgentVersion(agent.currentVersionId) : null;
    if (!agent || !version) return false;
    // The pair that hit the limit counts as exhausted already: is there a fresh one after it?
    return Boolean(nextFreshCandidate(db, agent.id, version, usedLaunchModel(version, row.launchId), new Date().toISOString()));
  };
  const runWatchPorts = (extra?: Partial<RunWatchPorts>): RunWatchPorts => ({
    db,
    getJob: (jobId) => store.getJob(jobId),
    attemptForLaunch,
    lastProgressAt: (threadId, jobId) => lastProgressFromDatabase(db, threadId, jobId),
    comment: systemComment,
    block: blockWithReason,
    canSwitchToFallback: canUseFallback,
    now: () => new Date().toISOString(),
    thresholds: (job) => {
      const rules = store.rulesForDepartment(job.departmentId);
      return {
        quietMs: rules.watchQuietMinutes * 60_000,
        stallMs: rules.watchStallMinutes * 60_000,
        startMs: rules.watchStartMinutes * 60_000,
        errorMs: rules.watchErrorMinutes * 60_000,
        ceilingMs: rules.watchCeilingHours * 3_600_000,
      };
    },
    ...extra,
  });
  // Launch queue: waiting jobs start as soon as their limits allow.
  let queueBusy = false;
  const runLaunchQueue = async () => {
    if (queueBusy) return;
    queueBusy = true;
    try {
      // A launch that vanished from the queue goes back in line before the sweep.
      if (repairQueuedJobs(db, new Date().toISOString()).length) onChanged();
      if (reopenDroppedAssignedJobs(db, new Date().toISOString()).length) onChanged();
      const pins = await readSkillPinStatus(skillPinDeps);
      if (pins.ok && pins.value.editable && !pins.value.inSync && pins.value.rows.every((row) => row.currentHash)) {
        const pinned = await pinCurrentSkills(skillPinDeps);
        if (pinned.ok) bb.log.info("Launch queue: pinned current Agency skill versions");
        else bb.log.warn(`Launch queue: could not pin skill versions: ${pinned.error.message}`);
      }
      for (const jobId of listAssignedBacklogJobIds(db)) {
        const waiting = store.getJob(jobId);
        if (!waiting) continue;
        const queued = queueJobForLaunch(waiting, uuidV5(LAUNCH_QUEUE_NAMESPACE, `backlog-queue:${waiting.id}`));
        if (queued.ok) onChanged();
      }
      const result = await sweepLaunchQueue({
        db,
        getJob: (jobId) => store.getJob(jobId),
        checkLimits: checkLaunchGate,
        launch: async (job, requestedAt) => {
          const prepared = (await launch.prepareLaunch({
            requestId: uuidV5(LAUNCH_QUEUE_NAMESPACE, `${job.id}:${requestedAt}:${job.revision}`),
            jobId: job.id,
            expectedRevision: job.revision,
          })) as { ok: true; value: { launched: unknown; reason: string; reasonCode?: string } } | { ok: false; error: { code: string; message: string } };
          return refusalIfLaunchDidNotStart(prepared);
        },
        comment: systemComment,
        notifyOwner: (input) => {
          void sendOwnerMessage({ text: input.text, level: "warning", jobId: input.jobId, dedupeKey: input.dedupeKey }, "launch-queue");
        },
        now: () => new Date().toISOString(),
      });
      if (result.launched || result.removed) onChanged();
      const conveyor = conveyorPorts();
      if (conveyor) {
        const closed = sweepStaleReviewStations(conveyor);
        if (closed > 0) onChanged();
      }
      await flushClientBounces({ db, send, now: new Date().toISOString() });
    } catch (error) {
      bb.log.warn(`Launch queue: ${String(error)}`);
    } finally {
      queueBusy = false;
    }
  };
  const queueSweep = setInterval(() => void runLaunchQueue(), LAUNCH_QUEUE_SWEEP_MS);
  bb.onDispose(() => clearInterval(queueSweep));
  void runLaunchQueue();
  const switchJobToFallback = (job: Job, row: { launchId: string }): boolean => {
    const access = resolveRpcAccess(db);
    if (!access.ok) return false;
    const live = store.getJob(job.id);
    if (!live || live.state !== "running" || !live.assignedAgentId) return false;
    const agent = store.getAgent(live.assignedAgentId);
    const version = agent ? store.getAgentVersion(agent.currentVersionId) : null;
    if (!agent || !version) return false;
    const attempt = db
      .prepare(`SELECT id, state, revision, snapshot_id, thread_id FROM agency_run_attempt WHERE launch_id = ?`)
      .get(row.launchId) as
      | { id: string; state: string; revision: number; snapshot_id: string; thread_id: string | null }
      | undefined;
    if (!attempt || attempt.state !== "running") return false;
    const used = usedLaunchModel(version, row.launchId);
    const now = new Date().toISOString();
    // The thread of this attempt keeps its model. The attempt ends, and a new one starts on the next fresh pair.
    const fallback = nextFreshCandidate(db, agent.id, version, used, now);
    if (!fallback) return false;
    markModelExhausted(db, { agentId: agent.id, providerId: used.providerId, model: used.model, now });
    const stop = Reflect.get(bb.sdk.threads, "stop");
    if (attempt.thread_id && typeof stop === "function") {
      void Promise.resolve((stop as (args: { threadId: string }) => Promise<unknown>)({ threadId: attempt.thread_id })).catch(
        () => undefined,
      );
    }
    const canceled = runs.transitionAttempt(access.value.ctx, {
      requestId: randomUUID(),
      attemptId: attempt.id,
      expectedRevision: attempt.revision,
      to: "canceled",
    });
    if (!canceled.ok) return false;
    const blocked = store.transitionJob(access.value.ctx, {
      requestId: randomUUID(),
      jobId: live.id,
      expectedRevision: live.revision,
      to: "blocked",
    });
    if (!blocked.ok) return false;
    systemComment(
      blocked.value,
      fallbackSwitchText({
        jobKey: live.key,
        fromProviderId: used.providerId,
        fromModel: used.model,
        toProviderId: fallback.providerId,
        toModel: fallback.model,
      }),
    );
    const queued = store.transitionJob(access.value.ctx, {
      requestId: randomUUID(),
      jobId: blocked.value.id,
      expectedRevision: blocked.value.revision,
      to: "queued",
    });
    if (!queued.ok) return false;
    enqueueLaunch(db, queued.value.id, now);
    onChanged();
    void runLaunchQueue();
    return true;
  };
  // Dispatcher: accepted events → rule matches → intents; queued intents (auto mode or approved) become jobs.
  const dispatcherEngine = { db, launch: intentJobs };
  let dispatcherBusy = false;
  const scanEscapes = async () => {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const attempts = (
      db
        .prepare(
          // Live attempts, recently finished ones, and older ones never read (a one-time backfill).
          `SELECT a.id, a.job_id, a.thread_id FROM agency_run_attempt a
           WHERE a.thread_id IS NOT NULL AND (
             a.state IN ('launching', 'running', 'waiting_input', 'awaiting_review') OR a.updated_at > ?
             OR NOT EXISTS (SELECT 1 FROM agency_sandbox_escape e WHERE e.attempt_id = a.id)
           )
           ORDER BY a.updated_at DESC LIMIT 50`,
        )
        .all(since) as { id: string; job_id: string; thread_id: string }[]
    ).map((row) => ({ attemptId: row.id, jobId: row.job_id, threadId: row.thread_id }));
    const grew = await scanSandboxEscapes(
      {
        db,
        now: () => new Date().toISOString(),
        onReadError: (threadId, error) => bb.log.warn(`Sandbox escape scan of ${threadId}: ${error instanceof Error ? error.message : String(error)}`),
        events: {
          list: ({ threadId, afterSeq, limit }) =>
            bb.sdk.threads.events.list({ threadId, order: "asc", limit: String(limit), types: ["item/started"], ...(afterSeq ? { afterSeq } : {}) }),
        },
      },
      attempts,
    );
    if (grew.length) onChanged();
  };
  const nextStepPorts = (): NextStepPorts => ({
    db,
    getJob: (jobId) => store.getJob(jobId),
    createJob: (source, step) =>
      store.createJob(
        { actor: { kind: "system" }, allowedBindingIds: listStoredBindings(db).map((row) => row.id) },
        {
          requestId: uuidV5(LAUNCH_QUEUE_NAMESPACE, `next-step:${source.id}`),
          bindingId: source.bindingId,
          departmentId: step.departmentId,
          title: step.title,
          brief: step.brief,
          acceptance: step.acceptance,
          parentJobId: source.parentJobId,
          sectionId: source.sectionId ?? null,
          workKind: source.workKind ?? null,
          assignedAgentId: null,
          assignment: step.assignment,
          priority: source.priority,
          dueAt: null,
        },
      ),
    attachAccepted: async (target, source) => {
      let attached = 0;
      for (const version of acceptedVersions(db, source.id)) {
        const live = store.getJob(target.id) ?? target;
        const result = (await domain.attachJobInput({
          requestId: uuidV5(LAUNCH_QUEUE_NAMESPACE, `next-step-input:${target.id}:${version.artifactId}:${version.version}`),
          expectedRevision: live.revision,
          targetJobId: target.id,
          sourceJobId: source.id,
          artifactId: version.artifactId,
          version: version.version,
          hash: version.hash,
        })) as { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
        if (!result.ok) return result;
        attached += 1;
      }
      return { ok: true, value: attached };
    },
    queue: (job) => queueJobForLaunch(job, uuidV5(LAUNCH_QUEUE_NAMESPACE, `next-step-queue:${job.id}`)),
    comment: (job, text) => {
      systemComment(job, text);
    },
    now: () => new Date().toISOString(),
    en: () => agencyLanguage() === "en",
  });
  const nightlyRecheckPorts = (): NightlyRecheckPorts => ({
    db,
    departments: () => listStoredDepartments(db).map((department) => ({ id: department.id, name: department.name })),
    rules: (departmentId) => store.rulesForDepartment(departmentId),
    createReview: ({ departmentId, bindingId, day, versions }) => {
      const text = recheckJobText(day, versions, agencyLanguage() === "en");
      const create = (assignment: "reviewer" | "lead") =>
        store.createJob(
          { actor: { kind: "system" }, allowedBindingIds: [bindingId] },
          {
            requestId: uuidV5(LAUNCH_QUEUE_NAMESPACE, `nightly-recheck:${departmentId}:${bindingId}:${day}:${assignment}`),
            bindingId,
            departmentId,
            title: text.title,
            brief: text.brief,
            acceptance: text.acceptance,
            parentJobId: null,
            assignedAgentId: null,
            assignment,
            priority: "normal",
            dueAt: null,
          },
        );
      // A department without reviewers rechecks through its lead.
      const review = create("reviewer");
      return review.ok ? review : create("lead");
    },
    attach: async (review, version) => {
      const live = store.getJob(review.id) ?? review;
      return (await domain.attachJobInput({
        requestId: uuidV5(LAUNCH_QUEUE_NAMESPACE, `nightly-recheck-input:${review.id}:${version.artifactId}:${version.version}`),
        expectedRevision: live.revision,
        targetJobId: review.id,
        sourceJobId: version.jobId,
        artifactId: version.artifactId,
        version: version.version,
        hash: version.hash,
      })) as { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
    },
    queue: (review) => queueJobForLaunch(store.getJob(review.id) ?? review, uuidV5(LAUNCH_QUEUE_NAMESPACE, `nightly-recheck-queue:${review.id}`)),
    comment: (job, text) => {
      systemComment(job, text);
    },
    now: () => new Date(),
    en: () => agencyLanguage() === "en",
  });
  // Repeated remarks are compared hourly: the texts change slowly and the pass reads a month of comments.
  let remarksCheckedAt = 0;
  const runRemarkPatterns = () => {
    if (Date.now() - remarksCheckedAt < 60 * 60 * 1000) return 0;
    remarksCheckedAt = Date.now();
    try {
      return sweepRemarkPatterns(db, new Date(), agencyLanguage() === "en").length;
    } catch (error) {
      bb.log.warn(`Repeated remarks: ${String(error)}`);
      return 0;
    }
  };
  const runDispatcher = async () => {
    void plugins.list().catch(() => undefined);
    void scanEscapes().catch((error) => bb.log.warn(`Sandbox escape scan: ${String(error)}`));
    if (dispatcherBusy) return;
    dispatcherBusy = true;
    try {
      const access = resolveRpcAccess(db);
      if (!access.ok) return;
      const ctx = access.value.ctx;
      let changed = false;
      const scheduled = tickSchedules(dispatcherEngine, ctx, new Date().toISOString());
      if (scheduled.emitted > 0) changed = true;
      for (const problem of scheduled.errors) bb.log.warn(`Schedule: ${problem}`);
      const tick = dispatchTick(dispatcherEngine, ctx, { requestId: randomUUID(), live: true, limit: 50 });
      if (tick.ok && tick.value.evaluated > 0) changed = true;
      for (const state of ["queued", "claimed"] as const) {
        const intents = listActionIntents(dispatcherEngine, { state });
        if (!intents.ok) continue;
        for (const intent of intents.value) {
          const claimed = await claimActionIntent(dispatcherEngine, ctx, {
            requestId: randomUUID(),
            intentId: intent.id,
            live: true,
            leaseOwner: "agency-dispatcher",
            leaseMs: 120_000,
          });
          if (!claimed.ok) continue;
          changed = true;
          if (claimed.value.state === "claimed" && claimed.value.jobId && claimed.value.fencingToken) {
            completeActionIntent(dispatcherEngine, ctx, {
              requestId: randomUUID(),
              intentId: intent.id,
              fencingToken: claimed.value.fencingToken,
              fencingGeneration: claimed.value.fencingGeneration,
              outcome: "succeeded",
            });
          }
        }
      }
      const escalated = sweepEscalations({
        db,
        escalateAfterHours: (departmentId) => store.rulesForDepartment(departmentId).escalateAfterHours,
        comment: (jobId, text) => {
          const job = store.getJob(jobId);
          if (job) systemComment(job, text);
        },
        now: () => new Date(),
      });
      if (escalated > 0) changed = true;
      const nextJobs = await sweepNextSteps(nextStepPorts()).catch((error) => {
        bb.log.warn(`Next steps: ${String(error)}`);
        return [] as string[];
      });
      if (nextJobs.length > 0) changed = true;
      const rechecks = await sweepNightlyRecheck(nightlyRecheckPorts()).catch((error) => {
        bb.log.warn(`Nightly recheck: ${String(error)}`);
        return [] as string[];
      });
      if (rechecks.length > 0) changed = true;
      // Обходчик памяти: бюджет отдела выравнивается независимо от того, сам он учится или нет.
      const trimmed = trimAllDepartments(db, (departmentId) => rulesForDepartment(db, departmentId).memoryLimit, new Date().toISOString());
      if (trimmed.length > 0) changed = true;
      // Авто-уроки, которые владелец не закрепил, через свой срок уходят в архив.
      const expired = expireLessons(db, rulesForDepartment(db, "").memoryTtlDays, new Date().toISOString());
      if (expired.length > 0) {
        changed = true;
        void sendOwnerMessage(
          {
            text: `Память отделов подчищена: ${expired.length} авто-урок(ов) старше срока ушли в архив. Нужный можно вернуть в «Знаниях» и закрепить.`,
            dedupeKey: `lesson-expiry:${new Date().toISOString().slice(0, 10)}`,
          },
          "lesson",
        );
      }
      if (runRemarkPatterns() > 0) changed = true;
      // Паспорт проекта: пересборка идёт пачками по счёту принятых задач, а не после каждой.
      // За один обход собираем не больше нескольких: модель отвечает секунды, и очередь из
      // десяти проектов задержала бы всё остальное, что делает диспетчер.
      for (const bbProjectId of projectsDueForPassport(db, getPassportSettings(db)).slice(0, PASSPORT_BUILDS_PER_SWEEP)) {
        const built = await buildPassport(db, { bbProjectId, trigger: "auto" }, { readRules: passportProjectRules }).catch((error) => {
          bb.log.warn(`Passport ${bbProjectId}: ${String(error)}`);
          return null;
        });
        if (built?.ok) {
          changed = true;
          continue;
        }
        // Отказ привратника владелец должен увидеть: паспорт читают все сотрудники проекта.
        if (built && built.reason === "refused") {
          void sendOwnerMessage(
            {
              text: `Паспорт проекта ${bbProjectId} не обновлён: ${built.detail ?? "привратник отклонил редакцию"}.`,
              dedupeKey: `passport-refused:${bbProjectId}:${new Date().toISOString().slice(0, 10)}`,
            },
            "passport",
          );
        }
      }
      if (changed) onChanged();
      await sweepTelegramOutbox({
        db,
        preferences: () => telegram.preferences(),
        enqueue: (input) => telegram.enqueue(input),
        now: () => new Date(),
      }).catch((error) => bb.log.warn(`Telegram queue: ${String(error)}`));
    } catch (error) {
      bb.log.warn(`Dispatcher: ${String(error)}`);
    } finally {
      dispatcherBusy = false;
    }
  };
  const dispatcherSweep = setInterval(() => void runDispatcher(), DISPATCHER_SWEEP_MS);
  // Webhook v1: the source authenticates itself (HMAC over timestamp and raw body), so the route needs no BB session.
  const webhookRateLimit = createWebhookRateLimiter({ nowMs: () => Date.now() });
  bb.http.route(
    "POST",
    "/notify",
    async (c) => {
      const access = resolveRpcAccess(db);
      if (!access.ok) return c.json({ code: "webhook_unavailable" }, 503);
      const response = await handleWebhookIngress(
        {
          sources: createCatalogWebhookSourcePort(db, {
            resolveSecret: (sourceId) => webhookSecretBytes(webhookSecretsFile, sourceId),
            resolveAllowedTopics: (sourceId) => sourceTopics(db, sourceId),
          }),
          inbox: createDurableWebhookInbox(dispatcherEngine, access.value.ctx),
          rateLimit: webhookRateLimit,
        },
        { headers: c.req.raw.headers, body: c.req.raw.body ?? new Uint8Array(), nowMs: Date.now() },
      );
      if (response.status === 202) void runDispatcher();
      return c.json(
        { code: response.code, ...(response.receiptId ? { receiptId: response.receiptId } : {}), ...(response.duplicate !== undefined ? { duplicate: response.duplicate } : {}) },
        response.status,
        response.headers,
      );
    },
    { auth: "none" },
  );
  bb.onDispose(() => clearInterval(dispatcherSweep));
  const dueSweep = setInterval(() => {
    void sweepDueReminders({
      db,
      listDueJobs: () =>
        (db.prepare(`SELECT id FROM agency_job WHERE due_at IS NOT NULL AND state NOT IN ('done', 'canceled')`).all() as { id: string }[])
          .map((row) => store.getJob(row.id))
          .filter((job): job is Job => Boolean(job)),
      reminderHours: (job) => store.rulesForDepartment(job.departmentId).dueReminderHours,
      comment: systemComment,
      workingThread: (jobId) =>
        (db
          .prepare(`SELECT thread_id FROM agency_run_attempt WHERE job_id = ? AND state = 'running' AND thread_id IS NOT NULL ORDER BY attempt_no DESC LIMIT 1`)
          .get(jobId) as { thread_id: string } | undefined)?.thread_id ?? null,
      send: (threadId, text) => send.send({ threadId, text }),
      now: () => new Date(),
    }).then(
      (sent) => {
        if (sent > 0) onChanged();
      },
      (error) => bb.log.warn(`Due reminders: ${String(error)}`),
    );
  }, DUE_SWEEP_INTERVAL_MS);
  bb.onDispose(() => clearInterval(dueSweep));
  const readingChanged = createReadingChangeGate();
  const completionWatch = createCompletionWatch({
    threads: officialThreads,
    listBoundLaunches: () => listBoundLaunchWatches(db),
    readPublishedForJob: async (jobId) => {
      const access = resolveRpcAccess(db);
      if (!access.ok) return { publishedVerified: false, acceptedVerified: false, publishedHash: null };
      const published = await readJobPublishedArtifact(
        { ctx: access.value.ctx, store, db, documents },
        jobId,
      );
      return published.ok
        ? published.value
        : { publishedVerified: false, acceptedVerified: false, publishedHash: null };
    },
    applyReading: async (row, reading, publishedHash, thread) => {
      const applied = await (async () => {
        const access = resolveRpcAccess(db);
        if (!access.ok) {
          return {
            ...reading,
            jobState: null,
            reviewApplied: false,
            publishedHash,
            attemptState: null,
            attemptReviewApplied: false,
            attemptAcceptedApplied: false,
          };
        }
        const applied = applyVerifiedCompletionLifecycle({
          store,
          runs,
          reads: runReads,
          ctx: access.value.ctx,
          jobId: row.jobId,
          launchId: row.launchId,
          reading,
          publishedHash,
        });
        if (!applied.ok) {
          const job = store.getJob(row.jobId);
          return {
            ...reading,
            jobState: job?.state ?? null,
            reviewApplied: false,
            publishedHash,
            attemptState: null,
            attemptReviewApplied: false,
            attemptAcceptedApplied: false,
          };
        }
        await flushParentWakes({ db, send, now: new Date().toISOString() });
        return applied.value;
      })();
      if (applied.reviewApplied) {
        const conveyor = conveyorPorts();
        if (conveyor) {
          void advanceAfterHandIn(conveyor, row.jobId).then(
            (outcome) => {
              if (outcome !== "pending" && outcome !== "idle") onChanged();
            },
            (error) => bb.log.warn(`Conveyor after hand-in ${row.jobId}: ${String(error)}`),
          );
        }
      }
      try {
        // A published version without the closing comment still needs a reminder, about the comment.
        const commentMissing = reading.publishedVerified && store.handInCommentMissing(row.jobId);
        const outcome = await remindIncompleteWorker(reminderPorts(), row, {
          ...reading,
          publishedVerified: reading.publishedVerified && !commentMissing,
          missing: commentMissing ? "comment" : "version",
        });
        if (outcome !== "skipped" && outcome !== "waiting") onChanged();
      } catch (error) {
        bb.log.warn(`Completion reminder for ${row.jobId}: ${String(error)}`);
      }
      try {
        // A thread in error may be waiting for BB itself: read the reason and the machine first.
        let errorDetail: string | null = null;
        let bbWillRetry: boolean | null = null;
        let hostOnline: boolean | null = null;
        if (reading.threadStatus === "error") {
          const reported = await providerErrorDetail(row.threadId);
          errorDetail = reported.detail;
          bbWillRetry = reported.willRetry;
          const job = store.getJob(row.jobId);
          hostOnline = job ? await jobHostOnline(job) : null;
        }
        const watched = superviseRun(runWatchPorts({
          providerError: () => errorDetail,
          bbWillRetry: () => bbWillRetry,
          hostOnline: () => hostOnline,
          switchToFallback: switchJobToFallback,
        }), row, {
          threadStatus: reading.threadStatus,
          threadUpdatedAt: thread?.updatedAt ? new Date(thread.updatedAt).toISOString() : null,
          backgroundAgents: thread?.activeBackgroundAgentCount ?? 0,
        });
        if (watched === "warned" || watched === "blocked") onChanged();
        if (watched === "blocked") {
          const conveyor = conveyorPorts();
          if (conveyor) {
            const closed = closeBlockedReviewStation(conveyor, row.jobId);
            if (closed.ok && closed.value) onChanged();
          }
        }
      } catch (error) {
        bb.log.warn(`Run watch for ${row.jobId}: ${String(error)}`);
      }
      return applied;
    },
    onReading: (jobId, reading) => {
      if (readingChanged(jobId, reading)) onChanged();
    },
  });
  attachDisposableThreadHints(
    {
      on(event, handler) {
        bb.events.on(event, (payload) => {
          handler({ thread: isolatedViewFromRecord(payload.thread) });
        });
      },
    },
    completionWatch,
    (hook) => bb.onDispose(hook),
  );
  const status = () => ({
    phase: "runtime" as const,
    execution: "requires_readiness" as const,
    reason: STATUS_REQUIRES_READINESS_REASON,
    inboxCount: inbox.count(),
  });
  const notify = (input: unknown, source: "rpc" | "cli") => {
    const receipt = receiveNotification(inbox, input, source);
    if (!receipt.duplicate) bb.realtime.publish("inbox-changed", null);
    return receipt;
  };
  /** Prices as the settings table reads them: built-in rows, the owner's on top, models in use first. */
  const pricesView = () => {
    const used = (db.prepare(`SELECT DISTINCT model FROM agency_agent_version WHERE model <> ''`).all() as { model: string }[])
      .map((row) => row.model)
      .sort();
    return {
      rows: modelPriceRows(modelPrices),
      usedModels: used,
      checkedAt: MODEL_PRICES_CHECKED_AT,
      source: MODEL_PRICES_SOURCE,
      error: modelPricesError,
    };
  };
  const rpcHandlers: PluginRpcHandlers<typeof rpcContract> = {
    prepareDemoDocument,
    prepareDocument: prepareDemoDocument,
    telegramInfo: telegram.inspect,
    telegramPreferences: telegram.preferences,
    configureTelegram: telegram.configure,
    machines: machines.list,
    machineInventory: ({ hostId }) => machines.inspect(hostId),
    setCliPolicy: machines.setPolicy,
    agencyLanguage: async () => ({ language: agencyLanguage() }),
    modelPrices: async () => pricesView(),
    ...agentModelHandlers,
    ...workProfileHandlers,
    ...sessionPolicyHandlers,
    ...passportHandlers,
    ...decisionHandlers,
    ...skillPoolHandlers,
    setModelPrices: async ({ rows }) => {
      const next = await workSettings.experimental_set({ modelPricesJson: modelPriceOverridesJson(rows) });
      applyWorkSettings(next);
      return pricesView();
    },
    setAgencyLanguage: async ({ language }) => {
      const next = await workSettings.experimental_set({ language });
      applyWorkSettings(next);
      return { language: agencyLanguage() };
    },
    uiContext: async () => {
      const hosts = (await bb.sdk.hosts.list()).map((host) => ({ id: host.id, name: host.name }));
      // The machine BB itself runs on: model pickers read its catalog; no guessing by machine name.
      let primaryHostId: string | null = null;
      try {
        primaryHostId = (await bb.sdk.system.config()).primaryHostId ?? null;
      } catch {
        primaryHostId = null;
      }
      return { hosts, primaryHostId };
    },
    status,
    notify: (input) => notify(input, "rpc"),
    ...executingActivity,
    ...dashboardUsage.handlers,
    ...handlers,
  };
  const recoveredAt = new Date().toISOString();
  recoverParentWakesFromActivities(db, recoveredAt);
  recoverClientBouncesFromOpenWaits(db, recoveredAt);
  void flushParentWakes({ db, send, now: recoveredAt }).catch(() => undefined);
  void flushClientBounces({ db, send, now: recoveredAt }).catch(() => undefined);
  bb.rpc.register(rpcContract, rpcHandlers);
  bb.cli.register({
    name: "agency",
    summary: "Агентство: каталог, сотрудники, отделы, задачи, артефакты, attach и prepare",
    commands: CLI_COMMAND_SPECS,
    run: (argv, ctx) =>
      runAgencyCli(
        {
          status,
          notify,
          cliThreadId: readCliThreadId(ctx),
          cliSignal: ctx && typeof ctx === "object" && "signal" in ctx ? (ctx as { signal?: AbortSignal }).signal : undefined,
          askOwner: (input) => presentOwnerQuestionsForCli(ownerQuestion, input),
          jobComment: bindJobCommentHandler({
            store,
            reads: runReads,
            resolveAccess: () => resolveRpcAccess(db),
          }),
          dispatch: (operation: CliOperation, input: unknown) => {
            const handler = handlers[operation] as (value: unknown) => Promise<unknown> | unknown;
            // The calling thread travels with the call: the server knows which employee acts.
            return withCallerThread(readCliThreadId(ctx), () => Promise.resolve(handler(input)));
          },
        },
        argv,
      ),
  });
}

function clampWip(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(999, Math.max(0, Math.round(value))) : 0;
}

function clampHours(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(8_760, Math.max(0, value)) : fallback;
}
