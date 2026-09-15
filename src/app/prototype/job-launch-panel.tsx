import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { Button } from "./shared";
import type { AgencyApi } from "../data/agency-api";
import type { Job } from "./data";
import {
  LAUNCH_HANDSHAKE_HINT,
  launchAssigneeProviderId,
  launchNeedsReconcile,
  launchReadinessNotice,
  launchStateLabel,
  mustNotRespawn,
  isKnownActiveAttemptState,
  nextLaunchAction,
  jobLaunchAllowedFromReadiness,
  jobLaunchableState,
  type CompletionView,
  type IsolationReadiness,
  type JobLaunchItem,
  type PrepareLaunchView,
} from "../data/launch-rpc";
import { createLiveRunsFetchGate } from "../data/live-runs";
import {
  failureNotice,
  launchRouteId,
  jobLaunchRefreshKey,
  liveJobLaunchReady,
  loadIsolationReadiness,
  loadJobLaunchItems,
  requestCompletion,
  requestLaunchReceipt,
  formatPrepareLaunchOutcome,
  LAUNCH_JOB_STATE_GUARD,
  requestPrepareLaunch,
  requestReconcileLaunch,
} from "../data/persist-launch";
import { PRODUCT_LAUNCH_READY, productInterpretNotice, productLaunchCopy, productPrepareLaunchNotice, productServerReason, technicalLaunchReason, technicalServerReason } from "../data/product-reasons";
import { scopedAttemptThreadId } from "../data/job-work-thread";
import { JobWorkTimeline } from "./job-work-timeline";
import {
  INTERPRET_PUBLICATION_LABEL,
  JOB_CANCELED_LABEL,
  LAST_LAUNCH_UNACCEPTED,
  interpretButtonDisabled,
  jobIsCanceled,
} from "../data/job-lifecycle";
import { attemptStatusEqual, type AttemptStatus } from "../data/job-team";
import { jobEnvironmentEqual, type JobEnvironmentStatus } from "../data/job-environment";

