import { useEffect, useMemo, useRef, useState } from "react";
import type { DashboardUsageDay } from "../../shared/contracts/dashboard-usage";
import {
  CHART_DIMENSIONS,
  CHART_PERIODS,
  clipLabel,
  compactTokens,
  niceTicks,
  sharePercent,
  spreadLabels,
  usageChartData,
  type ChartDimension,
} from "../data/usage-chart";
import { formatTokenCount, type UsageCatalogNames } from "../data/usage-dashboard";
import { tr, uiLocale } from "../i18n";

/**
 * Cumulative spend of the period: one stacked band per model (or department, or project),
 * growing left to right. Names sit on the bands themselves, the crosshair reads the day under
 * the pointer, and every number it shows is also in the tables of the dashboard.
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
const SERIES_STROKE = [
  "stroke-[#2a78d6] dark:stroke-[#3987e5]",
  "stroke-[#eb6834] dark:stroke-[#d95926]",
  "stroke-[#1baf7a] dark:stroke-[#199e70]",
  "stroke-[#eda100] dark:stroke-[#c98500]",
  "stroke-[#e87ba4] dark:stroke-[#d55181]",
  "stroke-[#008300] dark:stroke-[#008300]",
  "stroke-[#4a3aa7] dark:stroke-[#9085e9]",
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

const HEIGHT = 280;
const FALLBACK_WIDTH = 720;
const LABEL_LANE = 132;
const PADDING = { top: 18, right: 16, bottom: 30, left: 60 };
/** A band thinner than this has no room for its name; the tooltip still names it. */
const MIN_LABEL_BAND = 13;

function shortDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString(uiLocale(), { day: "2-digit", month: "short", timeZone: "UTC" });
}

/** The svg is drawn at its real pixel size, so 11px text stays 11px however wide the panel is. */
function useMeasuredWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const read = () => setWidth(Math.max(320, Math.round(node.getBoundingClientRect().width)));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

