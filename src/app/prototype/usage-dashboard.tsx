import type { ListDashboardUsageOutput } from "../../shared/contracts/dashboard-usage";
import {
  EMPTY_USAGE_FILTER,
  USAGE_AVAILABLE,
  USAGE_CACHE_SEPARATE,
  USAGE_EMPTY,
  USAGE_GROUP_BY,
  USAGE_NO_COST,
  USAGE_PERIOD,
  USAGE_PERIOD_OBSERVED,
  USAGE_UNKNOWN,
  coverageLines,
  filteredUsageView,
  formatTokenCount,
  groupUsageRows,
  technicalUsageLines,
  usageFilterOptions,
  workspaceJobKey,
  type UsageCatalogNames,
  type UsageFilter,
  type UsageGroupBy,
} from "../data/usage-dashboard";
import { Button, Empty, PageHead } from "./shared";

const GROUP_LABEL: Record<UsageGroupBy, string> = {
  project: "Проект",
  department: "Отдел",
  model: "Модель",
  root: "Главная задача",
};

function NativeSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="block w-40 min-w-0 text-xs text-muted-foreground">
      {label}
      <select
        aria-label={label}
        className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((item) => (
          <option key={item.value} value={item.value}>{item.label}</option>
        ))}
      </select>
    </label>
  );
}

function TokenCells({
  totals,
  known,
}: {
  totals: { inputTokens: number; cachedInputTokens: number; outputTokens: number; totalTokens: number } | null;
  known: boolean;
}) {
  return (
    <>
      <td className="px-3 py-2 text-xs">{formatTokenCount(totals?.inputTokens, known)}</td>
      <td className="px-3 py-2 text-xs">{formatTokenCount(totals?.cachedInputTokens, known)}</td>
      <td className="px-3 py-2 text-xs">{formatTokenCount(totals?.outputTokens, known)}</td>
      <td className="px-3 py-2 text-xs">{formatTokenCount(totals?.totalTokens, known)}</td>
    </>
  );
}

