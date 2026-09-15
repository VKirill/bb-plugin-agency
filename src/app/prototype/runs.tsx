import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../shared/rpc-contract";
import { AgentMark, Button, Collection, Empty, PageHead, Rows } from "./shared";
import { resolveRunRoute, seedRuns, type DemoRun } from "./run-links";
import { createRpcAgencyApi, type RpcCaller } from "../data";
import type { Job } from "./data";
import { launchStateLabel, type CompletionView } from "../data/launch-rpc";
import { interpretButtonDisabled } from "../data/job-lifecycle";
import { productServerReason } from "../data/product-reasons";
import {
  LIVE_RUNS_COPY,
  LIVE_RUNS_POLL_MS,
  liveRunsJobsKey,
  liveRunsListCopy,
  liveRunsPageDescription,
  createLiveRunsFetchGate,
  nextLiveRunsCatalog,
  type LiveLaunchOpen,
  type LiveLaunchView,
  type LiveRunsCatalog,
} from "../data/live-runs";
import {
  launchRouteId,
  loadScopedLaunches,
  openLiveLaunch,
  requestCompletion,
  requestReconcileLaunch,
  resolveLiveLaunchRoute,
} from "../data/persist-launch";
import { STAGE1_UNAVAILABLE } from "../data";
import "./job-detail.css";