export function JobLaunchPanel({
  job,
  api,
  notice,
  openRun,
  onChanged,
  onAttemptStatus,
  onLaunchReady,
  onEnvironment,
  needsInput = false,
}: {
  job: Job;
  api: AgencyApi;
  notice: (text: string) => void;
  openRun: (id: string) => void;
  onChanged?: () => void;
  onAttemptStatus?: (status: AttemptStatus) => void;
  onLaunchReady?: (ready: boolean) => void;
  onEnvironment?: (status: JobEnvironmentStatus) => void;
  needsInput?: boolean;
}) {
  const [items, setItems] = useState<JobLaunchItem[]>([]);
  const [listMessage, setListMessage] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<IsolationReadiness | null>(null);
  const [prepare, setPrepare] = useState<PrepareLaunchView | null>(null);
  const [completion, setCompletion] = useState<CompletionView | null>(null);
  const [pending, setPending] = useState(false);
  const [lastLaunchOutcome, setLastLaunchOutcome] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const fetchGate = useRef(createLiveRunsFetchGate());
  const jobRef = useRef(job);
  jobRef.current = job;
  const attemptStatusRef = useRef(onAttemptStatus);
  attemptStatusRef.current = onAttemptStatus;
  const lastAttemptStatus = useRef<AttemptStatus | null>(null);
  const launchReadyRef = useRef(onLaunchReady);
  launchReadyRef.current = onLaunchReady;
  const lastLaunchReady = useRef<boolean | null>(null);
  const environmentRef = useRef(onEnvironment);
  environmentRef.current = onEnvironment;
  const lastEnvironment = useRef<JobEnvironmentStatus | null>(null);
  const reportEnvironment = (status: JobEnvironmentStatus) => {
    if (lastEnvironment.current && jobEnvironmentEqual(lastEnvironment.current, status)) return;
    lastEnvironment.current = status;
    environmentRef.current?.(status);
  };
  const reportAttemptStatus = (status: AttemptStatus) => {
    if (lastAttemptStatus.current && attemptStatusEqual(lastAttemptStatus.current, status)) return;
    lastAttemptStatus.current = status;
    attemptStatusRef.current?.(status);
  };
  const reportLaunchReady = (ready: boolean) => {
    if (lastLaunchReady.current === ready) return;
    lastLaunchReady.current = ready;
    launchReadyRef.current?.(ready);
  };
  const refreshKey = jobLaunchRefreshKey(job);

  const latest = items[0] ?? (prepare?.launched?.attempt
    ? { attempt: prepare.launched.attempt, receipt: prepare.launched.receipt }
    : null);

  const ready = liveJobLaunchReady(job);
  const providerId = launchAssigneeProviderId(readiness);
  const handshakeReady = jobLaunchAllowedFromReadiness(readiness);
  const launchId = latest?.receipt?.launchId || latest?.attempt?.launchId;
  const action = nextLaunchAction({
    jobReady: ready.ok,
    handshakeReady,
    lastPrepare: prepare,
    attemptState: latest?.attempt.state,
    launchedKind: prepare?.launched?.kind,
    hasLaunchId: Boolean(launchId),
    jobState: job.sourceState || job.state,
    hasNeedsInput: needsInput,
  });

  const refresh = useCallback(async () => {
    if (!fetchGate.current.isMounted()) return;
    const current = jobRef.current;
    const token = fetchGate.current.begin(jobLaunchRefreshKey(current));
    const probed = await loadIsolationReadiness(api, current.recordId);
    if (!fetchGate.current.accept(token)) return;
    let isolationReady: boolean | null = null;
    if (!probed.ok) {
      setReadiness(null);
      reportLaunchReady(false);
    } else {
      setReadiness(probed.value);
      reportLaunchReady(jobLaunchAllowedFromReadiness(probed.value));
      isolationReady = probed.value.isolationReady;
    }
    if (!current.recordId) {
      setItems([]);
      setListMessage("Нет серверного id — список запусков не запрашиваем.");
      reportAttemptStatus({ kind: "unknown" });
      reportEnvironment({ isolationReady, attempts: null });
      return;
    }
    const listed = await loadJobLaunchItems(api, current.recordId);
    if (!fetchGate.current.accept(token)) return;
    if (!listed.ok) {
      setItems([]);
      setListMessage(listed.failure.kind === "unavailable" ? listed.failure.message : failureNotice(listed.failure));
      reportAttemptStatus({ kind: "unknown" });
      reportEnvironment({ isolationReady, attempts: null });
      return;
    }
    const next = [...listed.value].sort((a, b) => b.attempt.attemptNo - a.attempt.attemptNo);
    const head = next[0];
    if (head?.attempt.launchId) {
      const receipt = await requestLaunchReceipt(api, { launchId: head.attempt.launchId });
      if (!fetchGate.current.accept(token)) return;
      if (receipt.ok) next[0] = { ...head, receipt: receipt.value };
    }
    setItems(next);
    setListMessage(next.length ? null : "По этой задаче серверных попыток нет.");
    reportAttemptStatus(next[0] ? { kind: "state", state: next[0].attempt.state } : { kind: "none" });
    reportEnvironment({ isolationReady, attempts: next.length });
  }, [api]);

  useEffect(() => {
    const gate = fetchGate.current;
    return () => {
      gate.unmount();
    };
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  useRealtime("domain-changed", () => {
    void refresh();
  });

  const reportOutcome = (text: string) => {
    setOutcome(text);
    notice(text);
  };

  const runPrepare = async () => {
    if (pending) return;
    if (action !== "prepare") {
      reportOutcome(ready.ok
        ? "Кнопка запуска закрыта: среда или текущая попытка не разрешают prepare. RPC не вызывался."
        : ready.message);
      return;
    }
    if (latest && mustNotRespawn({ attempt: latest.attempt, launchedKind: prepare?.launched?.kind })) {
      reportOutcome("Повторный запуск заблокирован: нужна сверка или проверка, не новый запуск.");
      return;
    }
    setPending(true);
    try {
      const result = await requestPrepareLaunch(api, job);
      setLastLaunchOutcome(formatPrepareLaunchOutcome(result));
      if (!result.ok) {
        reportOutcome(productServerReason(failureNotice(result.failure)));
        return;
      }
      setPrepare(result.value);
      reportOutcome(productPrepareLaunchNotice(result.value));
      await refresh();
      onChanged?.();
    } catch (error) {
      const thrown = error instanceof Error ? error.message : "prepareLaunch оборвался без ответа сервера.";
      setLastLaunchOutcome(`prepareLaunch fail · thrown · ${thrown}`);
      reportOutcome(productServerReason(thrown));
    } finally {
      setPending(false);
    }
  };

  const runReconcile = async () => {
    if (!latest || !launchId || pending) return;
    setPending(true);
    const result = await requestReconcileLaunch(api, { attemptId: latest.attempt.attemptId, launchId });
    setPending(false);
    if (!result.ok) {
      reportOutcome(failureNotice(result.failure));
      return;
    }
    reportOutcome(result.value.message || result.value.kind);
    await refresh();
    onChanged?.();
  };

  const runInterpret = async () => {
    if (!job.recordId || !launchId || pending) return;
    setPending(true);
    const result = await requestCompletion(api, { jobId: job.recordId, launchId });
    setPending(false);
    if (!result.ok) {
      reportOutcome(failureNotice(result.failure));
      return;
    }
    setCompletion(result.value);
    reportOutcome(productInterpretNotice(result.value));
    onChanged?.();
  };

  const readinessMessage = launchReadinessNotice(readiness, providerId);
  const activeAttempt = Boolean(latest && isKnownActiveAttemptState(latest.attempt.state));
  const jobRunning = job.state === "running" || job.sourceState === "running";
  const envReadinessVisible = jobLaunchableState(job.state) || jobLaunchableState(job.sourceState);
  const hideReadyHint = !envReadinessVisible || activeAttempt || jobRunning;
  const rawReadyMessage = !ready.ok ? ready.message : null;
  const hideStateGuard = rawReadyMessage === LAUNCH_JOB_STATE_GUARD && (!envReadinessVisible || activeAttempt || jobRunning);
  const reason = (envReadinessVisible ? readinessMessage : null)
    ?? (rawReadyMessage && !hideStateGuard
      ? rawReadyMessage
      : prepare && !prepare.handshakeReady
        ? productLaunchCopy({ reasonCode: prepare.reasonCode, reason: prepare.reason })
        : latest && launchNeedsReconcile({
            attempt: latest.attempt,
            receipt: latest.receipt ?? (launchId ? { needsReconciliation: latest.attempt.state === "unknown", launchId } : null),
            launchedKind: prepare?.launched?.kind,
          })
          ? "Состояние неизвестно. Нужна сверка, повторный запуск не вызывается."
          : listMessage);
  const technical = readiness
    ? technicalLaunchReason({ reasonCode: readiness.reasonCode, reason: readiness.reason })
    : prepare && !prepare.handshakeReady
      ? technicalLaunchReason({ reasonCode: prepare.reasonCode, reason: prepare.reason })
      : technicalServerReason(reason);
  const workThreadId = scopedAttemptThreadId(latest);
  const canceled = jobIsCanceled(job);
  const lastLaunchNote = latest && canceled
    ? `${LAST_LAUNCH_UNACCEPTED}: ${launchStateLabel(latest.attempt.state)}`
    : null;
  const technicalBundle = [
    lastLaunchOutcome,
    lastLaunchNote,
    canceled && latest?.receipt?.persistError
      ? `persistError ${latest.receipt.persistError.message}`
      : null,
    latest ? `attemptId ${latest.attempt.attemptId}` : null,
    latest?.receipt?.threadId ? `threadId ${latest.receipt.threadId}` : latest?.attempt.threadId ? `threadId ${latest.attempt.threadId}` : null,
    latest ? `attempt.state ${latest.attempt.state}` : null,
    completion ? `mayEnterReview ${completion.mayEnterReview}` : null,
    completion ? `publishedVerified ${completion.publishedVerified}` : null,
    technical,
  ].filter((row): row is string => Boolean(row));

  const isDone = job.state === "done";
  const content = (
    <>
      {!hideReadyHint && (
        <p className="text-xs text-muted-foreground">{handshakeReady ? PRODUCT_LAUNCH_READY : LAUNCH_HANDSHAKE_HINT}</p>
      )}
      {(canceled || latest) && (
        <dl className="grid gap-1 text-xs text-muted-foreground">
          {canceled && <div data-testid="job-launch-current">{JOB_CANCELED_LABEL}</div>}
          {!canceled && latest?.receipt?.persistError && <div>Ошибка: {productServerReason(latest.receipt.persistError.message)}</div>}
          {!canceled && latest && <div>Состояние: {launchStateLabel(latest.attempt.state)}</div>}
          {!canceled && completion?.runFailed && <div>Сбой: {productServerReason(completion.reason)}</div>}
        </dl>
      )}
      {reason && (
        <p className="text-xs text-muted-foreground">{productServerReason(reason)}</p>
      )}
      {technicalBundle.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Технические подробности</summary>
          <div className="mt-1 space-y-1 break-words font-mono">
            {technicalBundle.map((row) => <p key={row}>{row}</p>)}
          </div>
        </details>
      )}
      {outcome && (
        <p role="status" data-testid="launch-outcome" className="text-sm">
          {outcome}
        </p>
      )}
      <JobWorkTimeline threadId={workThreadId} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={pending || action !== "prepare"} onClick={() => void runPrepare()}>
          {pending && action === "prepare" ? "Запускаем…" : "Запустить"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || action !== "reconcile"}
          onClick={() => void runReconcile()}
        >
          Сверить
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={interpretButtonDisabled({
            pending,
            launchId,
            jobState: job.state,
            sourceState: job.sourceState,
            attemptState: latest?.attempt.state,
            needsInput,
          })}
          onClick={() => void runInterpret()}
        >
          {INTERPRET_PUBLICATION_LABEL}
        </Button>
        {latest && <Button size="sm" variant="ghost" onClick={() => openRun(launchRouteId(latest))}>К запуску</Button>}
      </div>
      {items.length > 0 && (
        <div className="space-y-2 border-t border-border pt-3">
          {items.map((item) => {
            const id = launchRouteId(item);
            return (
              <div key={item.attempt.attemptId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>{canceled ? `${LAST_LAUNCH_UNACCEPTED} · ` : ""}{launchStateLabel(item.attempt.state)} · попытка {item.attempt.attemptNo}</span>
                <Button size="sm" variant="outline" onClick={() => openRun(id)}>Открыть</Button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  if (isDone) {
    return (
      <details className="mt-3 border-t border-border/60 pt-2 text-xs text-muted-foreground" data-testid="job-launch-done-details">
        <summary className="cursor-pointer font-medium hover:text-foreground">
          {`История запусков и сверка ${latest ? `(попытка ${latest.attempt.attemptNo}, ${launchStateLabel(latest.attempt.state).toLowerCase()})` : ""}`}
        </summary>
        <div className="mt-3 space-y-3">
          {content}
        </div>
      </details>
    );
  }

  return (
    <div className="mt-4 space-y-3">
      {content}
    </div>
  );
}
