/** UI contract aligned with isolated clone `launch-rpc.ts` (2026-09-14). Shared/server stay owned by backend. */

import { tr } from "../i18n";
import type { JobState } from "../../shared/contracts";
import { productLaunchCopy, productServerReason } from "./product-reasons";
import { asUiState } from "./view-models";

export const LAUNCH_RPC = {
  prepareLaunch: "prepareLaunch",
  getLaunch: "getLaunch",
  reconcileLaunch: "reconcileLaunch",
  interpretWorkerCompletion: "interpretWorkerCompletion",
  listJobAttempts: "listJobAttempts",
  getIsolationReadiness: "getIsolationReadiness",
} as const;

export const LAUNCH_RPC_UNREGISTERED =
  "RPC запуска ещё не зарегистрирован в этом instance. Строки запусков не выдумываются.";

export const LAUNCH_LIST_UNREGISTERED =
  "Список попыток появится, когда instance отдаст listJobAttempts по jobId в scope. Сейчас доска пустая.";

export const LAUNCH_HANDSHAKE_HINT =
  "Запуск откроется, когда среда подтвердит изолированную работу. Сейчас проверен только сотрудник на Claude.";

/** Wire states from shared `RUN_ATTEMPT_STATE_VALUES`. Unknown enum → blocked, not prepare. */
export const KNOWN_RUN_ATTEMPT_STATES = [
  "prepared",
  "launching",
  "running",
  "waiting_input",
  "awaiting_review",
  "succeeded",
  "failed",
  "canceled",
  "unknown",
] as const;

export const KNOWN_ACTIVE_ATTEMPT_STATES = [
  "prepared",
  "launching",
  "running",
  "waiting_input",
] as const;

export const UNSUPPORTED_ATTEMPT_STATE = "unsupported" as const;

export const LAUNCH_STATE_UNSUPPORTED =
  "Состояние попытки сервер не поддерживает. Запуск недоступен.";

export const LAUNCH_STATE_AWAITING_REVIEW = "Ожидает проверки";

export const LAUNCH_STATE_SUCCEEDED = "Успешно завершён";

export type KnownRunAttemptState = (typeof KNOWN_RUN_ATTEMPT_STATES)[number];

export type RunAttemptView = {
  attemptId: string;
  jobId: string;
  attemptNo: number;
  snapshotId: string;
  digest: string;
  threadId: string | null;
  launchId: string | null;
  state: string;
  reportedState: string;
  revision: number;
  /** Commands run outside the CLI sandbox; absent when none. */
  outsideSandboxCommands?: number;
};

export function isKnownRunAttemptState(state: string): state is KnownRunAttemptState {
  return (KNOWN_RUN_ATTEMPT_STATES as readonly string[]).includes(state);
}

export function isKnownActiveAttemptState(state: string): boolean {
  return (KNOWN_ACTIVE_ATTEMPT_STATES as readonly string[]).includes(state);
}

export type LaunchReceiptView = {
  launchId: string;
  attemptId: string;
  jobId: string;
  snapshotId: string;
  digest: string;
  threadId: string | null;
  spawnKind: string;
  persistError: { code: string; message: string } | null;
  jobBindState: string;
  needsReconciliation: boolean;
  persisted?: boolean;
};

export type LaunchCoordinatorKind = "running" | "failed" | "canceled" | "unknown" | "needs_reconciliation";

export type LaunchCoordinatorView = {
  kind: LaunchCoordinatorKind;
  attempt: RunAttemptView;
  code?: string;
  message?: string;
  receipt: LaunchReceiptView;
};

export type PrepareLaunchView = {
  handshakeReady: boolean;
  snapshotId: string;
  digest: string;
  attemptId: string;
  launched: LaunchCoordinatorView | null;
  reason: string;
  reasonCode?: string;
};

export type CompletionView = {
  runSucceeded: false;
  runFailed: boolean;
  mayEnterReview: boolean;
  publishedVerified: boolean;
  acceptedVerified: boolean;
  threadStatus: string | null;
  reason: string;
};

export type LiveAssignedProviderView = {
  jobId: string;
  agentId: string;
  agentVersionId: string;
  providerId: string;
  source: "live_assigned_agent_version";
};

