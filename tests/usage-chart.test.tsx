/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DashboardUsageDay } from "../src/shared/contracts/dashboard-usage";
import {
  MAX_CHART_SERIES,
  activePeriod,
  clipLabel,
  niceTicks,
  periodRange,
  sharePercent,
  spreadLabels,
  usageChartData,
} from "../src/app/data/usage-chart";
import { UsageAreaChart } from "../src/app/prototype/usage-chart";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function day(date: string, model: string, totalTokens: number, extra: Partial<DashboardUsageDay> = {}): DashboardUsageDay {
  return {
    date,
    model,
    totalTokens,
    inputTokens: Math.round(totalTokens * 0.1),
    cachedInputTokens: Math.round(totalTokens * 0.8),
    outputTokens: Math.round(totalTokens * 0.1),
    reasoningOutputTokens: 0,
    threadId: `thr_${model}${date}`,
    bbProjectId: "proj_a",
    departmentId: "dep_a",
    modelSource: "snapshot",
    ...extra,
  } as DashboardUsageDay;
}

describe("usage chart data", () => {
  it("stacks days into cumulative series and keeps the daily numbers", () => {
    const data = usageChartData(
      [day("2026-09-14", "opus", 100), day("2026-09-14", "grok", 50), day("2026-09-15", "opus", 30)],
      "model",
    );
    expect(data.dates).toEqual(["2026-09-14", "2026-09-15"]);
    expect(data.series.map((series) => series.key)).toEqual(["opus", "grok"]);
    expect(data.series[0]?.daily).toEqual([100, 30]);
    expect(data.series[0]?.cumulative).toEqual([100, 130]);
    // A series with no work that day keeps the level it had reached.
    expect(data.series[1]?.cumulative).toEqual([50, 50]);
    expect(data.dailyTotals).toEqual([150, 30]);
    expect(data.cumulativeTotals).toEqual([150, 180]);
    expect(data.max).toBe(180);
  });

  it("folds the tail into «Другое» instead of inventing a seventh colour", () => {
    const days = Array.from({ length: MAX_CHART_SERIES + 3 }, (_, index) => day("2026-09-14", `model-${index}`, 100 - index));
    const data = usageChartData(days, "model");
    expect(data.series).toHaveLength(MAX_CHART_SERIES + 1);
    expect(data.series.at(-1)?.label).toBe("Другое");
    expect(data.series.at(-1)?.total).toBe(100 - MAX_CHART_SERIES + (100 - MAX_CHART_SERIES - 1) + (100 - MAX_CHART_SERIES - 2));
    expect(data.cumulativeTotals.at(-1)).toBe(days.reduce((sum, row) => sum + row.totalTokens, 0));
  });

  it("splits by department with catalog names", () => {
    const data = usageChartData(
      [day("2026-09-14", "opus", 10, { departmentId: "dep_dev" }), day("2026-09-14", "grok", 4, { departmentId: null })],
      "department",
      { departments: { dep_dev: "Разработка" } },
    );
    expect(data.series.map((series) => series.label)).toEqual(["Разработка", "Не указано"]);
  });

  it("rounds axis ticks and shares", () => {
    expect(niceTicks(180)).toEqual([0, 50, 100, 150, 200]);
    expect(niceTicks(0)).toEqual([0]);
    expect(sharePercent(1, 3)).toBe(33.3);
    expect(sharePercent(1, 0)).toBe(0);
  });

  it("pushes crowded labels apart without leaving the plot", () => {
    // Three bands of almost the same height: their middles are one line apart.
    expect(spreadLabels([100, 104, 108], 15, 0, 200)).toEqual([100, 115, 130]);
    // Anchored at the bottom edge: the stack walks back up instead of hanging below it.
    expect(spreadLabels([196, 198], 15, 0, 200)).toEqual([185, 200]);
    expect(spreadLabels([], 15, 0, 200)).toEqual([]);
  });

  it("clips long names", () => {
    expect(clipLabel("grok-4.6", 15)).toBe("grok-4.6");
    expect(clipLabel("claude-fable-5-1", 15)).toBe("claude-fable-5…");
  });

  it("reads the window off the filter dates", () => {
    const today = new Date("2026-09-17T10:00:00Z");
    expect(periodRange(7, today)).toEqual({ fromDate: "2026-09-11", toDate: "2026-09-17" });
    expect(activePeriod(periodRange(30, today), today)).toBe(30);
    expect(activePeriod({ fromDate: "", toDate: "" }, today)).toBeNull();
    // A hand-picked range is not a preset: no button is lit.
    expect(activePeriod({ fromDate: "2026-09-01", toDate: "2026-09-05" }, today)).toBeNull();
  });
});

describe("UsageAreaChart", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("draws a band per series and answers the pointer with that day's numbers", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const days = [day("2026-09-14", "opus", 100), day("2026-09-14", "grok", 100), day("2026-09-15", "opus", 200)];
    await act(async () => {
      root.render(createElement(UsageAreaChart, { days, dimension: "model", onDimension: () => undefined }) as ReactNode);
    });
    const svg = container.querySelector('[data-testid="usage-day-chart"]') as SVGSVGElement;
    // Every series draws its band and the line on top of it.
    expect(svg.querySelectorAll("path")).toHaveLength(4);
    expect(svg.querySelectorAll('path[fill="none"]')).toHaveLength(2);
    // Names stand on the bands themselves, not in a legend under the chart.
    expect(svg.textContent).toContain("opus");
    expect(svg.textContent).toContain("grok");

    svg.getBoundingClientRect = () => ({ left: 0, width: 720, top: 0, height: 240, right: 720, bottom: 240, x: 0, y: 0, toJSON: () => ({}) });
    await act(async () => {
      svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 700, clientY: 100 }));
    });
    const tooltip = container.querySelector('[role="status"]');
    expect(tooltip?.textContent).toContain("За день");
    expect(tooltip?.textContent).toContain("Накоплено");
    // The last date: opus spent 200 that day, grok nothing, so grok is not listed.
    expect(tooltip?.textContent).toContain("opus");
    expect(tooltip?.textContent).not.toContain("grok 0");
    await act(async () => {
      // React synthesises pointerleave out of pointerout, so that is what the pointer sends.
      svg.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: null }));
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => root.unmount());
  });
});
