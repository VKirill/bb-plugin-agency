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
  modelPriceSnippet,
  modelsWithoutPrice,
  technicalUsageLines,
  usageFilterOptions,
  workspaceJobKey,
  type UsageCatalogNames,
  type UsageFilter,
  type UsageGroupBy,
} from "../data/usage-dashboard";
import { Button, Empty, PageHead } from "./shared";
import { tr } from "../i18n";

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
  const maxDay = view?.daySeries.reduce((max, day) => Math.max(max, day.totalTokens), 0) ?? 0;
  const unpriced = view ? modelsWithoutPrice(view.rows) : [];

  return (
    <div className="space-y-5" data-testid="usage-dashboard">
      <PageHead title="Дашборд" description="Расход по запускам Агентства." />
      {budgets.length > 0 && <BudgetsPanel budgets={budgets} />}
      {providers.length > 0 && <ProvidersPanel providers={providers} />}
      {error && <p role="alert" className="text-sm">{error}</p>}
      {loading && <p className="text-xs text-muted-foreground">{tr("Загружаем расход…")}</p>}
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
              {tr("С")}
              <input
                type="date"
                aria-label={tr("Дата с")}
                className="mt-1 block rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                value={filter.fromDate}
                onChange={(event) => onFilter?.({ ...filter, fromDate: event.target.value })}
              />
            </label>
            <label className="block text-xs text-muted-foreground">
              {tr("По")}
              <input
                type="date"
                aria-label={tr("Дата по")}
                className="mt-1 block rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                value={filter.toDate}
                onChange={(event) => onFilter?.({ ...filter, toDate: event.target.value })}
              />
            </label>
          </div>
          <section aria-label={tr("Покрытие")} className="space-y-1 text-xs text-muted-foreground" data-testid="usage-coverage">
            {coverageLines(view.coverage).map((line) => <p key={line}>{line}</p>)}
          </section>
          <section aria-label={tr(USAGE_AVAILABLE)} className="space-y-1">
            <h2 className="text-sm font-medium">{tr(USAGE_AVAILABLE)}</h2>
            <p className="text-sm" data-testid="usage-all-time">{view.availableLabel}</p>
            <p className="text-xs text-muted-foreground">{tr(USAGE_CACHE_SEPARATE)}</p>
            {view.availableTotals && (
              <p className="text-xs text-muted-foreground">
                {tr("Входные без кэша {value}", { value: formatTokenCount(view.availableTotals.inputTokens, true) })}
                {" · "}{tr("Кэш {value}", { value: formatTokenCount(view.availableTotals.cachedInputTokens, true) })}
                {" · "}{tr("Ответы {value}", { value: formatTokenCount(view.availableTotals.outputTokens, true) })}
              </p>
            )}
            <p className="text-sm" data-testid="usage-cost">{tr("Стоимость: {cost}", { cost: view.costLabel })}</p>
            <p className="text-xs text-muted-foreground">{tr(USAGE_COST_BASIS)}</p>
            {unpriced.length > 0 && (
              <div className="space-y-1" data-testid="usage-unpriced">
                <p className="text-xs text-muted-foreground">
                  {tr("Токены этих моделей посчитаны, но цены у них нет: {models}. Добавьте её в «Настройки → Плагины → Агентство → Цены моделей», USD за миллион токенов:", { models: unpriced.join(", ") })}
                </p>
                <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px]">{modelPriceSnippet(unpriced)}</pre>
              </div>
            )}
          </section>
          <section aria-label={tr(USAGE_PERIOD)} className="space-y-3">
            <h2 className="text-sm font-medium">{tr(USAGE_PERIOD)}</h2>
            <p className="text-sm" data-testid="usage-period">{view.periodLabel}</p>
            {view.daySeries.length > 0 && (
              <>
                <p className="text-xs text-muted-foreground">{tr(USAGE_PERIOD_OBSERVED)}</p>
                <div className="flex h-24 items-end gap-1" data-testid="usage-day-chart" role="img" aria-label={tr("Расход по дням")}>
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
                        <th className="px-3 py-2 font-medium">{tr("День")}</th>
                        <th className="px-3 py-2 font-medium">{tr("Входные без кэша")}</th>
                        <th className="px-3 py-2 font-medium">{tr("Кэш")}</th>
                        <th className="px-3 py-2 font-medium">{tr("Ответы")}</th>
                        <th className="px-3 py-2 font-medium">{tr("Всего")}</th>
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
                    <th className="px-3 py-2 font-medium">{tr("Группа")}</th>
                    <th className="px-3 py-2 font-medium">{tr("Треды")}</th>
                    <th className="px-3 py-2 font-medium">{tr("Входные без кэша")}</th>
                    <th className="px-3 py-2 font-medium">{tr("Кэш")}</th>
                    <th className="px-3 py-2 font-medium">{tr("Ответы")}</th>
                    <th className="px-3 py-2 font-medium">{tr("Всего")}</th>
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
                        {group.unknownThreads > 0 ? tr(" · {count} неизвестно", { count: group.unknownThreads }) : ""}
                      </td>
                      <TokenCells totals={group.peaks} known={Boolean(group.peaks)} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">{tr("Технические подробности")}</summary>
            <div className="mt-1 space-y-1 font-mono">
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

/** Monthly budgets: spend against the limit, amber past the warning threshold, red when spent. */
const PROVIDER_STATUS: Record<ProviderUsageView["status"], string> = {
  ok: "",
  not_installed: "CLI не установлен",
  unauthenticated: "Нужен вход в CLI",
  expired: "Сессия CLI истекла",
  error: "BB не смог прочитать расход",
};

/** Subscription windows as BB reports them: plan, how much of the window is used, when it resets. */
function ProvidersPanel({ providers }: { providers: readonly ProviderUsageView[] }) {
  return (
    <section aria-label={tr("Подписки провайдеров")} className="space-y-2" data-testid="usage-providers">
      <h2 className="text-sm font-semibold">{tr("Подписки провайдеров")}</h2>
      <p className="text-xs text-muted-foreground">
        {tr("Расход подписки по данным BB. Токены Агентство считает само для Claude Code и Codex; остальные CLI событий расхода не присылают, и по ним видно только окно подписки.")}
      </p>
      <div className="divide-y divide-border rounded-lg border border-border">
        {providers.map((provider) => {
          const status = PROVIDER_STATUS[provider.status];
          return (
            <div key={provider.providerId} className="space-y-1.5 px-3 py-2.5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-sm font-medium">{provider.name}</span>
                {provider.planLabel && <span className="text-xs text-muted-foreground">{provider.planLabel}</span>}
                <span className="text-xs text-muted-foreground">{provider.countsTokens ? tr("токены считаются") : tr("токены не приходят")}</span>
                {status && <span className="text-xs text-amber-700 dark:text-amber-400">{tr(status)}</span>}
              </div>
              {provider.windows.map((window) => {
                const percent = Math.max(0, Math.min(100, Math.round(window.usedPercent)));
                const tone = percent >= 100 ? "bg-red-500" : percent >= 80 ? "bg-amber-500" : "bg-emerald-500";
                return (
                  <div key={`${provider.providerId}:${window.label}`} className="grid gap-1.5 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] sm:items-center sm:gap-3">
                    <span className="truncate text-xs text-muted-foreground">{window.label}</span>
                    <span className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                      <span className={`block h-full ${tone}`} style={{ width: `${percent}%` }} />
                    </span>
                    <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                      {tr("{percent}%", { percent })}
                      {window.usedUsdCents !== undefined ? ` · $${(window.usedUsdCents / 100).toFixed(2)}${window.limitUsdCents !== undefined ? ` из $${(window.limitUsdCents / 100).toFixed(2)}` : ""}` : ""}
                      {window.resetsAt ? ` · ${tr("сброс")} ${new Date(window.resetsAt).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BudgetsPanel({ budgets }: { budgets: readonly BudgetStatusView[] }) {
  return (
    <section aria-label={tr("Бюджеты за месяц")} className="space-y-2">
      <h2 className="text-sm font-semibold">{tr("Бюджеты за месяц")}</h2>
      <div className="divide-y divide-border rounded-lg border border-border">
        {budgets.map((budget) => {
          const spent = budget.percent >= 100;
          const warn = !spent && budget.percent >= budget.warnPercent;
          const tone = spent ? "bg-red-500" : warn ? "bg-amber-500" : "bg-emerald-500";
          const label = budget.scope === "agency" ? tr("Всё Агентство") : budget.label.replace(/^отдела /, tr("Отдел ")).replace(/^сотрудника /, tr("Сотрудник "));
          return (
            <div key={budget.scope} className="grid gap-1.5 px-3 py-2.5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-center sm:gap-3">
              <span className="truncate text-sm">{label}</span>
              <span className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                <span className={`block h-full ${tone}`} style={{ width: `${Math.min(100, budget.percent)}%` }} />
              </span>
              <span className={`whitespace-nowrap text-xs tabular-nums ${spent ? "text-red-600 dark:text-red-400" : warn ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}>
                {tr("{spent} из {limit} · {percent}%", { spent: `$${(budget.spendUsdCents / 100).toFixed(2)}`, limit: `$${budget.limitUsd}`, percent: budget.percent })}{spent ? tr(" · запуски остановлены") : ""}
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">{tr("Оценка по ценам API за календарный месяц (UTC): стоимость попытки считается в месяц её запуска. Лимиты — «Настройки → Правила работы», карточка отдела и профиль сотрудника.")}</p>
    </section>
  );
}
