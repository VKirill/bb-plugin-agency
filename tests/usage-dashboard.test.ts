import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EMPTY_USAGE_FILTER,
  USAGE_CACHE_SEPARATE,
  USAGE_INCOMPLETE,
  USAGE_NO_COST,
  USAGE_PERIOD_OBSERVED,
  USAGE_UNKNOWN,
  allTimeHeadline,
  coverageLines,
  createUsageFetchGate,
  filteredUsageView,
  groupUsageRows,
  parseDashboardUsage,
  peaksForRows,
  periodHeadline,
  toDisplayRows,
  workspaceJobKey,
  type UsageDisplayRow,
} from "../src/app/data/usage-dashboard";

const livePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../.bb/chats/thr_2sgqe4rmmd/artifacts/programmers-calculator/dashboard-live-582.json",
);

describe("dashboard usage adapter", () => {
  const envelope = JSON.parse(readFileSync(livePath, "utf8")) as unknown;
  const payload = parseDashboardUsage(envelope);

  it("unwraps core {ok,result:{ok,value}} and keeps visible_epoch_peaks", () => {
    expect(payload?.grain).toBe("visible_epoch_peaks");
    expect(payload?.allTime.incomplete).toBe(true);
    expect(payload?.coverage.resetObserved).toBe(true);
    expect(payload?.rows).toHaveLength(6);
  });

  it("shows incomplete all-time as Не менее 24,9 млн, not exact lifetime", () => {
    expect(allTimeHeadline(payload!)).toBe("Не менее 24,9 млн");
    expect(allTimeHeadline(payload!)).not.toBe("24 948 508");
    expect(payload!.allTime.totals?.cachedInputTokens).toBe(24786713);
  });

  it("keeps cache separate and period as observed Fable slice", () => {
    expect(USAGE_CACHE_SEPARATE).toMatch(/отдельно/);
    expect(payload!.allTime.totals?.inputTokens).toBe(1962);
    expect(payload!.allTime.totals?.inputTokens).not.toBe(
      (payload!.allTime.totals?.inputTokens ?? 0) + (payload!.allTime.totals?.cachedInputTokens ?? 0),
    );
    expect(periodHeadline(payload!)).toBe("2 549 105");
    expect(USAGE_PERIOD_OBSERVED).toMatch(/восстановить/);
    expect(USAGE_NO_COST).toBe("Нет цены");
    expect(coverageLines(payload!.coverage).join(" ")).toContain(USAGE_INCOMPLETE);
    expect(coverageLines(payload!.coverage).join(" ")).not.toMatch(/lifetime|видимые пики/i);
  });

  it("recomputes headlines from the same filter as the table", () => {
    const fable = filteredUsageView(payload!, {
      ...EMPTY_USAGE_FILTER,
      model: "claude-code/claude-fable-5-1",
    });
    const whole = filteredUsageView(payload!, EMPTY_USAGE_FILTER);
    expect(whole.availableLabel).toBe("Не менее 24,9 млн");
    expect(fable.availableTotals?.totalTokens).toBe(6697149);
    expect(fable.availableLabel).not.toBe(whole.availableLabel);
    expect(fable.periodLabel).toBe("2 549 105");
    const emptyDays = filteredUsageView(payload!, { ...EMPTY_USAGE_FILTER, fromDate: "2020-01-01", toDate: "2020-01-02" });
    expect(emptyDays.periodLabel).toBe("За выбранный период данных нет.");
    expect(emptyDays.availableLabel).toBe(whole.availableLabel);
  });

  it("does not draw unknown units as zero", () => {
    const rows = toDisplayRows(payload!.rows);
    const empty = rows.find((row) => row.unknownReason === "empty");
    expect(empty?.units).toBeNull();
    expect(empty?.unknown).toBe(true);
    const peaks = peaksForRows(rows);
    expect(peaks?.totalTokens).toBe(24948508);
    expect(coverageLines(payload!.coverage).join(" ")).toContain("1 неизвестно");
    expect(USAGE_UNKNOWN).toBe("Неизвестно");
  });

  it("covers the same filter as headlines, not the whole payload", () => {
    const fable = filteredUsageView(payload!, {
      ...EMPTY_USAGE_FILTER,
      model: "claude-code/claude-fable-5-1",
    });
    const text = coverageLines(fable.coverage).join(" ");
    expect(text).toContain("1 задач · 2 попыток · 2 тредов");
    expect(text).not.toContain("5 задач");
    expect(text).not.toContain("6 попыток");
    expect(text).not.toMatch(/эпох/);
    expect(coverageLines(filteredUsageView(payload!, EMPTY_USAGE_FILTER).coverage).join(" ")).toContain("6 эпох");
  });

  it("intersects period days with exact filtered threads when root is set", () => {
    const extra = {
      ...payload!,
      period: {
        ...payload!.period,
        days: [
          ...payload!.period.days,
          {
            date: "2026-09-14",
            threadId: "thr_foreign_other_root",
            bbProjectId: "proj_ejbam66722",
            departmentId: "dep_dfebd1ffe3ad9809fe4ee1a0",
            model: "claude-fable-5-1",
            modelSource: "snapshot" as const,
            inputTokens: 9,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 9,
          },
        ],
      },
    };
    const byRoot = filteredUsageView(extra, {
      ...EMPTY_USAGE_FILTER,
      rootJobId: "job_48f521b219595a2042d992da",
    });
    expect(byRoot.days.map((day) => day.threadId)).toEqual(["thr_uu5jukubj5"]);
    expect(byRoot.days.every((day) => day.totalTokens !== 9)).toBe(true);
    const wide = filteredUsageView(extra, EMPTY_USAGE_FILTER);
    expect(wide.days).toHaveLength(2);
  });

  it("dedups peaks by thread and does not count a null thread as a thread", () => {
    const units = {
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
      totalTokens: 11,
    };
    const shared = displayRow({ attemptId: "run_a", threadId: "thr_same", units });
    const duplicate = displayRow({ attemptId: "run_b", threadId: "thr_same", units: { ...units, totalTokens: 99 } });
    expect(peaksForRows([shared, duplicate])?.totalTokens).toBe(11);
    const orphanA = displayRow({ attemptId: "run_c", threadId: null, units });
    const orphanB = displayRow({ attemptId: "run_d", threadId: null, units });
    expect(peaksForRows([orphanA, orphanB])?.totalTokens).toBe(22);
    const grouped = groupUsageRows([orphanA, orphanB, shared], "root");
    expect(grouped[0]?.threadCount).toBe(1);
    expect(grouped[0]?.unknownThreads).toBe(0);
    const unknownOrphan = displayRow({ attemptId: "run_e", threadId: null, unknown: true, units: null });
    expect(groupUsageRows([unknownOrphan], "root")[0]?.threadCount).toBe(0);
    expect(groupUsageRows([unknownOrphan], "root")[0]?.unknownThreads).toBe(0);
  });

  it("remounts the fetch gate after StrictMode cleanup", () => {
    const gate = createUsageFetchGate();
    const first = gate.begin();
    gate.unmount();
    expect(gate.isMounted()).toBe(false);
    expect(gate.accept(first)).toBe(false);
    gate.mount();
    expect(gate.isMounted()).toBe(true);
    expect(gate.accept(first)).toBe(false);
    const second = gate.begin();
    expect(gate.accept(second)).toBe(true);
  });

  it("maps opaque root id to the workspace key", () => {
    expect(workspaceJobKey({
      jobs: {
        job_48f521b219595a2042d992da: { key: "AG-2201", title: "Калькулятор" },
      },
    }, "job_48f521b219595a2042d992da")).toBe("AG-2201");
    expect(workspaceJobKey(undefined, "job_48f521b219595a2042d992da")).toBe("job_48f521b219595a2042d992da");
  });
});

function displayRow(partial: Partial<UsageDisplayRow> & Pick<UsageDisplayRow, "attemptId">): UsageDisplayRow {
  return {
    jobId: "job_child",
    jobKey: "AG-CHILD",
    jobTitle: "child",
    rootJobId: "job_root",
    rootTitle: "root",
    threadId: "thr_x",
    projectId: "proj_1",
    projectName: "p",
    departmentId: "dep_1",
    departmentName: "d",
    providerId: "claude-code",
    model: "claude-fable-5-1",
    attemptState: "succeeded",
    unknown: false,
    unknownReason: null,
    resetObserved: false,
    units: {
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 1,
    },
    sessionLatestTotal: null,
    costUsdCents: null,
    ...partial,
  };
}
