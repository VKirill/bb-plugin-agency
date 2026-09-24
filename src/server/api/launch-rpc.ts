import { contextForLaunch } from "../runtime/worker-context/store";
import { recoverJob } from "../runtime/recovery/service";
import { WAIT_CODES } from "../runtime/launch-queue/service";
import { buildWorkerInstructions, readJobRoleContext } from "../delegation/instructions";
import { listTemplates } from "../templates/store";
import type { MembershipRole } from "../../shared/contracts";
import type { PlaybookKey } from "../../shared/templates";
import { sandboxEscapeCounts } from "../runtime/sandbox-escape/service";
import type { PluginDirectory } from "../integrations/plugin-directory";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { fail, ok, type DomainResult } from "../../domain";
import { createSdkHostFilePortFromBinding, type HostFileRpcClient } from "../../host";
import type { Job } from "../../shared/contracts/job";
import { publicLaunchReasonCode, rpcContract, type IsolationReadiness } from "../../shared/rpc-contract";
import { listStoredBindings } from "./catalog";
import { resolveRpcAccess } from "./auth";
import type { SqlDatabase } from "../db/sql";
import type { DomainStore, ServiceContext } from "../services";
import {
  applyVerifiedCompletionLifecycle,
  interpretVerifiedCompletion,
  readJobPublishedArtifact,
  pinCatalogRolesForPrepare,
  resolveCatalogRoles,
  type IsolatedCatalogRolesConfig,
  createIsolatedSpawnPort,
  createIsolatedThreadVerifyPort,
  createSdkSkillCatalogPort,
  createStoreJobRunningPort,
  bindOfficialThreads,
  isolatedViewFromRecord,
  resolveLiveAssignedProvider,
  type LiveAssignedProvider,
  readCompletionFromCore,
} from "../runtime/isolated-sdk";
import {
  attemptStoreFromRunStore,
  createLaunchCoordinator,
  liveIdentityFromDatabase,
  NATIVE_SPAWN_READINESS,
  type LaunchCoordinatorResult,
} from "../runtime/launch";
import {
  createJobInputPort,
  createPrepareRun,
  type PrepareRunPublicInput,
  type PreparedRun,
} from "../runtime/prepare-run";
import { applyLaunchCandidate, launchCandidates, type LaunchCandidate } from "../runtime/agent-fallback";
import {
  fallbackLaunchText,
  fallbackReadinessText,
  launchOnFirstReadyCandidate,
  refusalBelongsToCandidate,
  refusedCandidatesError,
  type TriedCandidate,
} from "../runtime/prepare-run/model-candidates";
import { uuidV5 } from "../runtime/launch/operation-ids";
import { ACTIVE_RUN_ATTEMPT_STATES, createInternalRunStoreReads, createRunStore } from "../runtime/run-store";
import { createCancelLaunchService } from "../runtime/cancel-launch";
import { returnJobForRework } from "../runtime/rework/service";
import { readProjectRulesFile } from "./project-rules";
import { agencyLanguage } from "../i18n/language.js";
import type { IsolatedSendPort } from "../runtime/isolated-sdk/send-port.js";
import { createReviewerThreadReusePort } from "../runtime/reviewer-thread/service.js";
import { flushParentWakes } from "../runtime/parent-wake";
import type { ThreadGetPort, ThreadListRunningPort, ThreadStopPort } from "../runtime/stop-handoff/ports.js";
import type { OfficialThreadStatus } from "../runtime/stop-handoff/types.js";

type LaunchMethod =
  | "prepareLaunch"
  | "getLaunch"
  | "reconcileLaunch"
  | "interpretWorkerCompletion"
  | "listJobAttempts"
  | "getIsolationReadiness"
  | "cancelLaunch"
  | "returnJobForRework"
  | "recoverJob";
type LaunchHandlers = Pick<PluginRpcHandlers<typeof rpcContract>, LaunchMethod>;

const DEFAULT_APPLICABLE = [{ sourceId: "binding", relativePath: ".bb/AGENTS.md" }] as const;

const OFFICIAL: ReadonlySet<string> = new Set(["active", "error", "idle", "pending", "starting", "stopping"]);

