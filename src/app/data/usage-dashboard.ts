/** Adapter: listDashboardUsage value → UI. Do not re-sum cache into input. */

import { tr, uiLocale } from "../i18n";
import {
  listDashboardUsageOutputSchema,
  type DashboardUsageCoverage,
  type DashboardUsageDay,
  type DashboardUsageRow,
  type DashboardUsageUnits,
  type ListDashboardUsageInput,
  type ListDashboardUsageOutput,
  type TokenUsageTotals,
} from "../../shared/contracts/dashboard-usage";

export const USAGE_UNKNOWN = "Неизвестно";
export const USAGE_EMPTY = "Нет строк расхода.";
export const USAGE_NO_COST = "Нет цены";
export const USAGE_INCOMPLETE = "Цифры неполные по доступным данным.";
export const USAGE_RESET_OBSERVED = "Счётчик треда сбрасывался, итог неполный.";
export const USAGE_PERIOD_UNAVAILABLE = "За выбранный период данных нет.";
export const USAGE_PERIOD_OBSERVED = "Только дни, которые удалось восстановить.";
export const USAGE_CACHE_SEPARATE = "Кэш отдельно от входных токенов.";
export const USAGE_DEMO = "В примере нет серверного расхода. Цифры не показываем.";
export const USAGE_AVAILABLE = "Всего по доступным данным";
export const USAGE_PERIOD = "За выбранный период";
export const USAGE_LOAD_FAILED = "Не удалось загрузить расход.";
/** Token ticks without Job revision: collector should publish `usage-changed`. `domain-changed` is fallback. */
export const USAGE_REALTIME_CHANNELS = ["usage-changed", "domain-changed"] as const;
export const USAGE_GROUP_BY = ["project", "department", "model", "root"] as const;

export function createUsageFetchGate() {
  let generation = 0;
  let mounted = true;
  return {
    begin(): number {
      generation += 1;
      return generation;
    },
    accept(token: number): boolean {
      return mounted && token === generation;
    },
    /** StrictMode setup→cleanup→setup keeps the same ref; cleanup must not stay dead. */
    mount() {
      mounted = true;
    },
    unmount() {
      mounted = false;
      generation += 1;
    },
    isMounted() {
      return mounted;
    },
  };
}

export type UsageGroupBy = (typeof USAGE_GROUP_BY)[number];

export type UsageFilter = {
  projectId: string;
  departmentId: string;
  model: string;
  rootJobId: string;
  fromDate: string;
  toDate: string;
};

export const EMPTY_USAGE_FILTER: UsageFilter = {
  projectId: "",
  departmentId: "",
  model: "",
  rootJobId: "",
  fromDate: "",
  toDate: "",
};

export type UsageCatalogNames = {
  projects?: Record<string, string>;
  departments?: Record<string, string>;
  jobs?: Record<string, { key?: string; title?: string }>;
};

export type UsageDisplayRow = {
  attemptId: string;
  jobId: string;
  jobKey: string;
  jobTitle: string;
  rootJobId: string;
  rootTitle: string;
  threadId: string | null;
  projectId: string;
  projectName: string;
  departmentId: string;
  departmentName: string;
  providerId: string;
  model: string;
  attemptState: string;
  unknown: boolean;
  unknownReason: string | null;
  resetObserved: boolean;
  units: TokenUsageTotals | null;
  sessionLatestTotal: TokenUsageTotals | null;
  costUsdCents: number | null;
};

export type UsageGroup = {
  key: string;
  label: string;
  rows: UsageDisplayRow[];
  threadCount: number;
  unknownThreads: number;
  peaks: TokenUsageTotals | null;
};

export function unwrapDashboardValue(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const row = raw as Record<string, unknown>;
  if (row.result && typeof row.result === "object") {
    const result = row.result as Record<string, unknown>;
    if (result.ok === true && "value" in result) return result.value;
  }
  if (row.ok === true && "value" in row && !("grain" in row)) return row.value;
  return raw;
}

export function parseDashboardUsage(raw: unknown): ListDashboardUsageOutput | null {
  const parsed = listDashboardUsageOutputSchema.safeParse(unwrapDashboardValue(raw));
  return parsed.success ? parsed.data : null;
}

export function usageUnitsKnown(units: DashboardUsageUnits): units is DashboardUsageUnits & { unknown: false } {
  return units.unknown === false;
}