export function RunsPage({
  runId, open, back, openJob, runs, demoMode = false, jobs = [],
}: {
  runId?: string;
  open: (id: string) => void;
  back: () => void;
  notice: (s: string) => void;
  openJob: (jobId: string) => void;
  runs?: readonly DemoRun[];
  demoMode?: boolean;
  jobs?: Job[];
}) {
  const rpc = useRpc<typeof rpcContract>();
  const api = useMemo(() => createRpcAgencyApi(rpc as unknown as RpcCaller), [rpc]);
  const [catalog, setCatalog] = useState<LiveRunsCatalog>({ status: "loading", items: [] });
  const jobsKey = liveRunsJobsKey(jobs);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const fetchGate = useRef(createLiveRunsFetchGate());

  const refresh = useCallback(async () => {
    if (demoMode || !fetchGate.current.isMounted()) return;
    const token = fetchGate.current.begin(jobsKey);
    const load = await loadScopedLaunches(api, jobsRef.current);
    if (!fetchGate.current.accept(token)) return;
    setCatalog((current) => nextLiveRunsCatalog(current, load));
  }, [api, demoMode, jobsKey]);

  useEffect(() => {
    const gate = fetchGate.current;
    return () => {
      gate.unmount();
    };
  }, []);

  useEffect(() => {
    if (!demoMode) void refresh();
  }, [demoMode, refresh]);

  useEffect(() => {
    if (demoMode) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, LIVE_RUNS_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [demoMode, refresh]);

  useRealtime("domain-changed", () => {
    if (!demoMode) void refresh();
  });

  if (demoMode) {
    const demoCatalog = runs ?? seedRuns;
    const route = resolveRunRoute(runId, demoCatalog);
    if (route.kind === "list") {
      return <div className="space-y-4">
        <PageHead title="Запуски" description="Демонстрационные попытки. Реальный runtime закрыт."/>
        {demoCatalog.length
          ? <Collection columns={["Запуск", "Результат", "Задача", "Проект / отдел"]} rows={demoCatalog.map((run) => ({
            id: run.id, open: () => open(run.id),
            name: <span className="flex items-center gap-3"><AgentMark id={run.providerId}/><span><span className="block font-medium">{run.title}</span><span className="text-xs text-muted-foreground">{run.id} · {run.agent}</span></span></span>,
            cells: [run.result, run.jobId, `${run.project} · ${run.department}`],
          }))}/>
          : <Empty title="Запусков нет" description={STAGE1_UNAVAILABLE.autonomy}/>}
      </div>;
    }
    if (route.kind === "missing") {
      return <div className="space-y-4"><Empty title="Запуск не найден" description="Этот запуск недоступен. Откройте запуск из своей задачи или вернитесь к списку."/><Button variant="outline" size="sm" onClick={back}>Назад к запускам</Button></div>;
    }
    return <RunDetail run={route.run} back={back} openJob={openJob}/>;
  }

  if (!runId) {
    const copy = liveRunsListCopy(catalog.status);
    const list = catalog.status === "ready" ? catalog.items : catalog.status === "error" ? catalog.items : [];
    return <div className="space-y-4">
      <PageHead title="Запуски" description={liveRunsPageDescription(catalog.status, list.length > 0)}/>
      {list.length
        ? <Collection columns={["Попытка", "Состояние", "Задача", "Thread"]} rows={list.map((row) => ({
          id: launchRouteId(row),
          open: () => open(launchRouteId(row)),
          name: <span className="block font-medium">{row.attempt.attemptId}</span>,
          cells: [launchStateLabel(row.attempt.state), row.jobKey, row.receipt?.threadId || row.attempt.threadId || "—"],
        }))}/>
        : <Empty title={copy.title} description={copy.description}/>}
    </div>;
  }

  const routed = resolveLiveLaunchRoute(runId, catalog.items);
  if (routed.kind === "detail") {
    return <LiveRunDetail view={{ kind: "attempt", row: routed.row }} back={back} openJob={openJob} onMutated={() => void refresh()}/>;
  }

  return <LiveRunLookup runId={runId} jobs={jobs} back={back} openJob={openJob} onMutated={() => void refresh()}/>;
}

function LiveRunLookup({
  runId, jobs, back, openJob, onMutated,
}: {
  runId: string;
  jobs: Job[];
  back: () => void;
  openJob: (jobId: string) => void;
  onMutated: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const api = useMemo(() => createRpcAgencyApi(rpc as unknown as RpcCaller), [rpc]);
  const [opened, setOpened] = useState<LiveLaunchOpen>({ status: "loading" });

  const jobsKey = liveRunsJobsKey(jobs);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  useEffect(() => {
    let active = true;
    setOpened({ status: "loading" });
    void openLiveLaunch(api, runId, jobsRef.current).then((result) => {
      if (active) setOpened(result);
    });
    return () => {
      active = false;
    };
  }, [api, jobsKey, jobsRef, runId]);

  if (opened.status === "loading") {
    return <Empty title={LIVE_RUNS_COPY.openLoading.title} description={LIVE_RUNS_COPY.openLoading.description}/>;
  }
  if (opened.status !== "ok") {
    const copy = opened.status === "missing"
      ? LIVE_RUNS_COPY.openMissing
      : opened.status === "unavailable"
        ? LIVE_RUNS_COPY.openUnavailable
        : LIVE_RUNS_COPY.openError;
    return <div className="space-y-4"><Empty title={copy.title} description={copy.description}/><Button variant="outline" size="sm" onClick={back}>Назад к запускам</Button></div>;
  }
  return <LiveRunDetail view={opened.view} back={back} openJob={openJob} onMutated={onMutated}/>;
}

function LiveRunDetail({
  view, back, openJob, onMutated,
}: {
  view: LiveLaunchView;
  back: () => void;
  openJob: (jobId: string) => void;
  onMutated: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const api = useMemo(() => createRpcAgencyApi(rpc as unknown as RpcCaller), [rpc]);
  const [completion, setCompletion] = useState<CompletionView | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const receipt = view.kind === "attempt" ? view.row.receipt : view.receipt;
  const jobKey = view.kind === "attempt" ? view.row.jobKey : view.jobKey;
  const jobRecordId = view.kind === "attempt" ? view.row.jobRecordId : view.receipt.jobId;
  const attemptId = view.kind === "attempt" ? view.row.attempt.attemptId : view.receipt.attemptId;

  const interpret = async () => {
    if (!receipt?.launchId || pending) return;
    setPending(true);
    const result = await requestCompletion(api, { jobId: jobRecordId, launchId: receipt.launchId });
    setPending(false);
    if (!result.ok) {
      setMessage(LIVE_RUNS_COPY.openError.description);
      return;
    }
    setCompletion(result.value);
    setMessage(productServerReason(result.value.reason));
    onMutated();
  };

  const reconcile = async () => {
    if (!receipt || pending) return;
    setPending(true);
    const result = await requestReconcileLaunch(api, { attemptId: receipt.attemptId, launchId: receipt.launchId });
    setPending(false);
    setMessage(result.ok ? (result.value.message || "Сверка выполнена.") : LIVE_RUNS_COPY.openError.description);
    onMutated();
  };

  const title = view.kind === "attempt" ? launchStateLabel(view.row.attempt.state) : LIVE_RUNS_COPY.receiptTitle;
  const description = view.kind === "attempt"
    ? LIVE_RUNS_COPY.ready.description
    : LIVE_RUNS_COPY.receiptDescription;

  return <article className="agency-task-layout mx-auto w-full max-w-7xl px-1 pb-8 sm:px-4">
    <nav className="mb-4 flex items-center gap-2 text-xs text-muted-foreground" aria-label="Путь запуска">
      <Button variant="ghost" size="sm" onClick={back}>← Запуски</Button><span>/ {attemptId}</span>
    </nav>
    <div className="agency-task-grid">
      <header className="agency-task-title">
        <PageHead title={title} description={description}>
          <Button variant="outline" onClick={() => openJob(jobKey)}>К задаче {jobKey}</Button>
        </PageHead>
      </header>
      <div className="agency-task-content space-y-5">
        <section className="rounded-lg border border-border bg-muted/25 p-4 text-sm space-y-2">
          {view.kind === "attempt" && (
            <>
              <p>Попытка {view.row.attempt.attemptNo}</p>
              <p>Состояние: {launchStateLabel(view.row.attempt.state)}</p>
              <p>Ревизия попытки: {view.row.attempt.revision}</p>
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Технические подробности</summary>
                <p className="mt-1 font-mono">attempt.state {view.row.attempt.state}</p>
              </details>
            </>
          )}
          {view.kind === "receipt" && <p>Попытка в списке не найдена. Ниже только квитанция.</p>}
          {receipt?.threadId && <p>Thread: {receipt.threadId}</p>}
          {receipt?.persistError && <p>Ошибка: {productServerReason(receipt.persistError.message)}</p>}
          {receipt?.needsReconciliation && <p>Нужна сверка, повторный запуск не вызывается.</p>}
          {completion && (
            <>
              <p>{productServerReason(completion.reason)}</p>
              <p>Проверка: {completion.mayEnterReview ? "можно передать на проверку" : "проверка не подтверждена"}</p>
              {completion.runFailed && <p>Сбой зафиксирован</p>}
              {completion.threadStatus && <p>Статус thread: {completion.threadStatus}</p>}
              <p>Успех по thread не ставится.</p>
            </>
          )}
          {message && <p className="text-muted-foreground">{message}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={pending || !receipt} onClick={() => void reconcile()}>Сверить</Button>
            <Button size="sm" variant="outline" disabled={interpretButtonDisabled({ pending, launchId: receipt?.launchId, attemptState: view.kind === "attempt" ? view.row.attempt.state : null })} onClick={() => void interpret()}>Проверить результат</Button>
          </div>
        </section>
      </div>
      <aside className="agency-task-sidebar rounded-lg border border-border bg-muted/20 p-4">
        <Rows rows={[
          ["Задача", jobKey],
          ["Квитанция", receipt?.launchId || "—"],
          ["Связка", receipt?.jobBindState || "—"],
        ]}/>
      </aside>
    </div>
  </article>;
}

function RunDetail({ run, back, openJob }: { run: DemoRun; back: () => void; openJob: (jobId: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  return <article className="agency-task-layout mx-auto w-full max-w-7xl px-1 pb-8 sm:px-4">
    <nav className="mb-4 flex items-center gap-2 text-xs text-muted-foreground" aria-label="Путь запуска">
      <Button variant="ghost" size="sm" onClick={back}>← Запуски</Button><span>/ {run.id}</span>
    </nav>
    <div className="agency-task-grid">
      <header className="agency-task-title">
        <PageHead title={run.title} description={run.summary}>
          <Button variant="outline" onClick={() => openJob(run.jobId)}>К задаче {run.jobId}</Button>
        </PageHead>
        <p className="text-xs text-muted-foreground">{run.id} · {run.duration}</p>
      </header>
      <div className="agency-task-content space-y-5">
        <section className="rounded-lg border border-border bg-muted/25 p-4">
          <h2 className="mb-2 text-sm font-semibold">Результат работы</h2>
          <Markdown content={run.summary}/>
        </section>
      </div>
      <aside className="agency-task-sidebar rounded-lg border border-border bg-muted/20 p-4" data-expanded={expanded}>
        <h2 className="agency-task-sidebar-heading text-sm font-semibold">Сведения о запуске</h2>
        <Button variant="ghost" className="agency-task-sidebar-toggle w-full justify-between" onClick={() => setExpanded(!expanded)}>Сведения о запуске <span>{expanded ? "−" : "+"}</span></Button>
        <div className="agency-task-sidebar-content">
          <Rows rows={[["Задача", run.jobId], ["Проект", run.project], ["Отдел", run.department], ["Сотрудник", run.agent]]}/>
        </div>
      </aside>
    </div>
  </article>;
}
