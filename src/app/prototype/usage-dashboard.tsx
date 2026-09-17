import { useState, type ReactNode } from "react";
import type { BudgetStatusView, ProviderUsageView } from "../../shared/rpc-contract";
import type { ListDashboardUsageOutput } from "../../shared/contracts/dashboard-usage";
import {
  EMPTY_USAGE_FILTER,
  USAGE_AVAILABLE,
  USAGE_CACHE_SEPARATE,
  USAGE_EMPTY,
  USAGE_GROUP_BY,
  USAGE_COST_BASIS,
  USAGE_PERIOD,
  USAGE_PERIOD_OBSERVED,
  USAGE_UNKNOWN,
  coverageLines,
  filteredUsageView,
  formatTokenCount,
  groupUsageRows,
  modelsWithoutPrice,
  technicalUsageLines,
  usageFilterOptions,
  workspaceJobKey,
  type UsageCatalogNames,
  type UsageFilter,
  type UsageGroupBy,
} from "../data/usage-dashboard";
import { UsageAreaChart } from "./usage-chart";
import { activePeriod, periodRange, type ChartDimension } from "../data/usage-chart";
import { DateRangePicker } from "./date-range";
import { Button, Empty, PageHead } from "./shared";
import { tr, uiLocale } from "../i18n";

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
      {tr(label)}
      <select
        aria-label={tr(label)}
        className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((item) => (
          <option key={item.value} value={item.value}>{tr(item.label)}</option>
        ))}
      </select>
    </label>
  );
}

