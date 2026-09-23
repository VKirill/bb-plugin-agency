import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { askLaunchEffort, launchPlanState } from "../src/server/decisions/launch-effort";
import { askBriefingDetailed } from "../src/server/decisions/briefing";
import { DEFAULT_DECISION_SETTINGS } from "../src/shared/decisions";

const settings = { ...DEFAULT_DECISION_SETTINGS, enabled: true, points: ["launch-briefing"] };
const levels = ["low", "medium", "high", "xhigh", "max"];
const plan = { title: "Migration", brief: "План\n".repeat(1000) + "CRITICAL_TAIL: rollback 🔧", acceptance: "Критерии\n".repeat(100) + "FINAL_CHECK" };
const reply = (effort = "xhigh", confidence = 0.98) => new Response(JSON.stringify({ answers: { effort: { choice: effort, confidence } } }));

describe("Agency plan-only reasoning selection", () => {
  it("sends the full canonical plan over the real client serializer, without ambient instructions", async () => {
    const requests: any[] = [];
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      if (body.questions.effort) return reply();
      return new Response(JSON.stringify({ answers: { s0: { noul: 0.1 } } }));
    });
    const result = await askBriefingDetailed(settings, {
      job: { key: "AG-1", ...plan, ...{ instructions: "AGENTS_PRIVATE", history: "HISTORY_PRIVATE" } },
      skills: [{ id: "s", name: "SKILL_PRIVATE", description: "SYSTEM_PRIVATE" }], lessons: [],
      askEffort: true, supportedEfforts: levels,
    }, { key: "test", fetch: fetchMock as typeof fetch });
    const effort = requests.find(r => r.questions.effort);
    expect(JSON.parse(effort.state)).toEqual(plan);
    expect(effort.state).toContain("CRITICAL_TAIL");
    expect(effort.state).not.toMatch(/PRIVATE/);
    expect(Object.keys(effort.questions)).toEqual(["effort"]);
    expect(result.effort).toBe("xhigh");
    expect(result.effortTrace).toMatchObject({ planChars: effort.state.length, planHash: createHash("sha256").update(effort.state).digest("hex") });
  });
  it("distinguishes identical prefixes with different tails and retains the job contract", () => {
    expect(launchPlanState(plan)).not.toBe(launchPlanState({ ...plan, brief: plan.brief + "DIFFERENT" }));
    const contract = { mayChange: ["src/**"], mustNotTouch: [], checks: ["tail check"] };
    expect(JSON.parse(launchPlanState({ ...plan, contract })).contract).toEqual(contract);
  });
  it.each(["medium", "high", "xhigh", "max"])("accepts supported %s without downcasting", async effort => {
    expect((await askLaunchEffort(settings, plan, levels, { key: "test", fetch: vi.fn(async () => reply(effort)) })).effort).toBe(effort);
  });
  it("uses only supported choices and rejects an unsupported answer", async () => {
    const result = await askLaunchEffort(settings, plan, ["low", "high"], { key: "test", fetch: vi.fn(async (_url, init) => {
      expect(Object.keys(JSON.parse(String(init?.body)).questions.effort.criteria)).toEqual(["low", "high"]);
      return reply("xhigh");
    }) });
    expect(result).toMatchObject({ effort: null, reason: "bad_answer" });
  });
  it("records disabled, unknown catalog and low confidence without guessing a lower effort", async () => {
    const fetchMock = vi.fn(async () => reply("high", 0.3));
    const deps = { key: "test", fetch: fetchMock };
    expect((await askLaunchEffort({ ...settings, enabled: false }, plan, levels, deps)).reason).toBe("disabled");
    expect((await askLaunchEffort(settings, plan, undefined, deps)).reason).toBe("catalog_unavailable");
    expect((await askLaunchEffort(settings, plan, [], deps)).reason).toBe("unsupported");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await askLaunchEffort(settings, plan, levels, deps)).toMatchObject({ effort: null, reason: "low_confidence" });
  });
  it("records a real API failure and timeout without retrying with a shortened plan", async () => {
    for (const call of [vi.fn(async () => new Response("", { status: 500 })), vi.fn(async () => { throw new DOMException("aborted", "AbortError"); })]) {
      const result = await askLaunchEffort(settings, plan, levels, { key: "test", fetch: call });
      expect(result.effort).toBeNull();
      expect(["request_failed", "timeout"]).toContain(result.reason);
      expect(call).toHaveBeenCalledTimes(1);
    }
  });
});
