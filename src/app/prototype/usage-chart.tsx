import { useMemo, useState } from "react";
import type { DashboardUsageDay } from "../../shared/contracts/dashboard-usage";
import {
  CHART_DIMENSIONS,
  niceTicks,
  sharePercent,
  usageChartData,
  type ChartDimension,
} from "../data/usage-chart";
import { formatTokenCount, type UsageCatalogNames } from "../data/usage-dashboard";
import { tr, uiLocale } from "../i18n";

/**
 * Cumulative spend of the period: one stacked band per model (or department, or project),
 * growing left to right. The crosshair reads the day under the pointer; every number it shows
 * is also in the table under the chart, so the chart never holds data on its own.
 */

/** Categorical slots in a fixed order, validated for both themes; a seventh series folds into «Другое». */
const SERIES_FILL = [
  "fill-[#2a78d6] dark:fill-[#3987e5]",
  "fill-[#eb6834] dark:fill-[#d95926]",
  "fill-[#1baf7a] dark:fill-[#199e70]",
  "fill-[#eda100] dark:fill-[#c98500]",
  "fill-[#e87ba4] dark:fill-[#d55181]",
  "fill-[#008300] dark:fill-[#008300]",
  "fill-[#4a3aa7] dark:fill-[#9085e9]",
];
const SERIES_SWATCH = [
  "bg-[#2a78d6] dark:bg-[#3987e5]",
  "bg-[#eb6834] dark:bg-[#d95926]",
  "bg-[#1baf7a] dark:bg-[#199e70]",
  "bg-[#eda100] dark:bg-[#c98500]",
  "bg-[#e87ba4] dark:bg-[#d55181]",
  "bg-[#008300] dark:bg-[#008300]",
  "bg-[#4a3aa7] dark:bg-[#9085e9]",
];

const DIMENSION_LABEL: Record<ChartDimension, string> = {
  model: "по моделям",
  department: "по отделам",
  project: "по проектам",
};

const WIDTH = 720;
const HEIGHT = 240;
const PADDING = { top: 12, right: 12, bottom: 28, left: 64 };

function shortDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString(uiLocale(), { day: "2-digit", month: "short", timeZone: "UTC" });
}

