/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode, act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgencyApi } from "../src/app/data/agency-api";
import { UsageRootSummary } from "../src/app/prototype/usage-root-summary";

let domainChanged: ((payload: unknown) => void) | undefined;

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRealtime: (channel: string, handler: (payload: unknown) => void) => {
    if (channel === "domain-changed") domainChanged = handler;
  },
}));

describe("UsageRootSummary", () => {
  afterEach(() => {
    domainChanged = undefined;
    document.body.innerHTML = "";
  });

  it("swallows thrown RPC and refreshes on revision and realtime", async () => {
    const listDashboardUsage = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({
        ok: true,
        value: {
          grain: "visible_epoch_peaks",
          totals: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1_000_000 },
          allTime: {
            grain: "visible_epoch_peaks",
            totals: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1_000_000 },
            incomplete: true,
          },
          period: { grain: "epoch_proven_day_deltas", available: false, days: [] },
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
            dayChart: "omitted",
            resetObserved: false,
          },
          days: [],
          rows: [],
        },
      });
    const api = { listDashboardUsage } as unknown as AgencyApi;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(UsageRootSummary, {
        api,
        rootJobId: "job_48f521b219595a2042d992da",
        revision: 1,
        openUsage: () => undefined,
      }) as ReactNode);
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="usage-root-summary"]')).toBeNull();

    await act(async () => {
      root.render(createElement(UsageRootSummary, {
        api,
        rootJobId: "job_48f521b219595a2042d992da",
        revision: 2,
        openUsage: () => undefined,
      }) as ReactNode);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Не менее 1,0 млн");

    await act(async () => {
      domainChanged?.({});
      await Promise.resolve();
    });
    expect(listDashboardUsage.mock.calls.length).toBeGreaterThanOrEqual(3);
    await act(async () => { root.unmount(); });
  });

  it("shows the headline after StrictMode setup→cleanup→setup remounts the fetch gate", async () => {
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
        createElement(UsageRootSummary, {
          api,
          rootJobId: "job_48f521b219595a2042d992da",
          revision: 1,
          openUsage: () => undefined,
        }),
      ) as ReactNode);
    });
    expect(listDashboardUsage.mock.calls.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      const value = {
        grain: "visible_epoch_peaks",
        totals: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1_000_000 },
        allTime: {
          grain: "visible_epoch_peaks",
          totals: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1_000_000 },
          incomplete: true,
        },
        period: { grain: "epoch_proven_day_deltas", available: false, days: [] },
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
          dayChart: "omitted",
          resetObserved: false,
        },
        days: [],
        rows: [],
      };
      for (const resolve of pending.splice(0)) resolve({ ok: true, value });
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Не менее 1,0 млн");
    await act(async () => { root.unmount(); });
  });
});
