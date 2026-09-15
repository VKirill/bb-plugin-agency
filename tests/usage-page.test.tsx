/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode, act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgencyApi } from "../src/app/data/agency-api";
import { UsagePage } from "../src/app/prototype/usage-page";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRealtime: () => undefined,
}));

function usageValue() {
  return {
    grain: "visible_epoch_peaks" as const,
    totals: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1_000_000 },
    allTime: {
      grain: "visible_epoch_peaks" as const,
      totals: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1_000_000 },
      incomplete: true as const,
    },
    period: { grain: "epoch_proven_day_deltas" as const, available: false, days: [] },
    costUsdCents: null,
    coverage: {
      jobCount: 1,
      attemptCount: 1,
      uniqueThreadCount: 1,
      attemptsWithoutThread: 0,
      threadsWithUsage: 1,
      threadsUnknown: 0,
      epochCount: 1,
      lifetimeIncomplete: true,
      dayHistoryIncomplete: true,
      dayHistoryReasons: [],
      dayChart: "omitted" as const,
      resetObserved: false,
    },
    days: [],
    rows: [{
      attemptId: "run_abcdefgh",
      jobId: "job_abcdefgh",
      rootJobId: "job_abcdefgh",
      threadId: "thr_abcdefgh",
      attemptState: "succeeded",
      bbProjectId: null,
      departmentId: null,
      providerId: "claude-code",
      model: "claude-fable-5-1",
      modelSource: "snapshot",
      units: {
        unknown: false,
        source: "thread/tokenUsage/updated.visible_epoch_peaks",
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 1_000_000,
      },
      sessionLatestTotal: null,
      resetObserved: false,
      costUsdCents: null,
    }],
  };
}

describe("UsagePage", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows data after StrictMode setup→cleanup→setup remounts the fetch gate", async () => {
    const pending: Array<(value: unknown) => void> = [];
    const listDashboardUsage = vi.fn(
      () => new Promise((resolve) => {
        pending.push(resolve);
      }),
    );
    const api = { listDashboardUsage } as unknown as AgencyApi;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(
        StrictMode,
        null,
        createElement(UsagePage, {
          api,
          jobs: [],
          projects: [],
          departments: [],
          openJob: () => undefined,
        }),
      ) as ReactNode);
    });
    expect(listDashboardUsage.mock.calls.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      const value = usageValue();
      for (const resolve of pending.splice(0)) resolve({ ok: true, value });
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="usage-all-time"]')?.textContent).toBe("Не менее 1,0 млн");
    expect(container.textContent).not.toContain("Загружаем расход…");
    await act(async () => { root.unmount(); });
  });
});