export function UsageAreaChart({
  days,
  names,
  dimension,
  onDimension,
}: {
  days: readonly DashboardUsageDay[];
  names?: UsageCatalogNames;
  dimension: ChartDimension;
  onDimension: (next: ChartDimension) => void;
}) {
  const data = useMemo(() => usageChartData(days, dimension, names), [days, dimension, names]);
  const [active, setActive] = useState<number | null>(null);
  const ticks = niceTicks(data.max);
  const top = ticks[ticks.length - 1] || 1;
  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const stepX = data.dates.length > 1 ? plotWidth / (data.dates.length - 1) : 0;
  const x = (index: number) => PADDING.left + (data.dates.length > 1 ? index * stepX : plotWidth / 2);
  const y = (value: number) => PADDING.top + plotHeight - (value / top) * plotHeight;

  // Bands are stacked bottom-up in series order, so a band's area is its own share of the total.
  const bands = data.series.map((series, seriesIndex) => {
    const lower = data.dates.map((_, index) =>
      data.series.slice(0, seriesIndex).reduce((sum, row) => sum + row.cumulative[index]!, 0),
    );
    const upper = lower.map((value, index) => value + series.cumulative[index]!);
    const forward = upper.map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
    const back = [...lower].reverse().map((value, index) => `L${x(lower.length - 1 - index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
    return { series, path: `${forward} ${back} Z`, top: upper };
  });

  const today = new Date().toISOString().slice(0, 10);
  const todayIndex = data.dates.indexOf(today);
  const hovered = active !== null && active >= 0 && active < data.dates.length ? active : null;

  const move = (event: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width || !data.dates.length) return;
    const local = ((event.clientX - box.left) / box.width) * WIDTH;
    const index = data.dates.length > 1 ? Math.round((local - PADDING.left) / stepX) : 0;
    setActive(Math.max(0, Math.min(data.dates.length - 1, index)));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{tr("Расход по дням")}</h2>
          <p className="text-xs text-muted-foreground">{tr("Накопительно за период, {dimension}", { dimension: tr(DIMENSION_LABEL[dimension]) })}</p>
        </div>
        <label className="text-xs text-muted-foreground">
          {tr("Разрез")}
          <select
            aria-label={tr("Разрез графика")}
            className="ml-2 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
            value={dimension}
            onChange={(event) => onDimension(event.target.value as ChartDimension)}
          >
            {CHART_DIMENSIONS.map((value) => (
              <option key={value} value={value}>{tr(DIMENSION_LABEL[value])}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          // The box keeps the viewBox ratio, so a pointer x maps straight onto a chart x.
          className="aspect-[3/1] w-full touch-none"
          role="img"
          aria-label={tr("Расход по дням")}
          data-testid="usage-day-chart"
          tabIndex={0}
          onPointerMove={move}
          onPointerLeave={() => setActive(null)}
          onFocus={() => setActive(data.dates.length - 1)}
          onBlur={() => setActive(null)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const base = hovered ?? data.dates.length - 1;
            setActive(Math.max(0, Math.min(data.dates.length - 1, base + (event.key === "ArrowRight" ? 1 : -1))));
          }}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={PADDING.left} x2={WIDTH - PADDING.right} y1={y(tick)} y2={y(tick)} className="stroke-border" strokeWidth={1} />
              <text x={PADDING.left - 8} y={y(tick) + 4} textAnchor="end" className="fill-muted-foreground text-[11px]">
                {formatTokenCount(tick, true)}
              </text>
            </g>
          ))}
          {bands.map((band, index) => (
            // A 2px stroke in the surface colour is the gap between touching bands.
            <path
              key={band.series.key}
              d={band.path}
              className={`${SERIES_FILL[index % SERIES_FILL.length]} stroke-background`}
              strokeWidth={2}
              fillOpacity={0.85}
            />
          ))}
          {todayIndex >= 0 && (
            <g>
              <line x1={x(todayIndex)} x2={x(todayIndex)} y1={PADDING.top} y2={PADDING.top + plotHeight} className="stroke-muted-foreground" strokeWidth={1} strokeDasharray="4 3" />
              <text
                x={x(todayIndex)}
                y={PADDING.top - 2}
                textAnchor={todayIndex === data.dates.length - 1 ? "end" : "middle"}
                className="fill-muted-foreground text-[10px]"
              >
                {tr("сегодня")}
              </text>
            </g>
          )}
          {hovered !== null && (
            <g>
              <line x1={x(hovered)} x2={x(hovered)} y1={PADDING.top} y2={PADDING.top + plotHeight} className="stroke-foreground/40" strokeWidth={1} />
              <circle cx={x(hovered)} cy={y(data.cumulativeTotals[hovered]!)} r={4} className="fill-foreground stroke-background" strokeWidth={2} />
            </g>
          )}
          {data.dates.map((date, index) => {
            const every = Math.max(1, Math.ceil(data.dates.length / 7));
            if (index % every !== 0 && index !== data.dates.length - 1) return null;
            // The first and last labels hug their edge, so neither is cut off by the frame.
            const anchor = index === 0 ? "start" : index === data.dates.length - 1 ? "end" : "middle";
            return (
              <text key={date} x={x(index)} y={HEIGHT - 8} textAnchor={anchor} className="fill-muted-foreground text-[11px]">
                {shortDate(date)}
              </text>
            );
          })}
        </svg>
        {hovered !== null && (
          <div
            className="pointer-events-none absolute top-2 z-10 box-border w-60 rounded-lg border border-border bg-background p-2 shadow-sm"
            // Stands beside the crosshair, on the side with room, so the hovered day stays visible.
            style={{
              left:
                (x(hovered) / WIDTH) * 100 > 50
                  ? `max(0px, calc(${((x(hovered) / WIDTH) * 100).toFixed(1)}% - 15.5rem))`
                  : `min(calc(100% - 15rem), calc(${((x(hovered) / WIDTH) * 100).toFixed(1)}% + 0.5rem))`,
            }}
            role="status"
          >
            <p className="text-xs font-medium">{shortDate(data.dates[hovered]!)}</p>
            <ul className="mt-1 space-y-0.5">
              {data.series.map((series, index) => (
                series.daily[hovered!] ? (
                  <li key={series.key} className="flex items-baseline gap-2 text-xs">
                    <span className={`h-0.5 w-3 shrink-0 rounded-full ${SERIES_SWATCH[index % SERIES_SWATCH.length]}`} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{series.label}</span>
                    <span className="tabular-nums">{formatTokenCount(series.daily[hovered!], true)}</span>
                    <span className="w-10 text-right tabular-nums text-muted-foreground">{sharePercent(series.daily[hovered!]!, data.dailyTotals[hovered!]!)}%</span>
                  </li>
                ) : null
              ))}
            </ul>
            <dl className="mt-1.5 space-y-0.5 border-t border-border pt-1.5 text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">{tr("За день")}</dt>
                <dd className="font-medium tabular-nums">{formatTokenCount(data.dailyTotals[hovered], true)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">{tr("Накоплено")}</dt>
                <dd className="font-medium tabular-nums">{formatTokenCount(data.cumulativeTotals[hovered], true)}</dd>
              </div>
            </dl>
          </div>
        )}
      </div>

      {data.series.length > 1 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {data.series.map((series, index) => (
            <li key={series.key} className="flex items-center gap-1.5">
              <span className={`h-2 w-3 rounded-sm ${SERIES_SWATCH[index % SERIES_SWATCH.length]}`} aria-hidden />
              <span className="truncate">{series.label}</span>
              <span className="tabular-nums">{formatTokenCount(series.total, true)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