function officialCancelPorts(threads: BbPluginApi["sdk"]["threads"]): {
  stop: ThreadStopPort;
  get: ThreadGetPort;
  listRunning: ThreadListRunningPort;
} {
  const listRunningFn = Reflect.get(threads, "listRunning");
  return {
    stop: {
      supported: true,
      async stop(args) {
        const result = await threads.stop({ threadId: args.threadId });
        if (Reflect.get(result, "ok") !== true) throw new Error("threads.stop did not acknowledge");
        return { ok: true };
      },
    },
    get: {
      supported: true,
      async get(args) {
        const view = isolatedViewFromRecord(await threads.get({ threadId: args.threadId }));
        const status = view.status && OFFICIAL.has(view.status) ? (view.status as OfficialThreadStatus) : null;
        return { threadId: view.id || args.threadId, status };
      },
    },
    listRunning:
      typeof listRunningFn === "function"
        ? {
            supported: true,
            async listRunning() {
              const listed = await listRunningFn.call(threads);
              const rows = Array.isArray(listed) ? listed : Reflect.get(listed, "threads");
              if (!Array.isArray(rows)) return [];
              return rows
                .filter((row) => Boolean(row) && typeof row === "object")
                .map((row) => ({
                  id: String(Reflect.get(row, "id") ?? ""),
                  hostId: typeof Reflect.get(row, "hostId") === "string" ? String(Reflect.get(row, "hostId")) : null,
                }))
                .filter((row) => row.id.length > 0);
            },
          }
        : { supported: false },
  };
}

/** Tools of the selected plugins; a plugin that is not installed or not running stops the launch. */
/** Which base instruction reaches which role type. */
const PLAYBOOK_TEMPLATE: Record<MembershipRole, PlaybookKey> = {
  lead: "playbookLead",
  executor: "playbookExecutor",
  reviewer: "playbookReviewer",
  assistant: "playbookAssistant",
};

export function pluginToolsFrom(plugins: PluginDirectory) {
  return async (pluginIds: readonly string[]): Promise<DomainResult<{ pluginId: string; toolNames: string[] }[]>> => {
    let installed;
    try {
      installed = await plugins.list();
    } catch (error) {
      return fail("plugins_unavailable", `Не удалось прочитать список плагинов BB: ${error instanceof Error ? error.message : String(error)}`);
    }
    const grants: { pluginId: string; toolNames: string[] }[] = [];
    for (const pluginId of pluginIds) {
      const plugin = installed.find((item) => item.id === pluginId);
      if (!plugin || !plugin.running) {
        return fail("plugin_unavailable", `Плагин «${plugin?.name ?? pluginId}» выбран в профиле сотрудника, но ${plugin ? "выключен" : "не установлен"} в BB. Включите плагин или уберите его в профиле.`);
      }
      grants.push({ pluginId, toolNames: [...plugin.toolNames] });
    }
    return ok(grants);
  };
}

