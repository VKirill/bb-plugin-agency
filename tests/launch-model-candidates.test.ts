import { describe, expect, it } from "vitest";
import { fail, ok, type DomainResult } from "../src/domain";
import type { LaunchCandidate } from "../src/server/runtime/agent-fallback";
import {
  fallbackLaunchText,
  launchOnFirstReadyCandidate,
  refusalBelongsToCandidate,
} from "../src/server/runtime/prepare-run/model-candidates";

const primary: LaunchCandidate = { source: "primary", providerId: "codex", model: "gpt-5.4", exhausted: false };
const reserve1: LaunchCandidate = { source: "fallback 1", providerId: "opencode", model: "gemini-3.8-flash", exhausted: false };
const reserve2: LaunchCandidate = { source: "fallback 2", providerId: "claude-code", model: "claude-sonnet-5", exhausted: false };

type Spawned = { threadId: string | null; refusal?: { code: string; message: string } };

function walk(input: {
  candidates: LaunchCandidate[];
  check?: Record<string, DomainResult<void>>;
  launch?: Record<string, DomainResult<Spawned>>;
}) {
  const checked: string[] = [];
  const launchedOn: { model: string; position: number }[] = [];
  const run = launchOnFirstReadyCandidate<Spawned>({
    candidates: input.candidates,
    check: async (candidate) => {
      checked.push(candidate.model);
      return input.check?.[candidate.model] ?? ok(undefined);
    },
    launch: async (candidate, position) => {
      launchedOn.push({ model: candidate.model, position });
      return input.launch?.[candidate.model] ?? ok({ threadId: `thr_${candidate.model}` });
    },
    spawnRefusal: (value) => (value.threadId ? null : (value.refusal ?? null)),
  });
  return run.then((result) => ({ ...result, checked, launchedOn }));
}

describe("launch walks the employee's models", () => {
  it("starts on the primary and never looks at the reserves when it is ready", async () => {
    const result = await walk({ candidates: [primary, reserve1, reserve2] });
    expect(result.used?.source).toBe("primary");
    expect(result.tried).toEqual([]);
    expect(result.checked).toEqual(["gpt-5.4"]);
    expect(result.launchedOn).toEqual([{ model: "gpt-5.4", position: 0 }]);
  });

  it("takes the first reserve that passes readiness when the primary model is not on the machine", async () => {
    const result = await walk({
      candidates: [primary, reserve1, reserve2],
      check: {
        "gpt-5.4": fail("model_unavailable", "Модели gpt-5.4 нет в каталоге машины."),
        "gemini-3.8-flash": fail("provider_cli_missing", "На машине не установлен CLI opencode."),
      },
    });
    expect(result.result.ok).toBe(true);
    expect(result.used?.source).toBe("fallback 2");
    expect(result.tried.map((item) => item.error.code)).toEqual(["model_unavailable", "provider_cli_missing"]);
    // Refused pairs never reached prepare: the only attempt is the one that started.
    expect(result.launchedOn).toEqual([{ model: "claude-sonnet-5", position: 0 }]);
    const text = fallbackLaunchText({ jobKey: "AG-1", tried: result.tried, used: result.used! });
    expect(text).toContain("codex / gpt-5.4");
    expect(text).toContain("claude-code / claude-sonnet-5");
  });

  it("moves to a reserve when BB refused the spawn for this CLI and no thread exists", async () => {
    const result = await walk({
      candidates: [primary, reserve1],
      launch: { "gpt-5.4": ok({ threadId: null, refusal: { code: "spawn_rejected", message: "usage limit reached for this subscription window" } }) },
    });
    expect(result.used?.source).toBe("fallback 1");
    expect(result.launchedOn).toEqual([
      { model: "gpt-5.4", position: 0 },
      { model: "gemini-3.8-flash", position: 1 },
    ]);
  });

  it("does not switch models on an unknown spawn outcome or a refusal that is not about the model", async () => {
    // Unknown transport: a thread may exist. The caller reports no refusal, the walk stops there.
    const unknown = await walk({ candidates: [primary, reserve1], launch: { "gpt-5.4": ok({ threadId: null }) } });
    expect(unknown.used?.source).toBe("primary");
    expect(unknown.launchedOn).toHaveLength(1);

    const offline = await walk({ candidates: [primary, reserve1], check: { "gpt-5.4": fail("host_offline", "Машина не в сети.") } });
    expect(offline.result.ok).toBe(false);
    if (!offline.result.ok) expect(offline.result.error.code).toBe("host_offline");
    expect(offline.checked).toEqual(["gpt-5.4"]);

    const limit = await walk({ candidates: [primary, reserve1], launch: { "gpt-5.4": fail("concurrency_limit", "Лимит одновременных запусков.") } });
    if (!limit.result.ok) expect(limit.result.error.code).toBe("concurrency_limit");
    expect(limit.launchedOn).toHaveLength(1);

    const active = await walk({ candidates: [primary, reserve1], launch: { "gpt-5.4": fail("active_attempt_exists", "job already has an active attempt") } });
    if (!active.result.ok) expect(active.result.error.code).toBe("active_attempt_exists");
    expect(active.launchedOn).toHaveLength(1);
  });

  it("keeps the refusal exactly as before when there are no reserves", async () => {
    const refusal = fail("model_unavailable", "Модели gpt-5.4 нет в каталоге машины.");
    const result = await walk({ candidates: [primary], check: { "gpt-5.4": refusal } });
    expect(result.result).toBe(refusal);
    expect(result.used).toBeNull();
  });

  it("names every tried model when none starts; the queue waits only while a refusal may pass", async () => {
    const permanent = await walk({
      candidates: [primary, reserve1],
      check: {
        "gpt-5.4": fail("model_unavailable", "Модели gpt-5.4 нет."),
        "gemini-3.8-flash": fail("provider_disabled", "CLI opencode выключен для машины."),
      },
    });
    expect(permanent.result.ok).toBe(false);
    if (!permanent.result.ok) {
      expect(permanent.result.error.code).toBe("fallback_models_refused");
      expect(permanent.result.error.message).toContain("codex / gpt-5.4");
      expect(permanent.result.error.message).toContain("opencode / gemini-3.8-flash");
    }
    expect(permanent.launchedOn).toEqual([]);

    const passing = await walk({
      candidates: [primary, reserve1],
      check: {
        "gpt-5.4": fail("provider_unavailable", "CLI codex сейчас недоступен."),
        "gemini-3.8-flash": fail("model_unavailable", "Модели нет."),
      },
    });
    if (!passing.result.ok) expect(passing.result.error.code).toBe("provider_unavailable");
  });

  it("knows which refusals belong to one CLI/model pair", () => {
    for (const code of ["provider_unavailable", "provider_cli_missing", "provider_cli_unsupported", "provider_disabled", "model_unavailable", "provider_constraint_mismatch"]) {
      expect(refusalBelongsToCandidate({ code, message: "" })).toBe(true);
    }
    expect(refusalBelongsToCandidate({ code: "spawn_rejected", message: "Subscription window exhausted" })).toBe(true);
    for (const code of ["host_offline", "host_unavailable", "revision_conflict", "active_attempt_exists", "spawn_transport"]) {
      expect(refusalBelongsToCandidate({ code, message: "socket hang up" })).toBe(false);
    }
  });
});