export function formatTokenCount(value: number | null | undefined, known: boolean): string {
  if (!known || value === undefined || value === null) return tr(USAGE_UNKNOWN);
  return value.toLocaleString(uiLocale());
}

/** Incomplete all-time: floor headline, never exact lifetime. */
export function formatAtLeastTokens(total: number): string {
  if (total >= 1_000_000) {
    const millions = total / 1_000_000;
    const compact = millions.toLocaleString(uiLocale(), {
      minimumFractionDigits: millions >= 10 ? 0 : 1,
      maximumFractionDigits: 1,
    });
    return tr("Не менее {compact} млн", { compact });
  }
  return tr("Не менее {total}", { total: total.toLocaleString(uiLocale()) });
}

export function availableHeadline(totals: TokenUsageTotals | null, incomplete: boolean): string {
  if (!totals) return tr(USAGE_UNKNOWN);
  if (incomplete) return formatAtLeastTokens(totals.totalTokens);
  return formatTokenCount(totals.totalTokens, true);
}

/** "≈ $3.42" at API list prices; never a bill. */
export function formatCostUsd(cents: number | null | undefined): string | null {
  if (cents === null || cents === undefined) return null;
  const usd = cents / 100;
  if (usd > 0 && usd < 0.01) return "≈ <$0.01";
  return `≈ $${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Cost of the visible rows, one thread counted once. Partial when some usage has no price. */
export function costForRows(rows: readonly UsageDisplayRow[]): { cents: number | null; partial: boolean } {
  const seen = new Map<string, number | null>();
  for (const row of rows) {
    if (row.unknown) continue;
    const key = peakDedupKey(row);
    if (!seen.has(key)) seen.set(key, row.costUsdCents);
  }
  const values = [...seen.values()];
  const priced = values.filter((value): value is number => value !== null);
  if (priced.length === 0) return { cents: null, partial: values.length > 0 };
  return {
    cents: Math.round(priced.reduce((sum, value) => sum + value, 0) * 100) / 100,
    partial: priced.length < values.length,
  };
}

export function costHeadline(cost: { cents: number | null; partial: boolean }): string {
  const formatted = formatCostUsd(cost.cents);
  if (!formatted) return tr(USAGE_NO_COST);
  return cost.partial ? tr("{cost}, не все модели с ценой", { cost: formatted }) : formatted;
}

export const USAGE_COST_BASIS = "Оценка по ценам API без записи в кеш. На подписке это не счёт, а эквивалент.";

export function allTimeHeadline(payload: ListDashboardUsageOutput): string {
  return availableHeadline(payload.allTime.totals ?? payload.totals, payload.allTime.incomplete || payload.coverage.lifetimeIncomplete);
}

export function periodHeadlineFromDays(
  days: readonly DashboardUsageDay[],
  available: boolean,
  omitted: boolean,
): string {
  if (!available || omitted || days.length === 0) return tr(USAGE_PERIOD_UNAVAILABLE);
  const total = sumDayTotals(days);
  return total ? formatTokenCount(total.totalTokens, true) : tr(USAGE_UNKNOWN);
}

export function periodHeadline(payload: ListDashboardUsageOutput): string {
  return periodHeadlineFromDays(payload.period.days, payload.period.available, payload.coverage.dayChart === "omitted");
}

export function sumDayTotals(days: readonly DashboardUsageDay[]): TokenUsageTotals | null {
  if (days.length === 0) return null;
  return days.reduce<TokenUsageTotals>(
    (sum, day) => ({
      inputTokens: sum.inputTokens + day.inputTokens,
      cachedInputTokens: sum.cachedInputTokens + day.cachedInputTokens,
      outputTokens: sum.outputTokens + day.outputTokens,
      reasoningOutputTokens: sum.reasoningOutputTokens + day.reasoningOutputTokens,
      totalTokens: sum.totalTokens + day.totalTokens,
    }),
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
  );
}

export type UsageCoverageView = Omit<DashboardUsageCoverage, "epochCount"> & {
  epochCount: number | null;
};

export function uniqueThreadIds(rows: readonly UsageDisplayRow[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.threadId) ids.add(row.threadId);
  }
  return ids;
}

function peakDedupKey(row: UsageDisplayRow): string {
  return row.threadId ?? `attempt:${row.attemptId}`;
}

export function workspaceJobKey(names: UsageCatalogNames | undefined, jobId: string): string {
  const key = names?.jobs?.[jobId]?.key?.trim();
  return key || jobId;
}

export function coverageFromRows(
  rows: readonly UsageDisplayRow[],
  base: DashboardUsageCoverage,
  options?: { includeEpochCount?: boolean },
): UsageCoverageView {
  const jobIds = new Set<string>();
  const withUsage = new Set<string>();
  const unknown = new Set<string>();
  let withoutThread = 0;
  let resetObserved = false;
  for (const row of rows) {
    jobIds.add(row.jobId);
    if (row.resetObserved) resetObserved = true;
    if (!row.threadId) {
      withoutThread += 1;
      continue;
    }
    if (row.unknown) unknown.add(row.threadId);
    else withUsage.add(row.threadId);
  }
  return {
    ...base,
    jobCount: jobIds.size,
    attemptCount: rows.length,
    uniqueThreadCount: uniqueThreadIds(rows).size,
    attemptsWithoutThread: withoutThread,
    threadsWithUsage: withUsage.size,
    threadsUnknown: unknown.size,
    resetObserved,
    epochCount: options?.includeEpochCount === false ? null : base.epochCount,
  };
}

export function coverageLines(coverage: UsageCoverageView | DashboardUsageCoverage): string[] {
  const known = tr("{known} известно · {unknown} неизвестно", {
    known: coverage.threadsWithUsage,
    unknown: coverage.threadsUnknown,
  });
  const epoch = coverage.epochCount == null ? known : tr("{known} · {epoch} эпох", { known, epoch: coverage.epochCount });
  const lines = [
    tr("{jobs} задач · {attempts} попыток · {threads} тредов", {
      jobs: coverage.jobCount,
      attempts: coverage.attemptCount,
      threads: coverage.uniqueThreadCount,
    }),
    epoch,
  ];
  if (coverage.attemptsWithoutThread > 0) {
    lines.push(tr("Без треда: {count}", { count: coverage.attemptsWithoutThread }));
  }
  if (coverage.resetObserved) lines.push(tr(USAGE_RESET_OBSERVED));
  if (coverage.lifetimeIncomplete) lines.push(tr(USAGE_INCOMPLETE));
  return lines;
}

export function technicalUsageLines(payload: ListDashboardUsageOutput): string[] {
  return [
    `grain ${payload.grain}`,
    `period.grain ${payload.period.grain}`,
    `dayChart ${payload.coverage.dayChart}`,
    payload.coverage.dayHistoryReasons.length
      ? `dayHistory ${payload.coverage.dayHistoryReasons.join(", ")}`
      : null,
  ].filter((row): row is string => Boolean(row));
}

function named(id: string | null | undefined, fallback: string): string {
  return id && id.trim() ? id : fallback;
}

export function toDisplayRows(
  rows: readonly DashboardUsageRow[],
  names: UsageCatalogNames = {},
): UsageDisplayRow[] {
  return rows.map((row) => {
    const job = names.jobs?.[row.jobId];
    const root = names.jobs?.[row.rootJobId];
    const projectId = named(row.bbProjectId, "");
    const departmentId = named(row.departmentId, "");
    const units = row.units;
    const isKnown = usageUnitsKnown(units);
    return {
      attemptId: row.attemptId,
      jobId: row.jobId,
      jobKey: job?.key || row.jobId,
      jobTitle: job?.title || row.jobId,
      rootJobId: row.rootJobId,
      rootTitle: root?.title || root?.key || row.rootJobId,
      threadId: row.threadId,
      projectId,
      projectName: (projectId && names.projects?.[projectId]) || projectId || tr(USAGE_UNKNOWN),
      departmentId,
      departmentName: (departmentId && names.departments?.[departmentId]) || departmentId || tr(USAGE_UNKNOWN),
      providerId: row.providerId || tr(USAGE_UNKNOWN),
      model: row.model || tr(USAGE_UNKNOWN),
      attemptState: row.attemptState,
      unknown: !isKnown,
      unknownReason: isKnown ? null : units.reason,
      resetObserved: row.resetObserved,
      units: isKnown
        ? {
            inputTokens: units.inputTokens,
            cachedInputTokens: units.cachedInputTokens,
            outputTokens: units.outputTokens,
            reasoningOutputTokens: units.reasoningOutputTokens,
            totalTokens: units.totalTokens,
          }
        : null,
      sessionLatestTotal: row.sessionLatestTotal,
      costUsdCents: row.costUsdCents,
    };
  });
}

export function filterDisplayRows(rows: readonly UsageDisplayRow[], filter: UsageFilter): UsageDisplayRow[] {
  return rows.filter((row) => {
    if (filter.projectId && row.projectId !== filter.projectId) return false;
    if (filter.departmentId && row.departmentId !== filter.departmentId) return false;
    if (filter.model && `${row.providerId}/${row.model}` !== filter.model) return false;
    if (filter.rootJobId && row.rootJobId !== filter.rootJobId) return false;
    return true;
  });
}

export function filterPeriodDays(
  days: readonly DashboardUsageDay[],
  filter: UsageFilter,
  allowedThreadIds?: ReadonlySet<string> | null,
): DashboardUsageDay[] {
  return days.filter((day) => {
    if (filter.fromDate && day.date < filter.fromDate) return false;
    if (filter.toDate && day.date > filter.toDate) return false;
    if (filter.projectId && day.bbProjectId !== filter.projectId) return false;
    if (filter.departmentId && day.departmentId !== filter.departmentId) return false;
    if (filter.model) {
      const model = filter.model.includes("/") ? filter.model.slice(filter.model.indexOf("/") + 1) : filter.model;
      if (day.model !== model) return false;
    }
    if (allowedThreadIds) {
      if (!day.threadId || !allowedThreadIds.has(day.threadId)) return false;
    }
    return true;
  });
}

export function mergeDaysByDate(days: readonly DashboardUsageDay[]): Array<TokenUsageTotals & { date: string }> {
  const order: string[] = [];
  const sums = new Map<string, TokenUsageTotals>();
  for (const day of days) {
    const previous = sums.get(day.date);
    if (!previous) {
      order.push(day.date);
      sums.set(day.date, {
        inputTokens: day.inputTokens,
        cachedInputTokens: day.cachedInputTokens,
        outputTokens: day.outputTokens,
        reasoningOutputTokens: day.reasoningOutputTokens,
        totalTokens: day.totalTokens,
      });
      continue;
    }
    sums.set(day.date, {
      inputTokens: previous.inputTokens + day.inputTokens,
      cachedInputTokens: previous.cachedInputTokens + day.cachedInputTokens,
      outputTokens: previous.outputTokens + day.outputTokens,
      reasoningOutputTokens: previous.reasoningOutputTokens + day.reasoningOutputTokens,
      totalTokens: previous.totalTokens + day.totalTokens,
    });
  }
  return order.map((date) => ({ date, ...sums.get(date)! }));
}

export function filteredUsageView(payload: ListDashboardUsageOutput, filter: UsageFilter, names?: UsageCatalogNames): {
  rows: UsageDisplayRow[];
  days: DashboardUsageDay[];
  daySeries: Array<TokenUsageTotals & { date: string }>;
  availableTotals: TokenUsageTotals | null;
  availableLabel: string;
  costLabel: string;
  periodLabel: string;
  coverage: UsageCoverageView;
} {
  const rows = filterDisplayRows(toDisplayRows(payload.rows, names), filter);
  const exactThreads = uniqueThreadIds(rows);
  const days = filterPeriodDays(payload.period.days, filter, filter.rootJobId ? exactThreads : null);
  const availableTotals = peaksForRows(rows);
  const incomplete = payload.allTime.incomplete || payload.coverage.lifetimeIncomplete || rows.some((row) => row.resetObserved || row.unknown);
  const sameAttempts =
    rows.length === payload.rows.length && payload.rows.every((row) => rows.some((item) => item.attemptId === row.attemptId));
  return {
    rows,
    days,
    daySeries: mergeDaysByDate(days),
    availableTotals,
    availableLabel: availableHeadline(availableTotals, incomplete),
    costLabel: costHeadline(costForRows(rows)),
    periodLabel: periodHeadlineFromDays(days, payload.period.available, payload.coverage.dayChart === "omitted" && days.length === 0),
    coverage: coverageFromRows(rows, payload.coverage, { includeEpochCount: sameAttempts }),
  };
}

export function usageFilterOptions(rows: readonly UsageDisplayRow[]): {
  projects: { value: string; label: string }[];
  departments: { value: string; label: string }[];
  models: { value: string; label: string }[];
  roots: { value: string; label: string }[];
} {
  const projects = new Map<string, string>();
  const departments = new Map<string, string>();
  const models = new Map<string, string>();
  const roots = new Map<string, string>();
  for (const row of rows) {
    if (row.projectId) projects.set(row.projectId, row.projectName);
    if (row.departmentId) departments.set(row.departmentId, row.departmentName);
    if (row.model !== tr(USAGE_UNKNOWN)) models.set(`${row.providerId}/${row.model}`, `${row.providerId} · ${row.model}`);
    roots.set(row.rootJobId, row.rootTitle);
  }
  const asOptions = (map: Map<string, string>) => [...map.entries()].map(([value, label]) => ({ value, label }));
  return {
    projects: asOptions(projects),
    departments: asOptions(departments),
    models: asOptions(models),
    roots: asOptions(roots),
  };
}

function groupKey(row: UsageDisplayRow, groupBy: UsageGroupBy): string {
  if (groupBy === "project") return row.projectId || USAGE_UNKNOWN;
  if (groupBy === "department") return row.departmentId || USAGE_UNKNOWN;
  if (groupBy === "model") return `${row.providerId}/${row.model}`;
  return row.rootJobId;
}

function groupLabel(row: UsageDisplayRow, groupBy: UsageGroupBy): string {
  if (groupBy === "project") return row.projectName;
  if (groupBy === "department") return row.departmentName;
  if (groupBy === "model") return `${row.providerId} · ${row.model}`;
  return row.rootTitle;
}

/** Peaks per unique thread. Same thread on two attempts is counted once. Null thread is not a thread. */
export function peaksForRows(rows: readonly UsageDisplayRow[]): TokenUsageTotals | null {
  const seen = new Set<string>();
  let sum: TokenUsageTotals | null = null;
  for (const row of rows) {
    if (row.unknown || !row.units) continue;
    const key = peakDedupKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    sum = sum
      ? {
          inputTokens: sum.inputTokens + row.units.inputTokens,
          cachedInputTokens: sum.cachedInputTokens + row.units.cachedInputTokens,
          outputTokens: sum.outputTokens + row.units.outputTokens,
          reasoningOutputTokens: sum.reasoningOutputTokens + row.units.reasoningOutputTokens,
          totalTokens: sum.totalTokens + row.units.totalTokens,
        }
      : { ...row.units };
  }
  return sum;
}

export function groupUsageRows(rows: readonly UsageDisplayRow[], groupBy: UsageGroupBy): UsageGroup[] {
  const buckets = new Map<string, UsageDisplayRow[]>();
  const labels = new Map<string, string>();
  for (const row of rows) {
    const key = groupKey(row, groupBy);
    const list = buckets.get(key) ?? [];
    list.push(row);
    buckets.set(key, list);
    if (!labels.has(key)) labels.set(key, groupLabel(row, groupBy));
  }
  return [...buckets.entries()].map(([key, groupRows]) => {
    const threads = uniqueThreadIds(groupRows);
    const unknownThreads = new Set(
      groupRows.filter((row) => row.unknown && row.threadId).map((row) => row.threadId as string),
    );
    return {
      key,
      label: labels.get(key) || key,
      rows: groupRows,
      threadCount: threads.size,
      unknownThreads: unknownThreads.size,
      peaks: peaksForRows(groupRows),
    };
  });
}

export function catalogNamesFromWorkspace(input: {
  jobs: readonly { id: string; recordId?: string; title: string }[];
  projects: readonly { id: string; name: string; bbProjectId?: string }[];
  departments: readonly { id: string; name: string }[];
}): UsageCatalogNames {
  const jobs: UsageCatalogNames["jobs"] = {};
  for (const job of input.jobs) {
    const meta = { key: job.id, title: job.title };
    if (job.recordId) jobs[job.recordId] = meta;
    jobs[job.id] = meta;
  }
  const projects: Record<string, string> = {};
  for (const project of input.projects) {
    projects[project.id] = project.name;
    if (project.bbProjectId) projects[project.bbProjectId] = project.name;
  }
  const departments: Record<string, string> = {};
  for (const department of input.departments) departments[department.id] = department.name;
  return { jobs, projects, departments };
}

export function dashboardQueryFromFilter(filter: UsageFilter): ListDashboardUsageInput {
  const input: ListDashboardUsageInput = {};
  if (filter.rootJobId) input.rootJobId = filter.rootJobId;
  if (filter.departmentId) input.departmentId = filter.departmentId;
  if (filter.projectId.startsWith("proj_")) input.claimedBbProjectId = filter.projectId;
  if (filter.model.includes("/")) {
    const [providerId, model] = filter.model.split("/");
    if (providerId) input.providerId = providerId;
    if (model) input.model = model;
  }
  if (filter.fromDate) input.fromDate = filter.fromDate;
  if (filter.toDate) input.toDate = filter.toDate;
  return input;
}