export function createIsolatedLaunchRpc(deps: {
  bb: BbPluginApi;
  store: DomainStore;
  db: SqlDatabase;
  documents: HostFileRpcClient;
  loadCatalogRoles?: () => Promise<DomainResult<IsolatedCatalogRolesConfig | undefined>>;
  /** Machine readiness before a snapshot is reserved: online, provider CLI installed and allowed. */
  checkHost?: (input: { hostId: string; providerId: string }) => Promise<DomainResult<void>>;
  /** The machine really has the employee's model; an unknown catalog blocks nothing. */
  checkModel?: (input: { hostId: string; providerId: string; model: string }) => Promise<DomainResult<void>>;
  /** Concurrency and budget limits from the work rules; warnings do not stop the launch. */
  checkLimits?: (job: Job) => Promise<DomainResult<{ warnings: string[] }>>;
  /** Подсказка оценщика к запуску: навыки и записи памяти под задачу. Не задана — запуск как раньше. */
  briefing?: import("../runtime/prepare-run/prepare").PrepareRunDeps["briefing"];
  /** Installed BB plugins: tools of the plugins an employee profile selects. */
  plugins?: PluginDirectory;
  /** Job history line: a launch that went to a reserve says which model did not start. */
  comment?: (job: Job, text: string) => void;
  onChanged?: () => void;
  send?: IsolatedSendPort;
}): LaunchHandlers {
  const runs = createRunStore(deps.db);
  const reads = createInternalRunStoreReads(deps.db);
  const catalog = createSdkSkillCatalogPort(deps.bb.sdk.skills);
  const officialThreads = bindOfficialThreads(deps.bb.sdk.threads);

  // Limit check and slot reservation run one at a time: two launches must not both pass a limit of one.
  let launchGate: Promise<void> = Promise.resolve();
  async function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const previous = launchGate;
    let release!: () => void;
    launchGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await run();
    } finally {
      release();
    }
  }

  function systemCtx(): ServiceContext {
    return {
      actor: { kind: "system" },
      allowedBindingIds: listStoredBindings(deps.db).map((row) => row.id),
    };
  }

  function buildCoordinator() {
    return createLaunchCoordinator({
      store: attemptStoreFromRunStore(runs, reads),
      liveIdentity: liveIdentityFromDatabase(deps.db),
      readiness: { assess: () => NATIVE_SPAWN_READINESS },
      spawn: createIsolatedSpawnPort(
        officialThreads,
        (contract) => {
          const stored = reads.getSnapshot(systemCtx(), contract.snapshotId);
          return stored.ok ? stored.value.snapshot : undefined;
        },
        (contract) => {
          const attempt = reads.getAttempt(systemCtx(), contract.attemptId);
          return attempt.ok ? attempt.value.jobId : "";
        },
        true,
      ),
      threadVerify: createIsolatedThreadVerifyPort(officialThreads, true),
      jobRunning: createStoreJobRunningPort(deps.store),
      threadReuse: createReviewerThreadReusePort(deps.db, officialThreads, deps.send),
    });
  }

  async function withAccess<T>(
    run: (ctx: ServiceContext) => Promise<DomainResult<T>> | DomainResult<T>,
  ): Promise<DomainResult<T>> {
    const access = resolveRpcAccess(deps.db);
    if (!access.ok) return access;
    return run(access.value.ctx);
  }

  return {
    prepareLaunch: async (input) => {
      return withAccess<{
        snapshotId: string;
        digest: string;
        attemptId: string;
        launched: LaunchCoordinatorResult;
        reason: string;
        warnings?: string[];
      }>(async (ctx) => {
        const job = deps.store.getJob(input.jobId);
        if (!job) return fail("not_found", `job ${input.jobId} not found`);
        const assigned = resolveLiveAssignedProvider(deps.store, job);
        if (!assigned.ok) return assigned;
        const binding = deps.store.getBinding(job.bindingId);
        if (!binding) return fail("not_found", `binding ${job.bindingId} not found`);
        const storedVersion = deps.store.getAgentVersion(assigned.value.agentVersionId);
        if (!storedVersion) return fail("not_found", `agent version ${assigned.value.agentVersionId} not found`);
        const files = createSdkHostFilePortFromBinding(deps.documents, binding);
        if (!files.ok) return files;
        const listed = await catalog.list({
          projectId: binding.bbProjectId,
          environmentId: binding.environmentId,
          hostId: binding.hostId,
        });
        if (!listed.ok) return listed;
        const loaded = deps.loadCatalogRoles ? await deps.loadCatalogRoles() : { ok: true as const, value: undefined };
        if (!loaded.ok) return loaded;
        const roles = loaded.value
          ? await pinCatalogRolesForPrepare({
              catalog,
              listed: listed.value,
              config: loaded.value,
              hostId: binding.hostId,
            })
          : resolveCatalogRoles(listed.value);
        if (!roles.ok) return roles;
        let warnings: string[] = [];
        type Launched = { prepared: PreparedRun; launched: LaunchCoordinatorResult };
        // The primary first, then the owner's reserves: the first pair this machine can start wins.
        const walk = await launchOnFirstReadyCandidate<Launched>({
          candidates: launchCandidates(deps.db, assigned.value.agentId, storedVersion, new Date().toISOString()),
          check: async (candidate) => {
            if (deps.checkHost) {
              const host = await deps.checkHost({ hostId: binding.hostId, providerId: candidate.providerId });
              if (!host.ok) return host;
            }
            if (deps.checkModel) {
              const model = await deps.checkModel({ hostId: binding.hostId, providerId: candidate.providerId, model: candidate.model });
              if (!model.ok) return model;
            }
            return ok(undefined);
          },
          launch: async (candidate, position) => {
            // A reserve is a new attempt of the same request: its operations get their own ids.
            const requestId = position === 0 ? input.requestId : uuidV5(input.requestId, `agency.launch.candidate.${position}`);
            const prepare = createPrepareRun({
              workerContext: (departmentId, agentId) => contextForLaunch(deps.db, departmentId, agentId),
              store: deps.store,
              files: files.value,
              catalog,
              runs,
              jobInputs: createJobInputPort({ store: deps.store, db: deps.db, files: files.value }),
              effectiveAgentVersion: (version) => applyLaunchCandidate(version, candidate),
              hasLiveAttempt: (jobId) => {
                const attempts = reads.listAttempts(systemCtx(), jobId);
                return !attempts.ok || attempts.value.some((attempt) => (ACTIVE_RUN_ATTEMPT_STATES as readonly string[]).includes(attempt.state));
              },
              // The gate holds the limit check and the reservation only: the snapshot is compiled
              // before it and the thread is spawned after it, so launches of other jobs go on meanwhile.
              reserveGate: (reserve) =>
                exclusive(async () => {
                  if (deps.checkLimits) {
                    const limits = await deps.checkLimits(job);
                    if (!limits.ok) return limits;
                    warnings = limits.value.warnings;
                  }
                  return reserve();
                }),
              ...(deps.plugins ? { pluginTools: pluginToolsFrom(deps.plugins) } : {}),
              ...(deps.briefing ? { briefing: deps.briefing } : {}),
              roleInstructions: (jobId) => {
                const role = readJobRoleContext(deps.db, jobId);
                if (!role) return null;
                // The owner's base instruction of this role type: one order of work for every job.
                const playbook = listTemplates(deps.db).find((row) => row.key === PLAYBOOK_TEMPLATE[role.assigneeType])?.text ?? null;
                return buildWorkerInstructions({ ...role, playbook });
              },
              server: {
                applicable: DEFAULT_APPLICABLE,
                catalogRoles: roles.value,
              },
            });
            const publicInput: PrepareRunPublicInput = {
              requestId,
              jobId: input.jobId,
              expectedRevision: input.expectedRevision,
            };
            // A refusal that is already known costs nothing: no files read, no briefing asked.
            if (deps.checkLimits) {
              const early = await deps.checkLimits(job);
              if (!early.ok) return early;
            }
            const prepared = await prepare.prepare(ctx, publicInput);
            if (!prepared.ok) return prepared;
            // Pin the protocol before a new thread can act; existing running attempts stay legacy.
            deps.db.prepare("INSERT OR IGNORE INTO agency_handin_protocol(attempt_id) VALUES (?)").run(prepared.value.reserved.attempt.attemptId);
            const launched = await buildCoordinator().launchPreparedRun(ctx, {
              requestId,
              snapshotId: prepared.value.reserved.snapshotId,
              digest: prepared.value.reserved.digest,
              attemptId: prepared.value.reserved.attempt.attemptId,
              attestation: {
                accessVerified: true,
                revisionsVerified: true,
                expectedJobRevision: prepared.value.snapshot.job.revision,
                expectedBindingRevision: prepared.value.snapshot.binding.revision,
              },
              claimedBbProjectId: prepared.value.snapshot.binding.bbProjectId,
            });
            if (!launched.ok) return launched;
            return ok({ prepared: prepared.value, launched: launched.value });
          },
          // Only a spawn BB refused outright leaves no thread behind; an unknown outcome is never retried on another model.
          spawnRefusal: (value) =>
            value.launched.kind === "failed" && !value.launched.attempt.threadId
              ? { code: value.launched.code, message: value.launched.message }
              : null,
        });
        if (!walk.result.ok) return walk.result;
        const { prepared, launched } = walk.result.value;
        const modelNote = walk.used && walk.tried.length ? fallbackLaunchText({ jobKey: job.key, tried: walk.tried, used: walk.used }) : null;
        if (modelNote && launched.kind === "running") deps.comment?.(job, modelNote);
        deps.onChanged?.();
        return ok({
          snapshotId: prepared.reserved.snapshotId,
          digest: prepared.reserved.digest,
          attemptId: prepared.reserved.attempt.attemptId,
          launched,
          reasonCode: "ok" as const,
          reason: launched.kind === "running" ? "verified bind applied" : launched.kind,
          ...(walk.used ? { model: { providerId: walk.used.providerId, model: walk.used.model, source: walk.used.source } } : {}),
          ...(warnings.length ? { warnings } : {}),
        });
      });
    },
    getLaunch: async (input) => {
      return withAccess((ctx) => {
        if (input.launchId) return reads.getLaunchReceipt(ctx, input.launchId);
        if (input.attemptId) return reads.getLaunchReceiptByAttempt(ctx, input.attemptId);
        return fail("invalid_command", "getLaunch needs launchId or attemptId");
      });
    },
    reconcileLaunch: async (input) => {
      return withAccess(async (ctx) => {
        const result = await buildCoordinator().reconcileLaunch(ctx, {
          requestId: input.requestId,
          attemptId: input.attemptId,
          launchId: input.launchId,
        });
        if (!result.ok) return result;
        const attempt = result.value.attempt;
        if ((attempt.state === "running" || attempt.state === "awaiting_review") && attempt.threadId) {
          let threadStatus: string | null = null;
          try {
            const thread = await officialThreads.get({
              threadId: attempt.threadId,
              include: "environment,host",
            });
            threadStatus = thread.status ?? null;
          } catch {
            threadStatus = null;
          }
          const published = await readJobPublishedArtifact(
            { ctx, store: deps.store, db: deps.db, documents: deps.documents },
            attempt.jobId,
          );
          const reading = interpretVerifiedCompletion({
            threadStatus,
            publishedVerified: published.ok ? published.value.publishedVerified : false,
            acceptedVerified: published.ok ? published.value.acceptedVerified : false,
          });
          const applied = applyVerifiedCompletionLifecycle({
            store: deps.store,
            runs,
            reads,
            ctx,
            jobId: attempt.jobId,
            launchId: input.launchId,
            reading,
            publishedHash: published.ok ? published.value.publishedHash : null,
          });
          if (applied.ok && (applied.value.attemptReviewApplied || applied.value.attemptAcceptedApplied)) {
            const latest = reads.getAttempt(ctx, attempt.attemptId);
            if (latest.ok) {
              deps.onChanged?.();
              return ok({ ...result.value, attempt: latest.value });
            }
          }
        }
        deps.onChanged?.();
        return result;
      });
    },
    interpretWorkerCompletion: async (input) => {
      return withAccess(async (ctx) => {
        const job = deps.store.getJob(input.jobId);
        if (!job) return fail("not_found", `job ${input.jobId} not found`);
        let threadStatus: string | null = null;
        if (input.launchId) {
          const receipt = reads.getLaunchReceipt(ctx, input.launchId);
          if (receipt.ok && receipt.value.jobId !== input.jobId) {
            return fail("caller_job_mismatch", "launch receipt job does not match interpret jobId");
          }
          if (receipt.ok && receipt.value.threadId) {
            try {
              const thread = await officialThreads.get({
                threadId: receipt.value.threadId,
                include: "environment,host",
              });
              threadStatus = thread.status ?? null;
            } catch {
              threadStatus = null;
            }
          }
        }
        const assessed = await readCompletionFromCore({
          threadStatus,
          jobId: input.jobId,
          ctx,
          store: deps.store,
          db: deps.db,
          documents: deps.documents,
        });
        if (!assessed.ok) return assessed;
        if (!input.launchId) return assessed;
        const published = await readJobPublishedArtifact(
          { ctx, store: deps.store, db: deps.db, documents: deps.documents },
          input.jobId,
        );
        const applied = applyVerifiedCompletionLifecycle({
          store: deps.store,
          runs,
          reads,
          ctx,
          jobId: input.jobId,
          launchId: input.launchId,
          reading: assessed.value,
          publishedHash: published.ok ? published.value.publishedHash : null,
        });
        if (!applied.ok) return applied;
        if (applied.value.reviewApplied || applied.value.attemptReviewApplied || applied.value.attemptAcceptedApplied) {
          deps.onChanged?.();
        }
        return ok({
          runSucceeded: false as const,
          runFailed: applied.value.runFailed,
          mayEnterReview: applied.value.mayEnterReview,
          publishedVerified: applied.value.publishedVerified,
          acceptedVerified: applied.value.acceptedVerified,
          threadStatus: applied.value.threadStatus,
          reason: applied.value.reason,
        });
      });
    },

    listJobAttempts: async (input) => {
      return withAccess((ctx) => {
        const job = deps.store.getJob(input.jobId);
        if (!job) return fail("not_found", `job ${input.jobId} not found`);
        const access = deps.store.assertBindingAccess(ctx, job.bindingId);
        if (!access.ok) return access;
        if (input.claimedBbProjectId) {
          const scoped = deps.store.scopedJob(ctx, input.jobId, input.claimedBbProjectId);
          if (!scoped.ok) return scoped;
        }
        const listed = reads.listAttempts(ctx, input.jobId);
        if (!listed.ok) return listed;
        const escapes = sandboxEscapeCounts(deps.db, listed.value.map((attempt) => attempt.attemptId));
        return ok({
          jobId: input.jobId,
          attempts: listed.value.map((attempt) => ({
            attemptId: attempt.attemptId,
            jobId: attempt.jobId,
            attemptNo: attempt.attemptNo,
            snapshotId: attempt.snapshotId,
            digest: attempt.digest,
            threadId: attempt.threadId,
            launchId: attempt.launchId,
            state: attempt.state,
            revision: attempt.revision,
            createdAt: attempt.createdAt,
            updatedAt: attempt.updatedAt,
            ...(escapes.get(attempt.attemptId) ? { outsideSandboxCommands: escapes.get(attempt.attemptId) } : {}),
          })),
        });
      });
    },

    getIsolationReadiness: async (input) => {
      return withAccess(async (ctx) => {
        const ready = NATIVE_SPAWN_READINESS;
        let assignedProvider: LiveAssignedProvider | null = null;
        let assignedReason: string | null = null;
        let assignedErrorCode: string | null = null;
        let warnings: string[] = [];
        let modelWarnings: string[] = [];
        if (input.jobId) {
          const job = deps.store.getJob(input.jobId);
          if (!job) return fail("not_found", `job ${input.jobId} not found`);
          const access = deps.store.assertBindingAccess(ctx, job.bindingId);
          if (!access.ok) return access;
          const assigned = resolveLiveAssignedProvider(deps.store, job);
          if (!assigned.ok) {
            assignedErrorCode = assigned.error.code;
            assignedReason = assigned.error.message;
          } else {
            assignedProvider = assigned.value;
          }
          if (assignedErrorCode === "agent_inactive") {
            assignedReason = "Исполнитель приостановлен: включите его профиль или назначьте другого сотрудника.";
          }
          // What the launch itself would check, said before the button is pressed: the primary,
          // then the owner's reserves — the first pair this machine can start is the one named.
          const binding = deps.store.getBinding(job.bindingId);
          const storedVersion = assignedProvider ? deps.store.getAgentVersion(assignedProvider.agentVersionId) : undefined;
          if (!assignedErrorCode && binding && assignedProvider && storedVersion) {
            const live = assignedProvider;
            const refused: TriedCandidate[] = [];
            let chosen: LaunchCandidate | null = null;
            for (const candidate of launchCandidates(deps.db, live.agentId, storedVersion, new Date().toISOString())) {
              const pair = { ...live, providerId: candidate.providerId, model: candidate.model };
              const blocked = providerPolicyBlock(deps.store, binding.policyVersionId, pair);
              let error = blocked ? { code: "provider_constraint_mismatch", message: blocked } : null;
              if (!error && deps.checkHost) {
                const host = await deps.checkHost({ hostId: binding.hostId, providerId: candidate.providerId });
                if (!host.ok) error = host.error;
              }
              if (!error && deps.checkModel) {
                const model = await deps.checkModel({ hostId: binding.hostId, providerId: candidate.providerId, model: candidate.model });
                if (!model.ok) error = model.error;
              }
              if (!error) {
                chosen = candidate;
                assignedProvider = pair;
                break;
              }
              // The machine is off or the like: no other model helps, the reason stands alone.
              if (!refusalBelongsToCandidate(error)) {
                refused.length = 0;
                refused.push({ candidate, error });
                break;
              }
              refused.push({ candidate, error });
            }
            if (!chosen && refused.length) {
              const combined = refusedCandidatesError(refused);
              assignedErrorCode = combined.code;
              assignedReason = combined.message;
            } else if (chosen && refused.length) {
              modelWarnings = [fallbackReadinessText({ tried: refused, used: chosen })];
              warnings = modelWarnings;
            }
            if (!assignedErrorCode) {
              const rules = await readProjectRulesFile(deps.documents, binding);
              if (rules.ok && !rules.value.exists) {
                assignedErrorCode = "project_rules_missing";
                assignedReason = "В папке проекта нет файла правил .bb/AGENTS.md: создайте его во вкладке «Правила» проекта.";
              }
            }
            if (!assignedErrorCode && deps.checkLimits) {
              const limits = await deps.checkLimits(job);
              if (!limits.ok) {
                assignedErrorCode = limits.error.code;
                assignedReason = limits.error.message;
              } else {
                warnings = [...modelWarnings, ...limits.value.warnings];
              }
            }
          }
        } else {
          assignedReason = "getIsolationReadiness without jobId does not authorize a launch";
        }
        const launchAllowedForAssigned = Boolean(assignedProvider && !assignedReason);
        const reason = assignedReason ?? ready.reason;
        return ok({
          executionAvailable: ready.executionAvailable,
          isolationReady: ready.isolationReady,
          assignedProvider,
          launchAllowedForAssigned,
          reasonCode: publicLaunchReasonCode({
            assignedErrorCode,
            launchAllowed: launchAllowedForAssigned,
            hasJobId: Boolean(input.jobId),
          }),
          reason,
          ...(warnings.length ? { warnings } : {}),
          ...(assignedErrorCode && WAIT_CODES.has(assignedErrorCode) ? { waitable: true } : {}),
        } satisfies IsolationReadiness);
      });
    },

    cancelLaunch: async (input) => {
      return withAccess(async (ctx) => {
        const ports = officialCancelPorts(deps.bb.sdk.threads);
        const result = await createCancelLaunchService({
          db: deps.db,
          store: deps.store,
          runs,
          reads,
          stop: ports.stop,
          get: ports.get,
          listRunning: ports.listRunning,
        }).cancelLaunch(ctx, input);
        if (result.ok && deps.send) {
          await flushParentWakes({ db: deps.db, send: deps.send, now: new Date().toISOString() });
        }
        return result;
      });
    },
    recoverJob: async (input) => {
      return withAccess(async (ctx) => {
        if (!deps.send) return fail("sdk_send_unsupported", "thread messages are not available on this server");
        const job = deps.store.getJob(input.jobId);
        if (!job) return fail("not_found", `job ${input.jobId} not found`);
        const access = deps.store.assertBindingAccess(ctx, job.bindingId);
        if (!access.ok) return access;
        const result = await recoverJob(
          {
            db: deps.db,
            store: deps.store,
            runs,
            reads,
            send: deps.send,
            reworkLimit: (reworkJob) => deps.store.rulesForDepartment(reworkJob.departmentId).reworkLimit,
            currentPublishedHash: async (jobId) => {
              const published = await readJobPublishedArtifact(
                { ctx, store: deps.store, db: deps.db, documents: deps.documents },
                jobId,
              );
              return published.ok && published.value.publishedVerified ? published.value.publishedHash : null;
            },
          },
          ctx,
          input,
        );
        if (result.ok) deps.onChanged?.();
        return result;
      });
    },
    returnJobForRework: async (input) => {
      return withAccess(async (ctx) => {
        if (!deps.send) return fail("sdk_send_unsupported", "thread messages are not available on this server");
        const job = deps.store.getJob(input.jobId);
        if (!job) return fail("not_found", `job ${input.jobId} not found`);
        const access = deps.store.assertBindingAccess(ctx, job.bindingId);
        if (!access.ok) return access;
        const result = await returnJobForRework(
          {
            db: deps.db,
            store: deps.store,
            runs,
            reads,
            send: deps.send,
            reworkLimit: (reworkJob) => deps.store.rulesForDepartment(reworkJob.departmentId).reworkLimit,
            currentPublishedHash: async (jobId) => {
              const published = await readJobPublishedArtifact(
                { ctx, store: deps.store, db: deps.db, documents: deps.documents },
                jobId,
              );
              return published.ok && published.value.publishedVerified ? published.value.publishedHash : null;
            },
          },
          ctx,
          input,
        );
        if (result.ok) deps.onChanged?.();
        return result;
      });
    },
  };
}

