import { describe, expect, it } from "vitest";
import { createDashboardUsageEventPort } from "../src/server/api/dashboard-usage-rpc";

type EventPort = Parameters<typeof createDashboardUsageEventPort>[0];
type EventRow = Awaited<ReturnType<EventPort["list"]>>[number];
function usage(seq: number, threadId = "thr_bound"): EventRow {
  const units = { inputTokens: 10, cachedInputTokens: 20, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 35 };
  return {
    id: `evt_${seq}`, threadId, seq, createdAt: 1789395422171,
    scope: { kind: "turn", turnId: `turn_${seq}` },
    type: "thread/tokenUsage/updated",
    data: { providerThreadId: "provider_bound", tokenUsage: { last: units, total: units, modelContextWindow: null } },
  };
}

describe("dashboard SDK usage port", () => {
  it("paginates only usage events of the exact thread", async () => {
    const calls: Parameters<EventPort["list"]>[0][] = [];
    const port = createDashboardUsageEventPort({ async list(input) {
      calls.push(input);
      return input.afterSeq ? [usage(101)] : Array.from({ length: 100 }, (_, i) => usage(i + 1));
    } });
    expect(await port.listUpdated("thr_bound")).toHaveLength(101);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ threadId: "thr_bound", types: ["thread/tokenUsage/updated"], order: "asc", limit: "100" });
    expect(calls[1].afterSeq).toBe("100");
  });
  it("does not return another thread's events or a partial page on failure", async () => {
    const wrong = createDashboardUsageEventPort({ async list() { return [usage(1, "thr_other")]; } });
    expect(await wrong.listUpdated("thr_bound")).toBe("unavailable");
    const failed = createDashboardUsageEventPort({ async list(input) {
      if (input.afterSeq) throw new Error("private-provider-detail");
      return Array.from({ length: 100 }, (_, i) => usage(i + 1));
    } });
    expect(await failed.listUpdated("thr_bound")).toBe("unavailable");
  });
  it("stops when pagination does not advance", async () => {
    let calls = 0;
    const port = createDashboardUsageEventPort({ async list() {
      calls += 1;
      return Array.from({ length: 100 }, (_, i) => usage(i + 1));
    } });
    expect(await port.listUpdated("thr_bound")).toBe("unavailable");
    expect(calls).toBe(2);
  });
});
