import type { DashboardUsageDay } from "../../shared/contracts/dashboard-usage";
import { tr } from "../i18n";
import type { UsageCatalogNames } from "./usage-dashboard";

/**
 * Days of the dashboard turned into stacked cumulative series: what each model (or department,
 * or project) has spent by every day of the period. The chart reads left to right as a total
 * that only grows; the daily number stays in the tooltip and in the table under the chart.
 */

export const CHART_DIMENSIONS = ["model", "department", "project"] as const;
export type ChartDimension = (typeof CHART_DIMENSIONS)[number];

/** Series past this many fold into «Другое»: hues are assigned in a fixed order, never cycled. */
export const MAX_CHART_SERIES = 6;
export const OTHER_SERIES_KEY = "__other__";

export type UsageSeries = {
  key: string;
  label: string;
  /** Tokens of this series on each date of `dates`. */
  daily: number[];
  /** Tokens of this series by the end of each date. */
  cumulative: number[];
  total: number;
};

export type UsageChartData = {
  dates: string[];
  series: UsageSeries[];
  dailyTotals: number[];
  cumulativeTotals: number[];
  /** Top of the stack on the last date: the scale of the chart. */
  max: number;
};

function labelOf(dimension: ChartDimension, key: string, names?: UsageCatalogNames): string {
  if (key === "") return tr("Не указано");
  if (dimension === "department") return names?.departments?.[key] ?? key;
  if (dimension === "project") return names?.projects?.[key] ?? key;
  return key;
}

function keyOf(dimension: ChartDimension, day: DashboardUsageDay): string {
  if (dimension === "department") return day.departmentId ?? "";
  if (dimension === "project") return day.bbProjectId ?? "";
  return day.model ?? "";
}

export function usageChartData(days: readonly DashboardUsageDay[], dimension: ChartDimension, names?: UsageCatalogNames): UsageChartData {
  const dates = [...new Set(days.map((day) => day.date))].sort();
  const byKey = new Map<string, Map<string, number>>();
  for (const day of days) {
    const key = keyOf(dimension, day);
    const row = byKey.get(key) ?? new Map<string, number>();
    row.set(day.date, (row.get(day.date) ?? 0) + day.totalTokens);
    byKey.set(key, row);
  }
  const ranked = [...byKey.entries()]
    .map(([key, row]) => ({ key, row, total: [...row.values()].reduce((sum, value) => sum + value, 0) }))
    .sort((left, right) => right.total - left.total || left.key.localeCompare(right.key));
  const kept = ranked.slice(0, MAX_CHART_SERIES);
  const folded = ranked.slice(MAX_CHART_SERIES);
  if (folded.length) {
    const row = new Map<string, number>();
    for (const item of folded) {
      for (const [date, value] of item.row) row.set(date, (row.get(date) ?? 0) + value);
    }
    kept.push({ key: OTHER_SERIES_KEY, row, total: folded.reduce((sum, item) => sum + item.total, 0) });
  }
  const series: UsageSeries[] = kept.map((item) => {
    const daily = dates.map((date) => item.row.get(date) ?? 0);
    let running = 0;
    const cumulative = daily.map((value) => (running += value));
    return {
      key: item.key,
      label: item.key === OTHER_SERIES_KEY ? tr("Другое") : labelOf(dimension, item.key, names),
      daily,
      cumulative,
      total: item.total,
    };
  });
  const dailyTotals = dates.map((_, index) => series.reduce((sum, row) => sum + row.daily[index]!, 0));
  let running = 0;
  const cumulativeTotals = dailyTotals.map((value) => (running += value));
  return { dates, series, dailyTotals, cumulativeTotals, max: cumulativeTotals[cumulativeTotals.length - 1] ?? 0 };
}

/** Axis ticks at 1, 2 or 5 × a power of ten, so the labels read as round numbers. */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0];
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((factor) => factor * magnitude).find((value) => value >= rough) ?? 10 * magnitude;
  const ticks: number[] = [];
  for (let value = 0; value < max + step; value += step) ticks.push(Number(value.toFixed(6)));
  return ticks;
}

/** Share of the day, in whole percent, for the tooltip. */
export function sharePercent(value: number, total: number): number {
  if (!total) return 0;
  return Math.round((value / total) * 1000) / 10;
}
