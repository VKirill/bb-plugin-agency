import { attachDashboardUsageCollector, USAGE_CHANGED_CHANNEL } from "./api/dashboard-usage-rpc";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { rpcContract } from "../shared/rpc-contract";
import { openDatabase } from "./db/database";
import { createInbox } from "./inbox/store";
import { receiveNotification } from "./triggers/notify";
import { STATUS_REQUIRES_READINESS_REASON } from "../shared/schemas";
import { machineDirectory } from "./runtime/machines";
import { telegramAdapter } from "./triggers/telegram";
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
  const store = createDomainStore(db);
  const onChanged = () => bb.realtime.publish("domain-changed", null);
  const officialThreads = bindOfficialThreads(bb.sdk.threads);
  const send = createIsolatedSendPort(officialThreads);
  const domain = createDomainRpc({
    bb,
    store,
    db,
    onChanged,
    documents,
    send,
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
  const launch = createIsolatedLaunchRpc({
    bb,
    store,
    db,
    documents,
    onChanged,
    send,
    loadCatalogRoles: async () => {
      const settings = await catalogRolesSettings.get();
      const resolved = resolveIsolatedCatalogRolesPath({
        settingsJson: settings.isolatedCatalogRolesJson,
        envFilePath: process.env.AGENCY_ISOLATED_CATALOG_ROLES_FILE,
        dataDirFilePath: join(bb.server.experimental_dataDir, ISOLATED_CATALOG_ROLES_FILENAME),
      });
      if (!resolved.ok) return resolved;
      return { ok: true, value: resolved.value?.config };
    },
  });
  const dispatcher = createDispatcherRpc({ db });
  const executingActivity = createExecutingActivityRpc({
    db,
    threads: officialThreads,
  });
  const dashboardUsage = attachDashboardUsageCollector({
    db,
    events: bb.sdk.threads.events,
    onUsageChanged: () => bb.realtime.publish(USAGE_CHANGED_CHANNEL, null),
  });
  bb.onDispose(() => dashboardUsage.dispose());
  const handlers = { ...domain, ...launch, ...dispatcher } satisfies Pick<
    PluginRpcHandlers<typeof rpcContract>,
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
    applyReading: async (row, reading, publishedHash) => {
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
    },
    onReading: () => onChanged(),
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
    uiContext: async () => ({ hosts: (await bb.sdk.hosts.list()).map((host) => ({ id: host.id, name: host.name })) }),
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
            return Promise.resolve(handler(input));
          },
        },
        argv,
      ),
  });
}
