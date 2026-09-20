import { tr } from "../i18n";
import type { AgencyApi } from "./agency-api";
import type { MutationOutcome } from "./envelope";
import { failureNotice, newRequestId } from "./persist";
import type { CompletionView, IsolationReadiness, JobLaunchItem, LaunchCoordinatorView, LaunchReceiptView, PrepareLaunchView } from "./launch-rpc";
import { jobCanRequestLaunch } from "./launch-rpc";
import {
  liveLaunchFromReceipt,
  looksLikeLaunchId,
  type LiveLaunchOpen,
  type ScopedLaunchLoad,
  type ScopedLaunchRow,
} from "./live-runs";

export type { ScopedLaunchLoad, ScopedLaunchRow };

export { failureNotice };

export const LAUNCH_JOB_STATE_GUARD =
  "Запуск доступен из бэклога или очереди, не из текущего статуса.";

/** Last click stays visible after refresh replaces the empty-attempt list copy. */
export function formatPrepareLaunchOutcome(result: MutationOutcome<PrepareLaunchView>): string {
  if (!result.ok) {
    const failure = result.failure;
    if (failure.kind === "domain") {
      return `prepareLaunch fail · domain · ${failure.error.code} · ${failureNotice(failure)}`;
    }
    if (failure.kind === "revision_conflict") {
      return `prepareLaunch fail · revision_conflict · ${failureNotice(failure)}`;
    }
    return `prepareLaunch fail · ${failure.kind} · ${failureNotice(failure)}`;
  }
  const value = result.value;
  return `prepareLaunch ok · attempt=${value.attemptId} · snapshot=${value.snapshotId} · ${value.reasonCode ? `${value.reasonCode} · ` : ""}${value.reason}`;
}

/** Readiness must refetch when assignee or revision persists, not only jobId. */
export function jobLaunchRefreshKey(job: {
  recordId?: string;
  id?: string;
  revision?: number;
  assignedAgentId?: string | null;
}): string {
  return `${job.recordId || job.id || ""}:${job.revision ?? ""}:${job.assignedAgentId ?? ""}`;
}

export function liveJobLaunchReady(job: {
  recordId?: string;
  revision?: number;
  state: string;
  sourceState?: string;
  bindingId?: string;
  assignedAgentId?: string | null;
}): { ok: true; jobId: string; expectedRevision: number } | { ok: false; message: string } {
  if (!jobCanRequestLaunch(job)) {
    return {
      ok: false,
      message: !job.recordId
        ? "Нет серверного id задачи — запуск не вызываем."
        : !job.bindingId
          ? "Сначала сохраните проект."
          : !job.assignedAgentId
            ? "Сначала назначьте исполнителя."
            : LAUNCH_JOB_STATE_GUARD,
    };
  }
  if (typeof job.revision !== "number" || job.revision < 1) {
    return { ok: false, message: tr("Нет положительной ревизии задачи — prepareLaunch не вызываем.") };
  }
  return { ok: true, jobId: job.recordId!, expectedRevision: job.revision };
}

export async function requestPrepareLaunch(
  api: AgencyApi,
  job: { recordId?: string; revision?: number; state: string; sourceState?: string; bindingId?: string; assignedAgentId?: string | null },
): Promise<MutationOutcome<PrepareLaunchView>> {
  const ready = liveJobLaunchReady(job);
  if (!ready.ok) return { ok: false, failure: { kind: "domain", error: { code: "launch_not_ready", message: ready.message } } };
  return api.prepareLaunch({
    requestId: newRequestId(),
    jobId: ready.jobId,
    expectedRevision: ready.expectedRevision,
  });
}

export async function requestReconcileLaunch(
  api: AgencyApi,
  input: { attemptId: string; launchId: string },
): Promise<MutationOutcome<LaunchCoordinatorView>> {
  return api.reconcileLaunch({
    requestId: newRequestId(),
    attemptId: input.attemptId,
    launchId: input.launchId,
  });
}

export async function requestLaunchReceipt(
  api: AgencyApi,
  input: { launchId?: string; attemptId?: string },
): Promise<MutationOutcome<LaunchReceiptView>> {
  return api.getLaunch(input);
}

export async function requestCompletion(
  api: AgencyApi,
  input: { jobId: string; launchId?: string },
): Promise<MutationOutcome<CompletionView>> {
  return api.interpretWorkerCompletion(input);
}

export async function loadJobLaunchItems(
  api: AgencyApi,
  jobId: string,
): Promise<MutationOutcome<JobLaunchItem[]>> {
  return api.listJobAttempts({ jobId });
}

export async function loadIsolationReadiness(
  api: AgencyApi,
  jobId?: string,
): Promise<MutationOutcome<IsolationReadiness>> {
  return api.getIsolationReadiness(jobId ? { jobId } : {});
}

export async function loadScopedLaunches(
  api: AgencyApi,
  jobs: Array<{ id: string; recordId?: string }>,
): Promise<ScopedLaunchLoad> {
  const items: ScopedLaunchRow[] = [];
  for (const job of jobs) {
    if (!job.recordId) continue;
    const listed = await api.listJobAttempts({ jobId: job.recordId });
    if (!listed.ok) {
      return listed.failure.kind === "unavailable" ? { kind: "unavailable" } : { kind: "error" };
    }
    for (const item of listed.value) {
      items.push({ ...item, jobKey: job.id, jobRecordId: job.recordId });
    }
  }
  return { kind: "ok", items };
}

export async function openLiveLaunch(
  api: AgencyApi,
  runId: string,
  jobs: Array<{ id: string; recordId?: string }>,
): Promise<LiveLaunchOpen> {
  const query = looksLikeLaunchId(runId) ? { launchId: runId } : { attemptId: runId };
  const receipt = await api.getLaunch(query);
  if (!receipt.ok) {
    if (receipt.failure.kind === "unavailable") return { status: "unavailable" };
    if (receipt.failure.kind === "domain" && receipt.failure.error.code === "not_found") return { status: "missing" };
    return { status: "error" };
  }
  const job = jobs.find((item) => item.recordId === receipt.value.jobId);
  const listed = await api.listJobAttempts({ jobId: receipt.value.jobId });
  if (!listed.ok) {
    if (listed.failure.kind === "unavailable") return { status: "unavailable" };
    return {
      status: "ok",
      view: liveLaunchFromReceipt(receipt.value, [], job?.id || receipt.value.jobId),
    };
  }
  return {
    status: "ok",
    view: liveLaunchFromReceipt(receipt.value, listed.value, job?.id || receipt.value.jobId),
  };
}

export function launchRouteId(item: JobLaunchItem): string {
  return item.receipt?.launchId || item.attempt.attemptId;
}

export function resolveLiveLaunchRoute(
  runId: string | undefined,
  rows: readonly ScopedLaunchRow[],
): { kind: "list" } | { kind: "detail"; row: ScopedLaunchRow } | { kind: "missing" } {
  if (!runId) return { kind: "list" };
  const row = rows.find((item) => item.receipt?.launchId === runId || item.attempt.attemptId === runId);
  return row ? { kind: "detail", row } : { kind: "missing" };
}