export function UsageDashboard({
  payload,
  names,
  groupBy,
  filter = EMPTY_USAGE_FILTER,
  error,
  loading,
  onGroupBy,
  onFilter,
  onOpenJob,
}: {
  payload: ListDashboardUsageOutput | null;
  names?: UsageCatalogNames;
  groupBy: UsageGroupBy;
  filter?: UsageFilter;
  error?: string | null;
  loading?: boolean;
  onGroupBy?: (value: UsageGroupBy) => void;
  onFilter?: (next: UsageFilter) => void;
  onOpenJob?: (jobKey: string) => void;
}) {
  const view = payload ? filteredUsageView(payload, filter, names) : null;
  const groups = view ? groupUsageRows(view.rows, groupBy) : [];
  const options = usageFilterOptions(payload ? filteredUsageView(payload, EMPTY_USAGE_FILTER, names).rows : []);
  const maxDay = view?.daySeries.reduce((max, day) => Math.max(max, day.totalTokens), 0) ?? 0;

  return (
    <div className="space-y-5" data-testid="usage-dashboard">
      <PageHead title="Дашборд" description="Расход по запускам Агентства." />
      {error && <p role="alert" className="text-sm">{error}</p>}
      {loading && <p className="text-xs text-muted-foreground">Загружаем расход…</p>}
      {!payload && !error && !loading && <Empty title="Нет данных" description={USAGE_EMPTY} />}
      {payload && view && (
        <>
          <div className="flex flex-wrap gap-3">
            <NativeSelect
              label="Группировка"
              value={groupBy}
              onChange={(value) => onGroupBy?.(value as UsageGroupBy)}
              options={USAGE_GROUP_BY.map((value) => ({ value, label: GROUP_LABEL[value] }))}
            />
            <NativeSelect
              label="Проект"
              value={filter.projectId || "all"}
              onChange={(value) => onFilter?.({ ...filter, projectId: value === "all" ? "" : value })}
              options={[{ value: "all", label: "Все проекты" }, ...options.projects]}
            />
            <NativeSelect
              label="Отдел"
              value={filter.departmentId || "all"}
              onChange={(value) => onFilter?.({ ...filter, departmentId: value === "all" ? "" : value })}
              options={[{ value: "all", label: "Все отделы" }, ...options.departments]}
            />
            <NativeSelect
              label="Модель"
              value={filter.model || "all"}
              onChange={(value) => onFilter?.({ ...filter, model: value === "all" ? "" : value })}
              options={[{ value: "all", label: "Все модели" }, ...options.models]}
            />
            <NativeSelect
              label="Главная задача"
              value={filter.rootJobId || "all"}
              onChange={(value) => onFilter?.({ ...filter, rootJobId: value === "all" ? "" : value })}
              options={[{ value: "all", label: "Все главные задачи" }, ...options.roots]}
            />
            <label className="block text-xs text-muted-foreground">
              С
              <input
                type="date"
                aria-label="Дата с"
                className="mt-1 block rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                value={filter.fromDate}
                onChange={(event) => onFilter?.({ ...filter, fromDate: event.target.value })}
              />
            </label>
            <label className="block text-xs text-muted-foreground">
              По
              <input
                type="date"
                aria-label="Дата по"
                className="mt-1 block rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                value={filter.toDate}
                onChange={(event) => onFilter?.({ ...filter, toDate: event.target.value })}
              />
            </label>
          </div>
          <section aria-label="Покрытие" className="space-y-1 text-xs text-muted-foreground" data-testid="usage-coverage">
            {coverageLines(view.coverage).map((line) => <p key={line}>{line}</p>)}
          </section>
          <section aria-label={USAGE_AVAILABLE} className="space-y-1">
            <h2 className="text-sm font-medium">{USAGE_AVAILABLE}</h2>
            <p className="text-sm" data-testid="usage-all-time">{view.availableLabel}</p>
            <p className="text-xs text-muted-foreground">{USAGE_CACHE_SEPARATE}</p>
            {view.availableTotals && (
              <p className="text-xs text-muted-foreground">
                Входные без кэша {formatTokenCount(view.availableTotals.inputTokens, true)}
                {" · "}Кэш {formatTokenCount(view.availableTotals.cachedInputTokens, true)}
                {" · "}Ответы {formatTokenCount(view.availableTotals.outputTokens, true)}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{USAGE_NO_COST}</p>
          </section>
          <section aria-label={USAGE_PERIOD} className="space-y-3">
            <h2 className="text-sm font-medium">{USAGE_PERIOD}</h2>
            <p className="text-sm" data-testid="usage-period">{view.periodLabel}</p>
            {view.daySeries.length > 0 && (
              <>
                <p className="text-xs text-muted-foreground">{USAGE_PERIOD_OBSERVED}</p>
                <div className="flex h-24 items-end gap-1" data-testid="usage-day-chart" role="img" aria-label="Расход по дням">
                  {view.daySeries.map((day) => (
                    <div key={day.date} className="flex min-w-0 flex-1 flex-col items-center justify-end">
                      <div
                        className="w-full rounded-t bg-foreground/70"
                        style={{ height: `${maxDay ? Math.max(8, Math.round((day.totalTokens / maxDay) * 96)) : 8}px` }}
                        title={`${day.date}: ${formatTokenCount(day.totalTokens, true)}`}
                      />
                    </div>
                  ))}
                </div>
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-muted/40 text-xs text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-medium">День</th>
                        <th className="px-3 py-2 font-medium">Входные без кэша</th>
                        <th className="px-3 py-2 font-medium">Кэш</th>
                        <th className="px-3 py-2 font-medium">Ответы</th>
                        <th className="px-3 py-2 font-medium">Всего</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {view.daySeries.map((day) => (
                        <tr key={day.date}>
                          <td className="px-3 py-2 text-xs">{day.date}</td>
                          <TokenCells totals={day} known />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
          {groups.length === 0 ? (
            <Empty title="Нет строк" description={USAGE_EMPTY} />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Группа</th>
                    <th className="px-3 py-2 font-medium">Треды</th>
                    <th className="px-3 py-2 font-medium">Входные без кэша</th>
                    <th className="px-3 py-2 font-medium">Кэш</th>
                    <th className="px-3 py-2 font-medium">Ответы</th>
                    <th className="px-3 py-2 font-medium">Всего</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {groups.map((group) => (
                    <tr key={group.key}>
                      <td className="px-3 py-2">
                        {groupBy === "root" && onOpenJob ? (
                          <Button size="sm" variant="ghost" className="h-auto px-0" onClick={() => onOpenJob(workspaceJobKey(names, group.key))}>
                            {group.label}
                          </Button>
                        ) : group.label}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {group.threadCount}
                        {group.unknownThreads > 0 ? ` · ${group.unknownThreads} неизвестно` : ""}
                      </td>
                      <TokenCells totals={group.peaks} known={Boolean(group.peaks)} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Технические подробности</summary>
            <div className="mt-1 space-y-1 font-mono">
              {technicalUsageLines(payload).map((line) => <p key={line}>{line}</p>)}
            </div>
            <ul className="mt-2 space-y-1 font-sans">
              {view.rows.map((row) => (
                <li key={row.attemptId}>
                  <button type="button" className="text-left hover:underline" onClick={() => onOpenJob?.(row.jobKey)}>
                    {row.jobKey} · {row.attemptState}
                    {row.unknown ? ` · ${USAGE_UNKNOWN}` : ""}
                    {row.resetObserved ? " · сброс" : ""}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