export function UsageAreaChart({
  days,
  names,
  dimension,
  onDimension,
  period,
  onPeriod,
}: {
  days: readonly DashboardUsageDay[];
  names?: UsageCatalogNames;
  dimension: ChartDimension;
  onDimension: (next: ChartDimension) => void;
  /** Days of the chosen window, or null for everything there is. */
  period?: number | null;
  onPeriod?: (next: number | null) => void;
}) {
  const data = useMemo(() => usageChartData(days, dimension, names), [days, dimension, names]);
  const [active, setActive] = useState<number | null>(null);
  const { ref, width } = useMeasuredWidth();
  const ticks = niceTicks(data.max);
  const top = ticks[ticks.length - 1] || 1;
  const labelLane = data.series.length > 1 ? LABEL_LANE : 0;
  const plotWidth = Math.max(120, width - PADDING.left - PADDING.right - labelLane);
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
    const line = upper.map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
    const back = [...lower].reverse().map((value, index) => `L${x(lower.length - 1 - index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
    const last = data.dates.length - 1;
    return {
      series,
      path: `${line} ${back} Z`,
      line,
      /** Where the name goes: the middle of the band on the last day. */
      anchor: (y(upper[last] ?? 0) + y(lower[last] ?? 0)) / 2,
      thickness: Math.abs(y(lower[last] ?? 0) - y(upper[last] ?? 0)),
    };
  });
  const labelled = bands.map((band, index) => ({ band, index })).filter((item) => item.band.thickness >= MIN_LABEL_BAND);
  const labelYs = spreadLabels(labelled.map((item) => item.band.anchor), 15, PADDING.top, PADDING.top + plotHeight);

  const today = new Date().toISOString().slice(0, 10);
  const todayIndex = data.dates.indexOf(today);
  const hovered = active !== null && active >= 0 && active < data.dates.length ? active : null;

  const move = (event: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width || !data.dates.length) return;
    const local = ((event.clientX - box.left) / box.width) * width;
    const index = data.dates.length > 1 ? Math.round((local - PADDING.left) / stepX) : 0;
    setActive(Math.max(0, Math.min(data.dates.length - 1, index)));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{tr("Расход по дням")}</h2>
          <p className="text-xs text-muted-foreground">{tr("Накопительно за период, {dimension}", { dimension: tr(DIMENSION_LABEL[dimension]) })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onPeriod && (
            <div className="flex items-center rounded-md border border-border p-0.5" role="group" aria-label={tr("Период")}>
              {CHART_PERIODS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={period === value}
                  className={`appearance-none rounded border-0 px-2 py-1 text-xs shadow-none ${period === value ? "bg-muted font-medium text-foreground" : "bg-transparent text-muted-foreground hover:text-foreground"}`}
                  onClick={() => onPeriod(value)}
                >
                  {tr("{days} дн.", { days: value })}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={period === null}
                className={`appearance-none rounded border-0 px-2 py-1 text-xs shadow-none ${period === null ? "bg-muted font-medium text-foreground" : "bg-transparent text-muted-foreground hover:text-foreground"}`}
                onClick={() => onPeriod(null)}
              >
                {tr("Всё")}
              </button>
            </div>
          )}
          <select
            aria-label={tr("Разрез графика")}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
            value={dimension}
            onChange={(event) => onDimension(event.target.value as ChartDimension)}
          >
            {CHART_DIMENSIONS.map((value) => (
              <option key={value} value={value}>{tr(DIMENSION_LABEL[value])}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="relative" ref={ref}>
        <svg
          viewBox={`0 0 ${width} ${HEIGHT}`}
          width={width}
          height={HEIGHT}
          className="block w-full touch-none"
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
              <line x1={PADDING.left} x2={PADDING.left + plotWidth} y1={y(tick)} y2={y(tick)} className="stroke-border" strokeWidth={1} />
              <text x={PADDING.left - 10} y={y(tick) + 4} textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
                {compactTokens(tick)}
              </text>
            </g>
          ))}
          {bands.map((band, index) => (
            // A 2px stroke in the surface colour is the gap between touching bands.
            <path
              key={`band-${band.series.key}`}
              d={band.path}
              className={`${SERIES_FILL[index % SERIES_FILL.length]} stroke-background`}
              strokeWidth={2}
              fillOpacity={0.9}
            />
          ))}
          {bands.map((band, index) => (
            <path
              key={`line-${band.series.key}`}
              d={band.line}
              fill="none"
              className={SERIES_STROKE[index % SERIES_STROKE.length]}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {labelled.map((item, order) => (
            <g key={`label-${item.band.series.key}`} transform={`translate(${(PADDING.left + plotWidth + 10).toFixed(1)},${(labelYs[order] ?? item.band.anchor).toFixed(1)})`}>
              <rect x={0} y={-4} width={8} height={8} rx={2} className={SERIES_FILL[item.index % SERIES_FILL.length]} />
              <text x={13} y={4} className="fill-foreground text-[11px]">{clipLabel(item.band.series.label, 15)}</text>
            </g>
          ))}
          {todayIndex >= 0 && (
            <g>
              <line x1={x(todayIndex)} x2={x(todayIndex)} y1={PADDING.top} y2={PADDING.top + plotHeight} className="stroke-muted-foreground" strokeWidth={1} strokeDasharray="4 3" />
              <text
                x={x(todayIndex)}
                y={PADDING.top - 6}
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
            const every = Math.max(1, Math.ceil(data.dates.length / Math.max(2, Math.floor(plotWidth / 90))));
            if (index % every !== 0 && index !== data.dates.length - 1) return null;
            // The first and last labels hug their edge, so neither is cut off by the frame.
            const anchor = index === 0 ? "start" : index === data.dates.length - 1 ? "end" : "middle";
            return (
              <text key={date} x={x(index)} y={HEIGHT - 10} textAnchor={anchor} className="fill-muted-foreground text-[11px]">
                {shortDate(date)}
              </text>
            );
          })}
        </svg>
        {hovered !== null && (
          <div
            // Stands beside the crosshair, on the side with room, so the hovered day stays visible.
            className="pointer-events-none absolute top-2 z-10 box-border w-60 rounded-lg border border-border bg-background p-2 shadow-sm"
            style={{
              left: x(hovered) > width / 2
                ? `max(0px, ${(x(hovered) - 248).toFixed(0)}px)`
                : `min(calc(100% - 15rem), ${(x(hovered) + 8).toFixed(0)}px)`,
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
    </div>
  );
}