export function listBoundLaunchWatches(db: SqlDatabase): Array<{ threadId: string; jobId: string; launchId: string }> {
  const placeholders = ACTIVE_RUN_ATTEMPT_STATES.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT r.launch_id as launchId, r.job_id as jobId, r.thread_id as threadId,
              a.attempt_no as attemptNo, a.updated_at as updatedAt
         FROM agency_launch_receipt r
         INNER JOIN agency_run_attempt a ON a.id = r.attempt_id
         WHERE r.thread_id IS NOT NULL
           AND a.state IN (${placeholders})`,
    )
    .all(...ACTIVE_RUN_ATTEMPT_STATES) as Array<{
    launchId: string;
    jobId: string;
    threadId: string | null;
    attemptNo: number;
    updatedAt: string;
  }>;
  const latest = new Map<string, { launchId: string; jobId: string; threadId: string; attemptNo: number; updatedAt: string }>();
  for (const row of rows) {
    if (!row.threadId) continue;
    const current = latest.get(row.threadId);
    const next = { launchId: row.launchId, jobId: row.jobId, threadId: row.threadId, attemptNo: row.attemptNo, updatedAt: row.updatedAt };
    if (
      !current ||
      next.attemptNo > current.attemptNo ||
      (next.attemptNo === current.attemptNo && next.updatedAt > current.updatedAt)
    ) {
      latest.set(row.threadId, next);
    }
  }
  return [...latest.values()].map((row) => ({ launchId: row.launchId, jobId: row.jobId, threadId: row.threadId }));
}

/**
 * A project or employee policy that lists CLIs and leaves out the employee's CLI would fail the
 * launch with a technical code: say before the launch which policy blocks it and how to open it.
 */
function providerPolicyBlock(store: DomainStore, bindingPolicyId: string, assigned: LiveAssignedProvider): string | null {
  const en = agencyLanguage() === "en";
  const providerId = assigned.providerId;
  const project = store.getPolicyVersion(bindingPolicyId)?.cliHostConstraints.providerIds ?? [];
  if (project.length && !project.includes(providerId)) {
    return en
      ? `The project's policy allows only ${project.join(", ")}, and the employee works on ${providerId}. Open the project card and press «Allow any CLI» in «Launch readiness».`
      : `Политика проекта разрешает только ${project.join(", ")}, а сотрудник работает на ${providerId}. Откройте карточку проекта и нажмите «Разрешить любой CLI» в «Готовности к запуску».`;
  }
  const version = store.getAgentVersion(assigned.agentVersionId);
  const agent = version ? store.getPolicyVersion(version.policyVersionId)?.cliHostConstraints.providerIds ?? [] : [];
  if (agent.length && !agent.includes(providerId)) {
    return en
      ? `The employee's policy allows only ${agent.join(", ")}, not ${providerId}. Save the profile again with this CLI: the CLI is added to the policy.`
      : `Политика прав сотрудника разрешает только ${agent.join(", ")}, а не ${providerId}. Сохраните профиль с этим CLI ещё раз: CLI добавится в политику.`;
  }
  return null;
}
