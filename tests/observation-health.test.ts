import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { createBoundedReader, createRuntimeLifetime, observationErrorCode } from "../src/server/runtime/observation/control";
import { observationHealth, recordObservation } from "../src/server/runtime/observation/health";
import { failureKind } from "../src/server/runtime/run-watch/failure-policy";
import { createCompletionWatch } from "../src/server/runtime/isolated-sdk/completion-watch";

const row = { launchId: "launch_observer", jobId: "job_observer", threadId: "thr_observer" };
const empty = { publishedVerified: false, acceptedVerified: false, publishedHash: null };
afterEach(() => { vi.useRealTimers(); });
const applied = (_row: unknown, reading: Parameters<Parameters<typeof createCompletionWatch>[0]["applyReading"]>[1]) => Promise.resolve({
  ...reading, jobState: null, reviewApplied: false, publishedHash: null, attemptState: null,
  attemptReviewApplied: false, attemptAcceptedApplied: false,
});

describe("observer health", () => {
  it("keeps an outage across reload, notifies once after time+count and clears only the recovered stage", () => {
    const db = openMigratedDatabase(new Database(":memory:")); const notify = vi.fn(() => true);
    const record = (stage: string, code: string | null, second: number) => recordObservation(db, row, stage, code, new Date(Date.UTC(2026,8,24,0,0,second)).toISOString(), notify);
    try {
      record("queue", "observation_timeout", 0);
      record("thread", "observation_rpc_failed", 1);
      record("queue", "observation_rpc_failed", 30);
      expect(record("queue", "observation_rpc_failed", 61)).toBe("notified");
      expect(record("queue", "observation_rpc_failed", 90)).toBe("failed");
      expect(notify).toHaveBeenCalledOnce();
      expect(observationHealth(db, row.jobId).find(f => f.stage === "queue")?.firstAt).toBe("2026-09-24T00:00:00.000Z");
      expect(record("queue", null, 91)).toBe("recovered");
      expect(observationHealth(db, row.jobId).map(f => f.stage)).toEqual(["thread"]);
    } finally { db.close(); }
  });
  it("retries refused notification without pretending it was delivered", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    try {
      for (const second of [0,30,61]) recordObservation(db, row, "artifact", "unavailable", new Date(second*1000).toISOString(), () => false);
      expect(observationHealth(db, row.jobId)[0]?.notifiedAt).toBeNull();
      expect(recordObservation(db, row, "artifact", "unavailable", new Date(62_000).toISOString(), () => true)).toBe("notified");
    } finally { db.close(); }
  });
  it("times out a hung read without accumulating requests; rejects late results on disposal", async () => {
    vi.useFakeTimers(); const lifetime = createRuntimeLifetime(); const read = createBoundedReader(lifetime.isActive, 100);
    let resolve!: (n: number) => void; const rpc = vi.fn(() => new Promise<number>(r => { resolve = r; }));
    const first = read("same", rpc); const assertion = expect(first).rejects.toMatchObject({ code: "observation_timeout" });
    await vi.advanceTimersByTimeAsync(100); await assertion;
    await expect(read("same", rpc)).rejects.toMatchObject({ code: "observation_timeout" });
    expect(rpc).toHaveBeenCalledOnce(); resolve(3); await Promise.resolve(); await Promise.resolve();
    const fresh = read("late", async () => { lifetime.dispose(); return 7; });
    await expect(fresh).rejects.toMatchObject({ code: "runtime_disposed" });
  });
  it("does not copy arbitrary exception messages into structured diagnostics", () => {
    expect(observationErrorCode(new Error("Authorization: secret-value"))).toBe("observation_rpc_failed");
    expect(observationErrorCode({ code: "bad code with token=secret" })).toBe("observation_rpc_failed");
    expect(observationErrorCode({ code: "host_disconnected" })).toBe("host_disconnected");
  });
  it("distinguishes context exhaustion from a transport deadline", () => {
    expect(failureKind("context deadline exceeded: timeout")).toBe("transient");
    expect(failureKind("context_length_exceeded")).toBe("context");
    expect(failureKind("quota exhausted")).toBe("capacity");
  });
  it("keeps other jobs observable when one thread read hangs, without repeated hung RPCs", async () => {
    vi.useFakeTimers(); const observed = vi.fn(); const apply = vi.fn(applied);
    const get = vi.fn(async ({ threadId }: { threadId: string }) => {
      if (threadId === row.threadId) return new Promise<never>(() => {});
      return { id: threadId, status: "active" };
    });
    const watch = createCompletionWatch({ threads: { get, list: async () => [], spawn: async () => { throw new Error("unused"); } },
      listBoundLaunches: () => [row, { ...row, launchId: "other", jobId: "other", threadId: "other" }],
      readPublishedForJob: async () => empty, applyReading: apply, onObservation: observed, pollMs: 1000, readTimeoutMs: 100 });
    try {
      const pass = watch.poll(); await vi.advanceTimersByTimeAsync(100); await pass;
      expect(apply).toHaveBeenCalledOnce();
      expect(observed).toHaveBeenCalledWith(row, "thread", "observation_timeout");
      await watch.poll();
      expect(get.mock.calls.filter(([arg]) => arg.threadId === row.threadId)).toHaveLength(1);
      expect(apply).toHaveBeenCalledTimes(2);
    } finally { watch.dispose(); }
  });
  it("does not read artifacts before supervising an error turn", async () => {
    const readArtifact = vi.fn(async () => { throw new Error("host offline"); }); const apply = vi.fn(applied);
    const watch = createCompletionWatch({ threads: { get: async () => ({ id: row.threadId, status: "error" }), list: async () => [], spawn: async () => { throw new Error("unused"); } },
      listBoundLaunches: () => [row], readPublishedForJob: readArtifact, applyReading: apply });
    try { await watch.poll(); expect(readArtifact).not.toHaveBeenCalled(); expect(apply).toHaveBeenCalledOnce(); }
    finally { watch.dispose(); }
  });
  it("reports artifact failures and never converts unknown bytes into a final hand-in", async () => {
    const observed = vi.fn(); const apply = vi.fn(applied);
    const watch = createCompletionWatch({ threads: { get: async () => ({ id: row.threadId, status: "idle" }), list: async () => [], spawn: async () => { throw new Error("unused"); } },
      listBoundLaunches: () => [row], readPublishedForJob: async () => { throw Object.assign(new Error("hidden"), { code: "artifact_hash_mismatch" }); }, applyReading: apply, onObservation: observed });
    try { await watch.poll(); expect(observed).toHaveBeenCalledWith(row, "artifact", "artifact_hash_mismatch"); expect(apply).not.toHaveBeenCalled(); }
    finally { watch.dispose(); }
  });
  it("rotates through more than four jobs so polling cannot starve the tail", async () => {
    const apply = vi.fn(applied); const rows = Array.from({ length: 9 }, (_, i) => ({ ...row, launchId: `launch${i}`, jobId: `job${i}` }));
    const watch = createCompletionWatch({ threads: { get: async () => ({ id: row.threadId, status: "active" }), list: async () => [], spawn: async () => { throw new Error("unused"); } },
      listBoundLaunches: () => rows, readPublishedForJob: async () => empty, applyReading: apply });
    try { await watch.poll(); await watch.poll(); await watch.poll(); expect(new Set(apply.mock.calls.map(([r]) => (r as typeof row).jobId)).size).toBe(9); }
    finally { watch.dispose(); }
  });
  it("reports a stuck mutation but does not invoke it twice", async () => {
    vi.useFakeTimers(); let resolve!: () => void; const pending = new Promise<void>(r => { resolve = r; }); const observation = vi.fn();
    const apply = vi.fn(async (...args: Parameters<typeof applied>) => { await pending; return applied(...args); });
    const watch = createCompletionWatch({ threads: { get: async () => ({ id: row.threadId, status: "active" }), list: async () => [], spawn: async () => { throw new Error("unused"); } },
      listBoundLaunches: () => [row], readPublishedForJob: async () => empty, applyReading: apply, onObservation: observation, pollMs: 1000, readTimeoutMs: 100 });
    try {
      const pass = watch.poll(); await vi.advanceTimersByTimeAsync(101);
      const second = watch.poll(); expect(observation).toHaveBeenCalledWith(row, "apply", "observation_timeout");
      expect(apply).toHaveBeenCalledOnce(); resolve(); await Promise.all([pass, second]);
    } finally { watch.dispose(); }
  });
});
