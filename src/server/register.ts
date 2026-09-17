import { backupsDirFor, createBackup, listBackups, restoreBackup } from "./backup/service";
import { scanSandboxEscapes } from "./runtime/sandbox-escape/service";
import { listKnowledge, saveKnowledge, setKnowledgeStatus, type SaveKnowledgeInput } from "./knowledge/store";
import { listGoals, saveGoal, setJobGoal } from "./organization/goals";
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
import { reviewJobText, startAutoReview, type AutoReviewPorts } from "./runtime/auto-review/service";
import { claimActionIntent, completeActionIntent, dispatchTick, listActionIntents } from "./dispatcher/engine";
import { createIntentJobPort } from "./dispatcher/job-port";
import { dequeueLaunch, enqueueLaunch, LAUNCH_QUEUE_SWEEP_MS, listLaunchQueue, repairQueuedJobs, sweepLaunchQueue } from "./runtime/launch-queue/service";
import { uuidV5 } from "./runtime/launch/operation-ids";

const LAUNCH_QUEUE_NAMESPACE = "3d5f1c2e-7a4b-4c8d-9e6f-0a1b2c3d4e5f";
const DISPATCHER_SWEEP_MS = 30_000;
import { pinCurrentSkills, readSkillPinStatus, type SkillPinDeps } from "./runtime/isolated-sdk/skill-pin";
import { createSdkSkillCatalogPort } from "./runtime/isolated-sdk";
import { withCallerThread } from "./api/caller";
import { attachDashboardUsageCollector, USAGE_CHANGED_CHANNEL } from "./api/dashboard-usage-rpc";
import { createDashboardUsageReader, dashboardUsageCatalogFromSql } from "./runtime/dashboard-usage";
import { listStoredBindings, listStoredDepartments, listStoredPolicies } from "./api/catalog";
import { checkLaunchLimits, listBudgets, type LimitDeps } from "./rules/limits";
import { acceptedVersions, assertDependenciesDone, sweepNextSteps, type NextStepPorts } from "./flow/service";
import { assertOwnershipFree } from "./flow/ownership";
import { recheckJobText, sweepNightlyRecheck, type NightlyRecheckPorts } from "./runtime/nightly-recheck/service";
import { buildDigest, listOwnerMessages, markOwnerMessagesRead, readOwnerMessage, recordOwnerMessage, scriptTemplates, setTelegramState } from "./owner-messages/service";
import { serverDay } from "./runtime/nightly-recheck/service";
import { sweepRemarkPatterns } from "./knowledge/remark-patterns";
import { agentDeleteBlocker, archiveDepartment, deleteAgent, deleteDepartment, departmentArchivedAt, departmentDeleteBlocker, restoreDepartment } from "./organization/lifecycle";
import { installStarterKit, starterKitView, translateStarterKit, type StarterKitPorts } from "./organization/starter-kit";
import { rulesForLaunch, workRulesView } from "./rules/work-rules";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { rpcContract } from "../shared/rpc-contract";
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
  parseModelPriceOverrides,
  type ModelPriceTable,
} from "./runtime/dashboard-usage/pricing";
import { lastProgressFromDatabase, superviseRun, type RunWatchPorts } from "./runtime/run-watch/service";
import { DUE_SWEEP_INTERVAL_MS, sweepDueReminders } from "./runtime/due-reminder/service";
import { DEFAULT_BOARD_POLICY, type BoardPolicy } from "../shared/contracts";
import { buildAgencyInstructions, DELEGATION_MODES, parseDelegationMode, type DelegationMode } from "./delegation/instructions";

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
        "delegate — агент сам поручает крупную работу подходящему отделу; suggest — только предлагает владельцу; off — не добавлять. Треды исполнителей Агентства получают роль руководителя или исполнителя в режимах delegate и suggest.",
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
        'USD за миллион токенов. Цены Claude уже встроены (проверены 2026-09-16). Добавить или изменить: {"gpt-5.6-sol": {"input": 1.25, "cachedInput": 0.125, "output": 10}}. Оценка без записи в кеш.',
      experimental_multiline: true,
    },
  });
  // Instruction providers are synchronous; keep the last known settings in memory.
  let delegationMode: DelegationMode = "delegate";
  let boardPolicy: BoardPolicy = { ...DEFAULT_BOARD_POLICY };
  let archiveAfterDays = DEFAULT_ARCHIVE_AFTER_DAYS;
  let modelPrices: ModelPriceTable = DEFAULT_MODEL_PRICES;
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
  const domain = createDomainRpc({
    bb,
    store,
    db,
    onChanged,
    documents,
    send,
    boardPolicy: () => boardPolicy,
    archivedJobIds: () => archivedJobIds(db, archiveAfterDays, new Date()),
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
  const checkLaunchGate = async (job: Job) => {
    const en = agencyLanguage() === "en";
    const dependencies = assertDependenciesDone(db, job, en);
    if (!dependencies.ok) return dependencies;
    const ownership = assertOwnershipFree(db, job, en);
    if (!ownership.ok) return ownership;
    return checkLaunchLimits(limitDeps, job);
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
  const launch = createIsolatedLaunchRpc({
    bb,
    plugins,
    store,
    db,
    documents,
    onChanged,
    send,
    checkHost: (input) => machines.checkLaunch(input),
    checkLimits: checkLaunchGate,
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
    enabled: (job) => rulesForLaunch(db, job.departmentId, job.assignedAgentId ?? "").autoReview,
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
  const organization = {
    starterKit: async (input: { language?: "ru" | "en" }) => {
      const access = readOnly();
      if (!access.ok) return access;
      return { ok: true as const, value: starterKitView(db, kitLanguage(input.language), new Date().toISOString()) };
    },
    installStarterKit: async (input: { keys: string[]; language?: "ru" | "en" }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      // A starter employee meant for Grok or GPT starts on the role default when that CLI is not connected here.
      const connected = await connectedProviders();
      const result = installStarterKit(
        { ...starterKitPorts(access.value.ctx), ...(connected ? { providerAvailable: (providerId: string) => connected.has(providerId) } : {}) },
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
    listKnowledge: async () => {
      const access = readOnly();
      if (!access.ok) return access;
      return { ok: true as const, value: listKnowledge(db) };
    },
    saveKnowledge: async (input: SaveKnowledgeInput) => {
      const access = readOnly();
      if (!access.ok) return access;
      // An employee's material is a proposal until the owner accepts it.
      const saved = saveKnowledge(db, input, { proposedBy: access.value.ctx.caller?.agentId ?? null }, new Date().toISOString());
      if (saved.ok) onChanged();
      return saved;
    },
    setKnowledgeStatus: async (input: { id: string; expectedRevision: number; status: "proposal" | "accepted" | "archived" }) => {
      const access = ownerOnly();
      if (!access.ok) return access;
      const saved = setKnowledgeStatus(db, input, new Date().toISOString());
      if (saved.ok) onChanged();
      return saved;
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
  const handlers = { ...domain, ...launch, ...dispatcher, ...dashboardUsage.handlers, ...budgets } satisfies Pick<
    PluginRpcHandlers<typeof rpcContract>,
    | "listBudgets"
    | "getSkillPins"
    | "listBackups"
    | "createBackup"
    | "restoreBackup"
    | "listKnowledge"
    | "saveKnowledge"
    | "setKnowledgeStatus"
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
  const providerErrorDetail = async (threadId: string): Promise<string | null> => {
    try {
      const events = await bb.sdk.threads.events.list({ threadId, order: "desc", limit: "20", types: ["provider/error"] });
      for (const event of events as readonly { data?: unknown }[]) {
        const data = event.data as { detail?: unknown; message?: unknown } | undefined;
        const text = [data?.detail, data?.message].find((value) => typeof value === "string" && value.trim());
        if (typeof text === "string") return text;
      }
    } catch {
      /* the thread could not be read: the watch decides without a reason */
    }
    return null;
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
  const runWatchPorts = (extra?: Partial<RunWatchPorts>): RunWatchPorts => ({
    db,
    getJob: (jobId) => store.getJob(jobId),
    attemptForLaunch,
    lastProgressAt: (threadId, jobId) => lastProgressFromDatabase(db, threadId, jobId),
    comment: systemComment,
    block: blockWithReason,
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
      const result = await sweepLaunchQueue({
        db,
        getJob: (jobId) => store.getJob(jobId),
        checkLimits: checkLaunchGate,
        launch: async (job, requestedAt) => {
          const prepared = (await launch.prepareLaunch({
            requestId: uuidV5(LAUNCH_QUEUE_NAMESPACE, `${job.id}:${requestedAt}:${job.revision}`),
            jobId: job.id,
            expectedRevision: job.revision,
          })) as { ok: true; value: { launched: unknown; reason: string } } | { ok: false; error: { code: string; message: string } };
          if (prepared.ok && !prepared.value.launched) return { ok: false, error: { code: "launch_not_started", message: prepared.value.reason } };
          return prepared as { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
        },
        comment: systemComment,
        notifyOwner: (input) => {
          void sendOwnerMessage({ text: input.text, level: "warning", jobId: input.jobId, dedupeKey: input.dedupeKey }, "launch-queue");
        },
        now: () => new Date().toISOString(),
      });
      if (result.launched || result.removed) onChanged();
    } catch (error) {
      bb.log.warn(`Launch queue: ${String(error)}`);
    } finally {
      queueBusy = false;
    }
  };
  const queueSweep = setInterval(() => void runLaunchQueue(), LAUNCH_QUEUE_SWEEP_MS);
  bb.onDispose(() => clearInterval(queueSweep));
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
      if (runRemarkPatterns() > 0) changed = true;
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
        void startAutoReview(autoReviewPorts(), row.jobId).then(
          (outcome) => {
            if (outcome !== "skipped") onChanged();
          },
          (error) => bb.log.warn(`Auto review for ${row.jobId}: ${String(error)}`),
        );
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
        let hostOnline: boolean | null = null;
        if (reading.threadStatus === "error") {
          errorDetail = await providerErrorDetail(row.threadId);
          const job = store.getJob(row.jobId);
          hostOnline = job ? await jobHostOnline(job) : null;
        }
        const watched = superviseRun(runWatchPorts({ providerError: () => errorDetail, hostOnline: () => hostOnline }), row, {
          threadStatus: reading.threadStatus,
          threadUpdatedAt: thread?.updatedAt ? new Date(thread.updatedAt).toISOString() : null,
          backgroundAgents: thread?.activeBackgroundAgentCount ?? 0,
        });
        if (watched === "warned" || watched === "blocked") onChanged();
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
  void flushParentWakes({ db, send, now: recoveredAt }).catch(() => undefined);
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