export type IsolationReadiness = {
  handshakeReady: boolean;
  executionAvailable: boolean;
  isolationReady: boolean;
  isolatedSpawnFields: boolean;
  sdkTypedSpawnReady: boolean;
  provenIsolationProviders: readonly string[];
  assignedProvider: LiveAssignedProviderView | null;
  launchAllowedForAssigned: boolean;
  reason: string;
  reasonCode?: string;
  /** Budget warnings: the launch is allowed, the owner should know. */
  warnings?: readonly string[];
  /** Blocked by a limit: the job can wait in the launch queue. */
  waitable?: boolean;
};

export type JobLaunchItem = {
  attempt: RunAttemptView;
  receipt: LaunchReceiptView | null;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function parseRunAttempt(value: unknown): RunAttemptView | null {
  const row = record(value);
  if (!row) return null;
  const attemptId = text(row.attemptId);
  const jobId = text(row.jobId);
  const snapshotId = text(row.snapshotId);
  const digest = text(row.digest);
  const state = text(row.state);
  if (!attemptId || !jobId || !snapshotId || !digest || !state) return null;
  const known = isKnownRunAttemptState(state);
  return {
    attemptId,
    jobId,
    snapshotId,
    digest,
    state: known ? state : UNSUPPORTED_ATTEMPT_STATE,
    reportedState: state,
    attemptNo: typeof row.attemptNo === "number" ? row.attemptNo : 0,
    revision: typeof row.revision === "number" ? row.revision : 0,
    threadId: text(row.threadId),
    launchId: text(row.launchId),
    ...(typeof row.outsideSandboxCommands === "number" && row.outsideSandboxCommands > 0
      ? { outsideSandboxCommands: row.outsideSandboxCommands }
      : {}),
  };
}

export function parseLaunchReceipt(value: unknown): LaunchReceiptView | null {
  const row = record(value);
  if (!row) return null;
  const launchId = text(row.launchId);
  const attemptId = text(row.attemptId);
  const jobId = text(row.jobId);
  const snapshotId = text(row.snapshotId);
  const digest = text(row.digest);
  const spawnKind = text(row.spawnKind);
  const jobBindState = text(row.jobBindState);
  if (!launchId || !attemptId || !jobId || !snapshotId || !digest || !spawnKind || !jobBindState) return null;
  const persist = record(row.persistError);
  const persistError = persist && text(persist.code) && text(persist.message)
    ? { code: text(persist.code)!, message: text(persist.message)! }
    : text(row.persistErrorCode) && text(row.persistErrorMessage)
      ? { code: text(row.persistErrorCode)!, message: text(row.persistErrorMessage)! }
      : null;
  return {
    launchId,
    attemptId,
    jobId,
    snapshotId,
    digest,
    spawnKind,
    jobBindState,
    threadId: text(row.threadId),
    persistError,
    needsReconciliation: row.needsReconciliation === true,
    persisted: typeof row.persisted === "boolean" ? row.persisted : undefined,
  };
}

export function parseCoordinator(value: unknown): LaunchCoordinatorView | null {
  const row = record(value);
  if (!row) return null;
  const kind = text(row.kind);
  const attempt = parseRunAttempt(row.attempt);
  const receipt = parseLaunchReceipt(row.receipt);
  if (!attempt || !receipt) return null;
  if (kind !== "running" && kind !== "failed" && kind !== "canceled" && kind !== "unknown" && kind !== "needs_reconciliation") {
    return null;
  }
  return {
    kind,
    attempt,
    receipt,
    code: text(row.code) ?? undefined,
    message: text(row.message) ?? undefined,
  };
}

export function parsePrepareLaunch(value: unknown): PrepareLaunchView | null {
  const row = record(value);
  if (!row) return null;
  const snapshotId = text(row.snapshotId);
  const digest = text(row.digest);
  const attemptId = text(row.attemptId);
  const reason = text(row.reason);
  if (!snapshotId || !digest || !attemptId || !reason) return null;
  return {
    handshakeReady: row.handshakeReady === true,
    snapshotId,
    digest,
    attemptId,
    launched: row.launched == null ? null : parseCoordinator(row.launched),
    reason,
    reasonCode: typeof row.reasonCode === "string" ? row.reasonCode : undefined,
  };
}

export function parseCompletion(value: unknown): CompletionView | null {
  const row = record(value);
  if (!row || typeof row.reason !== "string") return null;
  return {
    runSucceeded: false,
    runFailed: row.runFailed === true,
    mayEnterReview: row.mayEnterReview === true,
    publishedVerified: row.publishedVerified === true,
    acceptedVerified: row.acceptedVerified === true,
    threadStatus: text(row.threadStatus),
    reason: row.reason,
  };
}

export function parseJobAttempts(value: unknown): JobLaunchItem[] | null {
  const row = record(value);
  if (!row || !Array.isArray(row.attempts)) return null;
  const items: JobLaunchItem[] = [];
  for (const item of row.attempts) {
    const attempt = parseRunAttempt(item);
    if (!attempt) return null;
    items.push({ attempt, receipt: null });
  }
  return items;
}

function parseAssignedProvider(value: unknown): LiveAssignedProviderView | null {
  const row = record(value);
  if (!row) return null;
  const jobId = text(row.jobId);
  const agentId = text(row.agentId);
  const agentVersionId = text(row.agentVersionId);
  const providerId = text(row.providerId);
  if (!jobId || !agentId || !agentVersionId || !providerId) return null;
  if (row.source !== "live_assigned_agent_version") return null;
  return { jobId, agentId, agentVersionId, providerId, source: "live_assigned_agent_version" };
}

export function parseIsolationReadiness(value: unknown): IsolationReadiness | null {
  const row = record(value);
  if (!row || typeof row.reason !== "string") return null;
  if (!Array.isArray(row.provenIsolationProviders) || row.provenIsolationProviders.length === 0) return null;
  const proven = row.provenIsolationProviders.filter((item): item is string => typeof item === "string" && item.length > 0);
  if (proven.length !== row.provenIsolationProviders.length) return null;
  if (!("assignedProvider" in row) || typeof row.launchAllowedForAssigned !== "boolean") return null;
  let assignedProvider: LiveAssignedProviderView | null = null;
  if (row.assignedProvider !== null) {
    assignedProvider = parseAssignedProvider(row.assignedProvider);
    if (!assignedProvider) return null;
  }
  return {
    handshakeReady: row.handshakeReady === true,
    executionAvailable: row.executionAvailable === true,
    isolationReady: row.isolationReady === true,
    isolatedSpawnFields: row.isolatedSpawnFields === true,
    sdkTypedSpawnReady: row.sdkTypedSpawnReady === true,
    provenIsolationProviders: proven,
    assignedProvider,
    launchAllowedForAssigned: row.launchAllowedForAssigned,
    reason: row.reason,
    reasonCode: typeof row.reasonCode === "string" ? row.reasonCode : undefined,
    ...(Array.isArray(row.warnings) ? { warnings: row.warnings.filter((item): item is string => typeof item === "string") } : {}),
    ...(row.waitable === true ? { waitable: true } : {}),
  };
}

export function canLaunchFromReadiness(readiness: IsolationReadiness | null): boolean {
  return Boolean(
    readiness?.handshakeReady &&
      readiness.executionAvailable &&
      readiness.isolationReady &&
      readiness.isolatedSpawnFields &&
      readiness.sdkTypedSpawnReady &&
      readiness.provenIsolationProviders.length > 0,
  );
}

export function readinessAllowsProvider(
  readiness: IsolationReadiness | null,
  providerId: string | null | undefined,
): boolean {
  const assigned = readiness?.assignedProvider?.providerId;
  if (!readiness || !assigned || !providerId?.trim()) return false;
  if (assigned !== providerId) return false;
  if (!readiness.provenIsolationProviders.length) return false;
  return (
    readiness.launchAllowedForAssigned &&
    canLaunchFromReadiness(readiness) &&
    readiness.provenIsolationProviders.includes(providerId)
  );
}

/** Live provider comes only from getIsolationReadiness.assignedProvider, not UI job/agent drafts. */
export function launchAssigneeProviderId(readiness: IsolationReadiness | null): string | null {
  return readiness?.assignedProvider?.providerId ?? null;
}

export function jobLaunchAllowedFromReadiness(readiness: IsolationReadiness | null): boolean {
  const providerId = launchAssigneeProviderId(readiness);
  return Boolean(readiness?.launchAllowedForAssigned && readinessAllowsProvider(readiness, providerId));
}

export const LAUNCH_PROVIDER_UNAVAILABLE = "У исполнителя нет providerId. Запуск недоступен.";

export function launchReadinessNotice(
  readiness: IsolationReadiness | null,
  providerId: string | null,
): string | null {
  if (jobLaunchAllowedFromReadiness(readiness) && readinessAllowsProvider(readiness, providerId)) return null;
  if (readiness?.reasonCode === "ok") return null;
  if (!providerId) {
    return productLaunchCopy({
      reasonCode: readiness?.reasonCode,
      reason: readiness?.reason || tr(LAUNCH_PROVIDER_UNAVAILABLE),
    });
  }
  return productLaunchCopy({
    reasonCode: readiness?.reasonCode,
    reason: readiness?.reason ?? tr(LAUNCH_PROVIDER_UNAVAILABLE),
  });
}

const LAUNCHABLE_JOB_STATES = new Set(["backlog", "queued"]);
const LAUNCHABLE_JOB_LABELS = new Set(["Бэклог", "К запуску"]);

export function jobLaunchableState(state: string | undefined | null): boolean {
  if (!state) return false;
  if (LAUNCHABLE_JOB_STATES.has(state) || LAUNCHABLE_JOB_LABELS.has(state)) return true;
  return LAUNCHABLE_JOB_STATES.has(asUiState(state as JobState));
}

export function jobCanRequestLaunch(job: {
  recordId?: string;
  state: string;
  sourceState?: string;
  bindingId?: string;
  assignedAgentId?: string | null;
}): boolean {
  return Boolean(
    job.recordId &&
      job.bindingId &&
      job.assignedAgentId &&
      (jobLaunchableState(job.state) || jobLaunchableState(job.sourceState)),
  );
}

export function launchNeedsReconcile(item: {
  attempt: { state: string };
  receipt: { needsReconciliation: boolean; launchId: string } | null;
  launchedKind?: string | null;
}): boolean {
  if (item.launchedKind === "unknown" || item.launchedKind === "needs_reconciliation") return Boolean(item.receipt?.launchId);
  if (item.attempt.state === "unknown") return Boolean(item.receipt?.launchId);
  return Boolean(item.receipt?.needsReconciliation && item.receipt.launchId);
}

export function mustNotRespawn(item: { attempt: { state: string }; launchedKind?: string | null }): boolean {
  return (
    item.attempt.state === "unknown" ||
    item.attempt.state === "awaiting_review" ||
    item.launchedKind === "unknown" ||
    item.launchedKind === "needs_reconciliation"
  );
}

export function completionNeverSucceeded(view: CompletionView): boolean {
  return view.runSucceeded === false;
}

export function launchStateLabel(state: string): string {
  if (state === "prepared") return tr("Подготовлен");
  if (state === "launching") return tr("Стартует");
  if (state === "running") return tr("В работе");
  if (state === "waiting_input") return tr("Ждёт ввода");
  if (state === "failed") return tr("Ошибка");
  if (state === "canceled") return tr("Отменён");
  if (state === "unknown") return tr("Неизвестно — сверка");
  if (state === "awaiting_review") return tr(LAUNCH_STATE_AWAITING_REVIEW);
  if (state === "succeeded") return tr(LAUNCH_STATE_SUCCEEDED);
  return tr(LAUNCH_STATE_UNSUPPORTED);
}

export function readinessBlocksLaunch(prepare: PrepareLaunchView | null): string | null {
  if (!prepare) return null;
  if (prepare.handshakeReady && prepare.launched) return null;
  return prepare.reason;
}

export type LaunchUiAction = "prepare" | "reconcile" | "wait" | "blocked";

export function nextLaunchAction(input: {
  jobReady: boolean;
  handshakeReady: boolean;
  lastPrepare: PrepareLaunchView | null;
  attemptState?: string | null;
  launchedKind?: string | null;
  hasLaunchId: boolean;
  jobState?: string | null;
  hasNeedsInput?: boolean;
}): LaunchUiAction {
  if (input.hasNeedsInput || input.jobState === "waiting_input") return "wait";
  const state = input.attemptState?.trim() || null;
  const unknown = mustNotRespawn({
    attempt: { state: state ?? "" },
    launchedKind: input.launchedKind,
  });
  if (state === "awaiting_review") return "wait";
  if (unknown) return input.hasLaunchId ? "reconcile" : "blocked";
  if (state && (state === UNSUPPORTED_ATTEMPT_STATE || !isKnownRunAttemptState(state))) return "blocked";
  if (!input.handshakeReady) return "blocked";
  if (input.lastPrepare && !input.lastPrepare.handshakeReady) return "blocked";
  if (input.launchedKind === "running" || (state && isKnownActiveAttemptState(state))) return "wait";
  if (input.jobReady) return "prepare";
  return "blocked";
}
