import { describe, expect, it } from "vitest";
import { bindOfficialThreads } from "../src/server/runtime/isolated-sdk/bind-official-threads";
import {
  OFFICIAL_LIST_HAS_CALLER_LAUNCH,
  OFFICIAL_SPAWN_HAS_CALLER_LAUNCH,
  officialSdkAllowsIsolatedSpawn,
} from "../src/server/runtime/isolated-sdk/sdk-isolation-contract";
import type { IsolatedThreadSpawnArgs } from "../src/server/runtime/isolated-sdk/sdk-isolation-contract";

function spawnArgs(): IsolatedThreadSpawnArgs {
  return {
    projectId: "proj_trusted",
    providerId: "claude-code",
    model: "sonnet",
    prompt: "Собрать карточку.",
    environment: {
      type: "host",
      hostId: "host_mini",
      workspace: { type: "unmanaged", path: "/tmp/agy-bind" },
    },
    isolatedSkillDelivery: true,
    skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
    visibility: "hidden",
    experimental_callerLaunchId: "11111111-1111-4111-8111-111111111111",
    experimental_callerAttemptId: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
    experimental_callerJobId: "job_aaaaaaaaaaaaaaaaaaaaaaaa",
  };
}

describe("bindOfficialThreads typed pin", () => {
  it("compile pin exposes caller launch on spawn and list", () => {
    expect(OFFICIAL_SPAWN_HAS_CALLER_LAUNCH).toBe(true);
    expect(OFFICIAL_LIST_HAS_CALLER_LAUNCH).toBe(true);
    expect(officialSdkAllowsIsolatedSpawn()).toBe(true);
  });

  it("calls threads.spawn and list with experimental_caller fields and no extra keys", async () => {
    const spawned: unknown[] = [];
    const listed: unknown[] = [];
    const threads = {
      async spawn(args: unknown) {
        spawned.push(args);
        return { id: "thr_bound01" };
      },
      async get() {
        return { id: "thr_bound01", status: "idle" };
      },
      async list(args: unknown) {
        listed.push(args);
        return { threads: [{ id: "thr_bound01", experimental_callerLaunchId: "11111111-1111-4111-8111-111111111111" }] };
      },
    };
    const bound = bindOfficialThreads(threads as never);
    const created = await bound.spawn(spawnArgs());
    expect(created.id).toBe("thr_bound01");
    expect(spawned).toHaveLength(1);
    const first = spawned[0] as Record<string, unknown>;
    expect(first.experimental_callerLaunchId).toBe("11111111-1111-4111-8111-111111111111");
    expect(first.experimental_callerAttemptId).toBe("run_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(first.experimental_callerJobId).toBe("job_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(first.isolatedSkillDelivery).toBe(true);
    expect(first.visibility).toBe("hidden");
    expect(first.prompt).toBe("Собрать карточку.");
    expect(first.providerId).toBe("claude-code");
    expect(first.model).toBe("sonnet");
    expect(first.reasoningLevel).toBeUndefined();
    expect(first.executionInputSources).toEqual({
      providerId: "explicit",
      model: "explicit",
    });

    const rows = await bound.list({
      experimental_callerLaunchId: "11111111-1111-4111-8111-111111111111",
      includeHidden: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.experimental_callerLaunchId).toBe("11111111-1111-4111-8111-111111111111");
    expect(listed).toEqual([
      {
        experimental_callerLaunchId: "11111111-1111-4111-8111-111111111111",
        includeHidden: true,
      },
    ]);
  });

  it("marks providerId, model, and reasoningLevel as explicit so project defaults cannot replace them", async () => {
    const spawned: unknown[] = [];
    const threads = {
      async spawn(args: unknown) {
        spawned.push(args);
        return { id: "thr_bound01" };
      },
      async get() {
        return { id: "thr_bound01" };
      },
      async list() {
        return { threads: [] };
      },
    };
    const bound = bindOfficialThreads(threads as never);
    await bound.spawn({
      ...spawnArgs(),
      providerId: "claude",
      model: "fable",
      reasoningLevel: "medium",
    });
    const first = spawned[0] as Record<string, unknown>;
    expect(first.providerId).toBe("claude");
    expect(first.model).toBe("fable");
    expect(first.reasoningLevel).toBe("medium");
    expect(first.executionInputSources).toEqual({
      providerId: "explicit",
      model: "explicit",
      reasoningLevel: "explicit",
    });
    expect(first.reasoningEffort).toBeUndefined();
  });

  it("maps official threads.send to confirmed sent/queued", async () => {
    const sent: unknown[] = [];
    const threads = {
      async spawn() {
        return { id: "thr_bound01" };
      },
      async get() {
        return { id: "thr_bound01" };
      },
      async list() {
        return { threads: [] };
      },
      async send(args: unknown) {
        sent.push(args);
        return { ok: true, delivery: "sent" };
      },
    };
    const bound = bindOfficialThreads(threads as never);
    const result = await bound.send!({ threadId: "thr_bound01", text: "Продолжение" });
    expect(result).toEqual({ kind: "confirmed", delivery: "sent" });
    expect(sent).toEqual([
      {
        threadId: "thr_bound01",
        input: [{ type: "text", text: "Продолжение", mentions: [] }],
        mode: "auto",
      },
    ]);
  });

  it("keeps queuedMessage.id and proves delivery from typed rows, not JSON includes", async () => {
    const token = "agency.answerNeedsInput:11111111-1111-4111-8111-111111111111";
    const threads = {
      async spawn() {
        return { id: "thr_bound01" };
      },
      async get() {
        return { id: "thr_bound01" };
      },
      async list() {
        return { threads: [] };
      },
      async send() {
        return { ok: true, delivery: "queued", queuedMessage: { id: "qmsg_mavewyhe4r" } };
      },
      queuedMessages: {
        async list() {
          return [{ id: "qmsg_mavewyhe4r", content: [{ type: "text", text: `intro\n${token}` }] }];
        },
      },
      async timeline() {
        return {
          summary: `noise ${token} in summary`,
          rows: [{ kind: "turn", text: token, role: "assistant" }],
        };
      },
    };
    const bound = bindOfficialThreads(threads as never);
    const queued = await bound.send!({ threadId: "thr_bound01", text: "Продолжение" });
    expect(queued).toEqual({ kind: "confirmed", delivery: "queued", queuedMessageId: "qmsg_mavewyhe4r" });
    expect(await bound.hasContinuation!("thr_bound01", token, "qmsg_mavewyhe4r")).toBe("queued");
    threads.queuedMessages.list = async () => [];
    threads.timeline = async () => ({
      summary: token,
      rows: [
        {
          kind: "conversation",
          role: "user",
          text: `Продолжение\n\n${token}`,
          turnRequest: { kind: "message", status: "accepted" },
        },
      ],
    });
    expect(await bound.hasContinuation!("thr_bound01", token)).toBe("present");
  });
});
