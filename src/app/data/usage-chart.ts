import type { DashboardUsageDay } from "../../shared/contracts/dashboard-usage";
import { tr, uiLocale } from "../i18n";
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

/** Windows the chart offers above the plot, in days. */
export const CHART_PERIODS = [7, 30, 90] as const;

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** The dates a window covers, today included. */
export function periodRange(days: number, today = new Date()): { fromDate: string; toDate: string } {
  const from = new Date(today.getTime());
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { fromDate: isoDate(from), toDate: isoDate(today) };
}

/** Which window the filter is on: a preset, or null for everything there is. */
export function activePeriod(filter: { fromDate: string; toDate: string }, today = new Date()): number | null {
  if (!filter.fromDate && !filter.toDate) return null;
  for (const days of CHART_PERIODS) {
    const range = periodRange(days, today);
    if (range.fromDate === filter.fromDate && range.toDate === filter.toDate) return days;
  }
  return null;
}

/** Axis labels stay short: «2,5 млн» instead of eight digits that collide with the plot. */
export function compactTokens(value: number): string {
  if (!Number.isFinite(value)) return "";
  return value.toLocaleString(uiLocale(), { notation: "compact", maximumFractionDigits: 1 });
}

/** Names on the bands: the long ones are cut, the tooltip still spells them out. */
export function clipLabel(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Label positions pushed apart to `gap` without leaving the plot: bands can be thin and
 * their middles nearly equal, and two names on one line read as one.
 */
export function spreadLabels(anchors: readonly number[], gap: number, top: number, bottom: number): number[] {
  const order = anchors.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value);
  let previous = Number.NEGATIVE_INFINITY;
  for (const item of order) {
    item.value = Math.max(item.value, previous + gap);
    previous = item.value;
  }
  // Pushed past the bottom edge: walk back up so the last label stays inside the plot.
  let limit = bottom;
  for (const item of [...order].reverse()) {
    item.value = Math.min(item.value, limit);
    limit = item.value - gap;
  }
  const out = new Array<number>(anchors.length);
  for (const item of order) out[item.index] = Math.max(top, item.value);
  return out;
}
