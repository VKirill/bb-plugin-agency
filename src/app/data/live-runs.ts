import type { JobLaunchItem, LaunchReceiptView } from "./launch-rpc";

export type ScopedLaunchRow = JobLaunchItem & { jobKey: string; jobRecordId: string };

export type ScopedLaunchLoad =
  | { kind: "ok"; items: ScopedLaunchRow[] }
  | { kind: "unavailable" }
  | { kind: "error" };

export const LIVE_RUNS_POLL_MS = 8000;

export type LiveRunsStatus = "loading" | "ready" | "empty" | "unavailable" | "error";

export type LiveRunsCatalog = {
  status: LiveRunsStatus;
  items: ScopedLaunchRow[];
};

export type LiveLaunchView =
  | { kind: "attempt"; row: ScopedLaunchRow }
  | { kind: "receipt"; receipt: LaunchReceiptView; jobKey: string };

export type LiveLaunchOpen =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error" }
  | { status: "unavailable" }
  | { status: "ok"; view: LiveLaunchView };

export const LIVE_RUNS_COPY = {
  loading: { title: "Загружаем запуски", description: "Собираем попытки по текущим задачам." },
  ready: { title: "Запуски", description: "Попытки по текущим задачам. Успех по статусу thread не ставится." },
  empty: { title: "Запусков нет", description: "По выбранным задачам ещё нет попыток." },
  unavailable: { title: "Запуски недоступны", description: "Список попыток сейчас нельзя получить. Записи не показываем." },
  error: { title: "Не удалось загрузить запуски", description: "Это ошибка загрузки, а не пустой список." },
  openLoading: { title: "Загружаем запуск", description: "Читаем квитанцию и попытку." },
  openMissing: { title: "Запуск не найден", description: "Откройте запуск из задачи или вернитесь к списку." },
  openError: { title: "Не удалось открыть запуск", description: "Повторите открытие или вернитесь к списку." },
  openUnavailable: { title: "Запуск недоступен", description: "Карточка запуска сейчас не читается." },
  receiptTitle: "Квитанция запуска",
  receiptDescription: "Это квитанция, не попытка. Номер и ревизия попытки здесь не подставляются.",
} as const;

export function liveRunsListCopy(status: LiveRunsStatus): { title: string; description: string } {
  return LIVE_RUNS_COPY[status];
}

export function liveRunsPageDescription(status: LiveRunsStatus, hasRows: boolean): string {
  if (status === "error" || status === "unavailable") return liveRunsListCopy(status).description;
  if (hasRows) return LIVE_RUNS_COPY.ready.description;
  return liveRunsListCopy(status).description;
}

export function liveRunsJobsKey(jobs: Array<{ id: string; recordId?: string }>): string {
  return jobs.map((job) => `${job.recordId || ""}:${job.id}`).join("|");
}

export function nextLiveRunsCatalog(current: LiveRunsCatalog, load: ScopedLaunchLoad): LiveRunsCatalog {
  if (load.kind === "unavailable") return { status: "unavailable", items: [] };
  if (load.kind === "error") return { status: "error", items: current.items };
  if (load.items.length) return { status: "ready", items: load.items };
  return { status: "empty", items: [] };
}

export type LiveRunsFetchToken = {
  generation: number;
  jobsKey: string;
};

export function createLiveRunsFetchGate() {
  let generation = 0;
  let mounted = true;
  return {
    begin(jobsKey: string): LiveRunsFetchToken {
      generation += 1;
      return { generation, jobsKey };
    },
    accept(token: LiveRunsFetchToken): boolean {
      return mounted && token.generation === generation;
    },
    unmount() {
      mounted = false;
    },
    isMounted() {
      return mounted;
    },
  };
}

export function looksLikeLaunchId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function liveLaunchFromReceipt(
  receipt: LaunchReceiptView,
  attempts: readonly JobLaunchItem[],
  jobKey: string,
): LiveLaunchView {
  const match = attempts.find((item) => item.attempt.attemptId === receipt.attemptId);
  if (!match) return { kind: "receipt", receipt, jobKey };
  return {
    kind: "attempt",
    row: {
      ...match,
      receipt,
      jobKey,
      jobRecordId: receipt.jobId,
    },
  };
}

export function liveLaunchRouteId(view: LiveLaunchView): string {
  if (view.kind === "receipt") return view.receipt.launchId;
  return view.row.receipt?.launchId || view.row.attempt.attemptId;
}
