import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { Button, InfoHint, TextField } from "./shared";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import type { AgencyApi } from "../data/agency-api";
import type { Job } from "./data";
import {
  LAUNCH_READINESS_HINT,
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
import { tr } from "../i18n";

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
  // null until the first probe answers; a failed probe keeps its own message.
  const [readinessProbe, setReadinessProbe] = useState<{ failed: string | null } | null>(null);
  const [prepare, setPrepare] = useState<PrepareLaunchView | null>(null);
  const [completion, setCompletion] = useState<CompletionView | null>(null);
  const [pending, setPending] = useState(false);
  const [lastLaunchOutcome, setLastLaunchOutcome] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopReason, setStopReason] = useState("");
  const [stopPending, setStopPending] = useState(false);
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
  const launchReady = jobLaunchAllowedFromReadiness(readiness);
  const launchId = latest?.receipt?.launchId || latest?.attempt?.launchId;
  const action = nextLaunchAction({
    jobReady: ready.ok,
    launchReady,
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
      setReadinessProbe({ failed: failureNotice(probed.failure) });
      reportLaunchReady(false);
    } else {
      setReadiness(probed.value);
      setReadinessProbe({ failed: null });
      reportLaunchReady(jobLaunchAllowedFromReadiness(probed.value));
      isolationReady = probed.value.isolationReady;
    }
    if (!current.recordId) {
      setItems([]);
      setListMessage(tr("Нет серверного id — список запусков не запрашиваем."));
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
    setListMessage(next.length ? null : tr("Запусков по этой задаче ещё не было."));
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
        ? tr("Запуск сейчас недоступен: задача не в бэклоге или очереди, либо у неё уже есть активный запуск.")
        : ready.message);
      return;
    }
    if (latest && mustNotRespawn({ attempt: latest.attempt, launchedKind: prepare?.launched?.kind })) {
      reportOutcome(tr("Повторный запуск заблокирован: нужна сверка или проверка, не новый запуск."));
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
      const thrown = error instanceof Error ? error.message : tr("prepareLaunch оборвался без ответа сервера.");
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

  const readinessMessage = !readinessProbe
    ? tr("Проверяем готовность запуска…")
    : readinessProbe.failed
      ? tr("Готовность запуска не проверена: {reason}", { reason: readinessProbe.failed })
      : launchReadinessNotice(readiness, providerId);
  const activeAttempt = Boolean(latest && isKnownActiveAttemptState(latest.attempt.state));
  const jobRunning = job.state === "running" || job.sourceState === "running";
  const envReadinessVisible = jobLaunchableState(job.state) || jobLaunchableState(job.sourceState);
  const hideReadyHint = !envReadinessVisible || activeAttempt || jobRunning;
  const rawReadyMessage = !ready.ok ? ready.message : null;
  const hideStateGuard = rawReadyMessage === LAUNCH_JOB_STATE_GUARD && (!envReadinessVisible || activeAttempt || jobRunning);
  const reason = (envReadinessVisible ? readinessMessage : null)
    ?? (rawReadyMessage && !hideStateGuard
      ? rawReadyMessage
      : prepare && !prepare.launched
        ? productLaunchCopy({ reasonCode: prepare.reasonCode, reason: prepare.reason })
        : latest && launchNeedsReconcile({
            attempt: latest.attempt,
            receipt: latest.receipt ?? (launchId ? { needsReconciliation: latest.attempt.state === "unknown", launchId } : null),
            launchedKind: prepare?.launched?.kind,
          })
          ? tr("Состояние неизвестно. Нужна сверка, повторный запуск не вызывается.")
          : listMessage);
  const technical = readiness
    ? technicalLaunchReason({ reasonCode: readiness.reasonCode, reason: readiness.reason })
    : prepare && !prepare.launched
      ? technicalLaunchReason({ reasonCode: prepare.reasonCode, reason: prepare.reason })
      : technicalServerReason(reason);
  const workThreadId = scopedAttemptThreadId(latest);
  const canceled = jobIsCanceled(job);
  const lastLaunchNote = latest && canceled
    ? `${tr(LAST_LAUNCH_UNACCEPTED)}: ${tr(launchStateLabel(latest.attempt.state))}`
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

  const stopThreadId = latest?.receipt?.threadId || latest?.attempt.threadId || null;
  const stoppable = Boolean(
    latest && launchId && stopThreadId && job.revision && ["launching", "running", "waiting_input", "unknown"].includes(latest.attempt.state),
  );
  const runStop = async () => {
    if (!latest || !launchId || !stopThreadId || !job.recordId || !job.revision || stopPending) return;
    setStopPending(true);
    const result = await api.cancelLaunch({
      requestId: crypto.randomUUID(),
      jobId: job.recordId,
      attemptId: latest.attempt.attemptId,
      expectedJobRevision: job.revision,
      expectedAttemptRevision: latest.attempt.revision,
      launchId,
      threadId: stopThreadId,
      reason: stopReason.trim(),
    });
    setStopPending(false);
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    setStopping(false);
    setStopReason("");
    notice(tr("Запуск остановлен. Задача в «Ожидает решения»: верните её в очередь, когда будете готовы запустить снова."));
    onChanged?.();
    void refresh();
  };

  const [queuePending, setQueuePending] = useState(false);
  const runQueue = async (enqueue: boolean) => {
    if (!job.recordId || !job.revision || queuePending) return;
    setQueuePending(true);
    const result = enqueue
      ? await api.enqueueLaunch({ requestId: crypto.randomUUID(), jobId: job.recordId, expectedRevision: job.revision })
      : await api.dequeueLaunch({ jobId: job.recordId });
    setQueuePending(false);
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    notice(enqueue ? tr("Задача в очереди запуска: стартует сама, когда освободится слот.") : tr("Задача убрана из очереди запуска."));
    onChanged?.();
    void refresh();
  };

  // Once the result is handed in, launch controls are history: the decision block leads.
  const isDone = job.state === "done" || job.state === "review" || job.state === "canceled";
  const content = (
    <>
      {!hideReadyHint && readinessProbe && (
        <p className="text-xs text-muted-foreground">{tr(launchReady ? PRODUCT_LAUNCH_READY : LAUNCH_READINESS_HINT)}</p>
      )}
      {(canceled || latest) && (
        <dl className="grid gap-1 text-xs text-muted-foreground">
          {canceled && <div data-testid="job-launch-current">{tr(JOB_CANCELED_LABEL)}</div>}
          {!canceled && latest?.receipt?.persistError && <div>{tr("Ошибка: {reason}", { reason: productServerReason(latest.receipt.persistError.message) })}</div>}
          {!canceled && latest && <div>{tr("Состояние: {state}", { state: tr(launchStateLabel(latest.attempt.state)) })}</div>}
          {!canceled && latest?.attempt.outsideSandboxCommands && (
            <div data-testid="outside-sandbox" className="text-amber-700 dark:text-amber-400">
              {tr("Сотрудник выполнил вне песочницы команд: {count}. Проверьте, что он не выходил за папку задачи.", { count: latest.attempt.outsideSandboxCommands })}
            </div>
          )}
          {!canceled && completion?.runFailed && <div>{tr("Сбой: {reason}", { reason: productServerReason(completion.reason) })}</div>}
        </dl>
      )}
      {reason && (
        <p className="text-xs text-muted-foreground">{productServerReason(reason)}</p>
      )}
      {envReadinessVisible && !activeAttempt && readiness?.warnings?.map((warning) => (
        <p key={warning} className="text-xs text-amber-700 dark:text-amber-400">{warning}</p>
      ))}
      {technicalBundle.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">{tr("Технические подробности")}</summary>
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
      {job.launchQueue && !activeAttempt && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs" data-testid="launch-queue-state">
          <p className="font-medium">{tr("В очереди запуска · позиция {position}", { position: job.launchQueue.position })}</p>
          <p className="mt-0.5 text-muted-foreground">{job.launchQueue.waitingReason ? tr("Ждёт: {reason}", { reason: productServerReason(job.launchQueue.waitingReason) }) : tr("Стартует, как только позволят лимиты. Проверка каждые 15 секунд.")}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={pending || action !== "prepare"} onClick={() => void runPrepare()}>
          {pending && action === "prepare" ? tr("Запускаем…") : tr("Запустить")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || action !== "reconcile"}
          onClick={() => void runReconcile()}
        >
          {tr("Сверить")}
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
          {tr(INTERPRET_PUBLICATION_LABEL)}
        </Button>
        {latest && <Button size="sm" variant="ghost" onClick={() => openRun(launchRouteId(latest))}>{tr("Открыть запуск")}</Button>}
        {stoppable && <Button size="sm" variant="outline" onClick={() => setStopping(true)}>{tr("Остановить запуск")}</Button>}
        {!job.launchQueue && envReadinessVisible && !activeAttempt && readiness?.waitable && (
          <Button size="sm" variant="outline" disabled={queuePending} onClick={() => void runQueue(true)}>{queuePending ? tr("Ставим…") : tr("В очередь запуска")}</Button>
        )}
        {job.launchQueue && !activeAttempt && (
          <Button size="sm" variant="ghost" disabled={queuePending} onClick={() => void runQueue(false)}>{tr("Убрать из очереди")}</Button>
        )}
        <InfoHint title="Кнопки запуска">
          <p><b>{tr("Запустить")}</b> — {tr("создаёт попытку: сотрудник получает поручение в отдельном треде на машине проекта.")}</p>
          <p><b>{tr("Сверить")}</b> — {tr("перечитывает состояние треда, если попытка зависла в «неизвестно». Новый запуск не создаёт.")}</p>
          <p><b>{tr("Сверить публикацию")}</b> — {tr("проверяет, опубликована ли версия результата, и переводит задачу на проверку, если тред закончил работу. Обычно это происходит само.")}</p>
          <p><b>{tr("В очередь запуска")}</b> — {tr("когда упёрлись в лимит одновременных запусков или бюджет: задача стартует сама, как только лимит позволит. Срочные идут первыми.")}</p>
          <p><b>{tr("Остановить запуск")}</b> — {tr("останавливает тред сотрудника. Задача перейдёт в «Ожидает решения», её можно вернуть в очередь и запустить снова.")}</p>
        </InfoHint>
      </div>
      <Dialog open={stopping} onOpenChange={(open) => { if (!stopPending) setStopping(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tr("Остановить запуск")}</DialogTitle>
            <DialogDescription>{tr("Тред сотрудника будет остановлен, задача перейдёт в «Ожидает решения». Уже опубликованные версии останутся.")}</DialogDescription>
          </DialogHeader>
          <TextField label="Причина" value={stopReason} onChange={setStopReason} multiline rows={3} placeholder="Например: неверный бриф, перезапущу с уточнением." required maxLength={500} />
          <DialogFooter>
            <Button variant="outline" disabled={stopPending} onClick={() => setStopping(false)}>{tr("Отмена")}</Button>
            <Button disabled={!stopReason.trim() || stopPending} onClick={() => void runStop()}>{stopPending ? tr("Останавливаем…") : tr("Остановить")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {items.length > 0 && (
        <div className="space-y-2 border-t border-border pt-3">
          {items.map((item) => {
            const id = launchRouteId(item);
            return (
              <div key={item.attempt.attemptId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>{canceled ? `${tr(LAST_LAUNCH_UNACCEPTED)} · ` : ""}{tr("{state} · попытка {number}", { state: tr(launchStateLabel(item.attempt.state)), number: item.attempt.attemptNo })}</span>
                <Button size="sm" variant="outline" onClick={() => openRun(id)}>{tr("Открыть")}</Button>
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
          {latest ? tr("Запуски и сверка · попытка {number}, {state}", { number: latest.attempt.attemptNo, state: tr(launchStateLabel(latest.attempt.state)).toLowerCase() }) : tr("Запуски и сверка")}
          {latest?.attempt.outsideSandboxCommands ? <span className="text-amber-700 dark:text-amber-400">{` · ${tr("вне песочницы: {count}", { count: latest.attempt.outsideSandboxCommands })}`}</span> : null}
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