function TokenCells({
  totals,
  known,
  strong,
}: {
  totals: { inputTokens: number; cachedInputTokens: number; outputTokens: number; totalTokens: number } | null;
  known: boolean;
  /** The total row: the same columns, read as a sum. */
  strong?: boolean;
}) {
  const cell = `px-3 py-2 text-right text-xs tabular-nums${strong ? " font-medium" : ""}`;
  return (
    <>
      <td className={cell}>{formatTokenCount(totals?.inputTokens, known)}</td>
      <td className={cell}>{formatTokenCount(totals?.cachedInputTokens, known)}</td>
      <td className={cell}>{formatTokenCount(totals?.outputTokens, known)}</td>
      <td className={`${cell} text-foreground`}>{formatTokenCount(totals?.totalTokens, known)}</td>
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
  budgets = [],
  providers = [],
}: {
  /** Scopes with a monthly budget and their spend this month. */
  budgets?: readonly BudgetStatusView[];
  /** Subscription spending BB reports per CLI; the only number for a CLI without token events. */
  providers?: readonly ProviderUsageView[];
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
  const unpriced = view ? modelsWithoutPrice(view.rows) : [];
  const [chartDimension, setChartDimension] = useState<ChartDimension>("model");
  const filtered = Boolean(filter.projectId || filter.departmentId || filter.model || filter.rootJobId || filter.fromDate || filter.toDate);

  return (
    <div className="space-y-4" data-testid="usage-dashboard">
      <PageHead title="Дашборд" description="Расход по запускам Агентства." />
      {error && <p role="alert" className="text-sm">{error}</p>}
      {loading && <p className="text-xs text-muted-foreground">{tr("Загружаем расход…")}</p>}
      {!payload && !error && !loading && <Empty title="Нет данных" description={USAGE_EMPTY} />}
      {payload && view && (
        <>
          <section aria-label={tr("Фильтры")} className="rounded-lg border border-border p-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
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
              <DateRangePicker
                range={{ fromDate: filter.fromDate, toDate: filter.toDate }}
                onChange={(next) => onFilter?.({ ...filter, ...next })}
              />
              <div className="flex items-end">
                {filtered && onFilter && (
                  <Button size="sm" variant="outline" className="h-8 w-full" onClick={() => onFilter({ ...EMPTY_USAGE_FILTER })}>{tr("Сбросить фильтры")}</Button>
                )}
              </div>
            </div>
          </section>

          <section aria-label={tr("Итоги")} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label={USAGE_AVAILABLE} value={view.availableLabel} testId="usage-all-time">
              {view.availableTotals && (
                <dl className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                  <TileRow label="Входные без кэша" value={formatTokenCount(view.availableTotals.inputTokens, true)} />
                  <TileRow label="Кэш" value={formatTokenCount(view.availableTotals.cachedInputTokens, true)} />
                  <TileRow label="Ответы" value={formatTokenCount(view.availableTotals.outputTokens, true)} />
                </dl>
              )}
            </Tile>
            <Tile label="Стоимость" value={view.costLabel} testId="usage-cost" hint={USAGE_COST_BASIS} />
            <Tile label={USAGE_PERIOD} value={view.periodLabel} testId="usage-period" hint={view.daySeries.length ? USAGE_PERIOD_OBSERVED : undefined} />
            <Tile label="Треды с расходом" value={`${view.coverage.threadsWithUsage} ${tr("из")} ${view.coverage.uniqueThreadCount}`}>
              <p className="mt-2 text-xs text-muted-foreground">{tr(USAGE_CACHE_SEPARATE)}</p>
            </Tile>
          </section>

          {view.days.length > 0 && (
            <section aria-label={tr("Расход по дням")} className="rounded-lg border border-border p-3">
              <UsageAreaChart
                days={view.days}
                names={names}
                dimension={chartDimension}
                onDimension={setChartDimension}
                period={activePeriod(filter)}
                onPeriod={onFilter ? (next) => onFilter({ ...filter, ...(next ? periodRange(next) : { fromDate: "", toDate: "" }) }) : undefined}
              />
            </section>
          )}

          <section aria-label={tr("Расход по группам")} className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">{tr(GROUP_TITLE[groupBy])}</h2>
              <p className="text-xs text-muted-foreground">{tr("Строк: {count}", { count: groups.length })}</p>
            </div>
            {groups.length === 0 ? (
              <Empty title="Нет строк" description={USAGE_EMPTY} />
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">{tr(GROUP_LABEL[groupBy])}</th>
                      <th className="px-3 py-2 text-right font-medium">{tr("Треды")}</th>
                      <NumberHeads />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {groups.map((group) => (
                      <tr key={group.key} className="hover:bg-muted/30">
                        <td className="px-3 py-2">
                          {groupBy === "root" && onOpenJob ? (
                            <Button size="sm" variant="ghost" className="h-auto px-0 font-normal" onClick={() => onOpenJob(workspaceJobKey(names, group.key))}>
                              {group.label}
                            </Button>
                          ) : group.label}
                        </td>
                        <td className="px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">
                          {group.threadCount}
                          {group.unknownThreads > 0 ? tr(" · {count} неизвестно", { count: group.unknownThreads }) : ""}
                        </td>
                        <TokenCells totals={group.peaks} known={Boolean(group.peaks)} />
                      </tr>
                    ))}
                  </tbody>
                  {view.availableTotals && (
                    <tfoot className="border-t border-border bg-muted/20 text-sm">
                      <tr>
                        <td className="px-3 py-2 font-medium">{tr("Итого")}</td>
                        <td className="px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">{view.coverage.uniqueThreadCount}</td>
                        <TokenCells totals={view.availableTotals} known strong />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </section>

          {providers.length > 0 && <ProvidersPanel providers={providers} />}
          {budgets.length > 0 && <BudgetsPanel budgets={budgets} />}

          <details className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground" data-testid="usage-technical">
            <summary className="cursor-pointer">{tr("Как это посчитано")}</summary>
            <div className="mt-2 space-y-1" data-testid="usage-coverage">
              {coverageLines(view.coverage).map((line) => <p key={line}>{line}</p>)}
              <p>{tr(USAGE_PERIOD_OBSERVED)}</p>
              {unpriced.length > 0 && (
                <p data-testid="usage-unpriced">
                  {tr("Без цены: {models}. Цены задаются в «Настройки → Цены моделей».", { models: unpriced.join(", ") })}
                </p>
              )}
            </div>
            <div className="mt-2 space-y-1 font-mono">
              {technicalUsageLines(payload).map((line) => <p key={line}>{line}</p>)}
            </div>
            <ul className="mt-2 space-y-1 font-sans">
              {view.rows.map((row) => (
                <li key={row.attemptId}>
                  <button type="button" className="text-left hover:underline" onClick={() => onOpenJob?.(row.jobKey)}>
                    {row.jobKey} · {row.attemptState}
                    {row.unknown ? ` · ${tr(USAGE_UNKNOWN)}` : ""}
                    {row.resetObserved ? tr(" · сброс") : ""}
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

const GROUP_TITLE: Record<UsageGroupBy, string> = {
  project: "Расход по проектам",
  department: "Расход по отделам",
  model: "Расход по моделям",
  root: "Расход по главным задачам",
};

/** One number of the summary strip: a label, the number itself, optional detail under it. */
function Tile({
  label,
  value,
  hint,
  testId,
  children,
}: {
  label: string;
  value: string;
  hint?: string;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-col rounded-lg border border-border p-3" aria-label={tr(label)}>
      <p className="text-xs text-muted-foreground">{tr(label)}</p>
      <p className="mt-1 text-lg font-semibold leading-tight tabular-nums" {...(testId ? { "data-testid": testId } : {})}>{value}</p>
      {children}
      {hint && <p className="mt-auto pt-2 text-xs leading-snug text-muted-foreground">{tr(hint)}</p>}
    </section>
  );
}

function TileRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt>{tr(label)}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

/** The four token columns, in one order everywhere on this page. */
function NumberHeads() {
  return (
    <>
      <th className="px-3 py-2 text-right font-medium">{tr("Входные без кэша")}</th>
      <th className="px-3 py-2 text-right font-medium">{tr("Кэш")}</th>
      <th className="px-3 py-2 text-right font-medium">{tr("Ответы")}</th>
      <th className="px-3 py-2 text-right font-medium">{tr("Всего")}</th>
    </>
  );
}

/** Monthly budgets: spend against the limit, amber past the warning threshold, red when spent. */
const PROVIDER_STATUS: Record<ProviderUsageView["status"], string> = {
  ok: "",
  not_installed: "CLI не установлен",
  unauthenticated: "Нужен вход в CLI",
  expired: "Сессия CLI истекла",
  error: "BB не смог прочитать расход",
};

/** One share bar: the same width and colours for a subscription window and for a budget. */
function ShareBar({ percent }: { percent: number }) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  const tone = value >= 100 ? "bg-red-500" : value >= 80 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span className={`block h-full ${tone}`} style={{ width: `${value}%` }} />
      </span>
      <span className={`tabular-nums ${value >= 100 ? "text-red-600 dark:text-red-400" : value >= 80 ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}>{value}%</span>
    </span>
  );
}

function shortMoment(value: string): string {
  return new Date(value).toLocaleString(uiLocale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Subscription windows as BB reports them: plan, how much of the window is used, when it resets. */
function ProvidersPanel({ providers }: { providers: readonly ProviderUsageView[] }) {
  return (
    <section aria-label={tr("Подписки провайдеров")} className="space-y-2" data-testid="usage-providers">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{tr("Подписки провайдеров")}</h2>
        <p className="max-w-xl text-xs text-muted-foreground">
          {tr("Расход подписки по данным BB. Токены Агентство считает само для Claude Code и Codex; остальные CLI событий расхода не присылают, и по ним видно только окно подписки.")}
        </p>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">{tr("CLI")}</th>
              <th className="px-3 py-2 font-medium">{tr("План")}</th>
              <th className="px-3 py-2 font-medium">{tr("Окно")}</th>
              <th className="px-3 py-2 font-medium">{tr("Использовано")}</th>
              <th className="px-3 py-2 font-medium">{tr("Сброс")}</th>
              <th className="px-3 py-2 font-medium">{tr("Токены")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {providers.flatMap((provider) => {
              const status = PROVIDER_STATUS[provider.status];
              const windows = provider.windows.length ? provider.windows : [null];
              return windows.map((window, index) => (
                <tr key={`${provider.providerId}:${window?.label ?? "none"}`} className="hover:bg-muted/30">
                  <td className="px-3 py-2">{index === 0 ? provider.name : ""}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{index === 0 ? provider.planLabel ?? "—" : ""}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {window ? window.label : <span className="text-amber-700 dark:text-amber-400">{status ? tr(status) : tr("Окон нет")}</span>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {window ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <ShareBar percent={window.usedPercent} />
                        {window.usedUsdCents !== undefined && (
                          <span className="tabular-nums text-muted-foreground">
                            ${(window.usedUsdCents / 100).toFixed(2)}
                            {window.limitUsdCents !== undefined ? ` ${tr("из")} $${(window.limitUsdCents / 100).toFixed(2)}` : ""}
                          </span>
                        )}
                      </span>
                    ) : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums text-muted-foreground">{window?.resetsAt ? shortMoment(window.resetsAt) : "—"}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {index === 0 ? (provider.countsTokens ? tr("считаются") : tr("не приходят")) : ""}
                  </td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
      {providers.some((provider) => provider.status !== "ok" && provider.windows.length > 0) && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {providers.filter((provider) => provider.status !== "ok").map((provider) => `${provider.name}: ${tr(PROVIDER_STATUS[provider.status])}`).join(" · ")}
        </p>
      )}
    </section>
  );
}

function BudgetsPanel({ budgets }: { budgets: readonly BudgetStatusView[] }) {
  return (
    <section aria-label={tr("Бюджеты за месяц")} className="space-y-2">
      <h2 className="text-sm font-semibold">{tr("Бюджеты за месяц")}</h2>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">{tr("Уровень")}</th>
              <th className="px-3 py-2 font-medium">{tr("Израсходовано")}</th>
              <th className="px-3 py-2 text-right font-medium">{tr("Потрачено")}</th>
              <th className="px-3 py-2 text-right font-medium">{tr("Лимит")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {budgets.map((budget) => {
              const spent = budget.percent >= 100;
              const label = budget.scope === "agency" ? tr("Всё Агентство") : budget.label.replace(/^отдела /, tr("Отдел ")).replace(/^сотрудника /, tr("Сотрудник "));
              return (
                <tr key={budget.scope} className="hover:bg-muted/30">
                  <td className="px-3 py-2">
                    {label}
                    {spent && <span className="ml-2 text-xs text-red-600 dark:text-red-400">{tr("запуски остановлены")}</span>}
                  </td>
                  <td className="px-3 py-2 text-xs"><ShareBar percent={budget.percent} /></td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">{`$${(budget.spendUsdCents / 100).toFixed(2)}`}</td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">{`$${budget.limitUsd}`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
