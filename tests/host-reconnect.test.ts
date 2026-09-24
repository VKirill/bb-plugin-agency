import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { readThreadFailure, resumeAfterHostReconnect, type HostReconnectPorts } from "../src/server/runtime/host-reconnect/service";
import { superviseRun, RUN_WATCH_PROVIDER_WAIT_MS } from "../src/server/runtime/run-watch/service";
import type { Job } from "../src/shared/contracts";

const row = { jobId: "job_host0001", launchId: "launch-1", threadId: "thr_host0001" };
const job: Job = { id: row.jobId, key: "AG-601", bindingId: "bnd_aaaaaaaa", departmentId: "dep_aaaaaaaa", title: "Work", brief: "Work", acceptance: "Done", state: "running", parentJobId: null, assignedAgentId: "agt_dev00001", priority: "normal", dueAt: null, revision: 3, updatedAt: "2026-09-24T00:00:00.000Z" };
const events = [
  { seq: 10, type: "client/turn/requested", data: { requestId: "creq_failed" } },
  { seq: 11, type: "system/error", data: { code: "thread_command_failed", message: "Command turn.submit failed", detail: "Host is not connected" } },
];
const failure = readThreadFailure(events);
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function harness() {
  const db = openMigratedDatabase(new Database(":memory:")); databases.push(db);
  let clock = Date.parse(job.updatedAt);
  let current = { ...job };
  const ports: HostReconnectPorts = {
    db, getJob: () => current, attemptForLaunch: () => ({ id: "run_host0001", state: "running" }),
    hostOnline: vi.fn(async () => true), queuedCount: vi.fn(async () => 0), threadStatus: vi.fn(async () => "error"),
    retry: vi.fn(async () => ({ ok: true as const, delivery: "sent" as const })),
    block: vi.fn(() => { current = { ...current, state: "blocked" }; return true; }),
    comment: vi.fn(() => true), log: vi.fn(), now: () => new Date(clock).toISOString(),
  };
  return { db, ports, tick: (ms: number) => { clock += ms; }, state: (state: Job["state"]) => { current = { ...current, state }; } };
}

describe("host reconnect", () => {
  it("recognizes the actual system transport error and keeps the original turn ID", () => {
    expect(failure).toEqual({ detail: "Host is not connected", willRetry: null, hostTurn: { requestId: "creq_failed", errorSeq: 11 } });
    expect(readThreadFailure([...events].reverse())).toEqual(failure);
  });
  it("ignores historic failures once any newer request/turn has started", () => {
    for (const type of ["client/turn/requested", "turn/started"]) {
      expect(readThreadFailure([...events, { seq: 12, type, data: { requestId: "creq_new" } }]).hostTurn).toBeNull();
    }
  });
  it("never treats provider errors, unrelated system errors or missing requests as transport retries", () => {
    expect(readThreadFailure([events[1]]).hostTurn).toBeNull();
    expect(readThreadFailure([events[0], { ...events[1], type: "provider/error" }]).hostTurn).toBeNull();
    expect(readThreadFailure([events[0], { ...events[1], data: { code: "other", detail: "Host is not connected" } }]).hostTurn).toBeNull();
    expect(readThreadFailure([events[0], { ...events[1], data: { code: "thread_command_failed", detail: "permission denied" } }]).hostTurn).toBeNull();
    expect(readThreadFailure([...events, { seq: 12, type: "provider/error", data: { message: "Quota", willRetry: false } }])).toEqual({ detail: "Quota", willRetry: false, hostTurn: null });
  });
  it("waits for a connected host, then retries only that failed turn", async () => {
    const h = harness(); vi.mocked(h.ports.hostOnline).mockResolvedValueOnce(false);
    expect(await resumeAfterHostReconnect(h.ports, row, failure)).toBe("waiting");
    expect(h.ports.retry).not.toHaveBeenCalled();
    expect(await resumeAfterHostReconnect(h.ports, row, failure)).toBe("retried");
    expect(h.ports.retry).toHaveBeenCalledExactlyOnceWith(row.threadId, "creq_failed");
    expect(h.ports.comment).toHaveBeenCalledOnce();
  });
  it("does not compete with the durable BB queue or an active thread", async () => {
    const h = harness(); vi.mocked(h.ports.queuedCount).mockResolvedValueOnce(1);
    expect(await resumeAfterHostReconnect(h.ports, row, failure)).toBe("waiting");
    vi.mocked(h.ports.threadStatus).mockResolvedValueOnce("active");
    expect(await resumeAfterHostReconnect(h.ports, row, failure)).toBe("waiting");
    expect(h.ports.retry).not.toHaveBeenCalled();
  });
  it("does not revive blocked/canceled work, including a state change during network reads", async () => {
    const h = harness(); h.state("blocked");
    expect(await resumeAfterHostReconnect(h.ports, row, failure)).toBe("skipped");
    h.state("running"); h.ports.attemptForLaunch = () => ({ id: "run_host0001", state: "canceled" });
    expect(await resumeAfterHostReconnect(h.ports, row, failure)).toBe("skipped");
    h.ports.attemptForLaunch = () => ({ id: "run_host0001", state: "running" });
    vi.mocked(h.ports.threadStatus).mockImplementationOnce(async () => { h.state("blocked"); return "error"; });
    expect(await resumeAfterHostReconnect(h.ports, row, failure)).toBe("skipped");
    expect(h.ports.retry).not.toHaveBeenCalled();
  });
  it("deduplicates concurrent watcher calls and persists the claim across service instances", async () => {
    const h = harness();
    expect((await Promise.all([resumeAfterHostReconnect(h.ports, row, failure), resumeAfterHostReconnect(h.ports, row, failure)])).sort()).toEqual(["retried", "waiting"]);
    const freshPorts = { ...h.ports, retry: vi.fn((thread: string, request: string) => h.ports.retry(thread, request)) };
    expect(await resumeAfterHostReconnect(freshPorts, row, failure)).toBe("waiting");
    expect(freshPorts.retry).not.toHaveBeenCalled();
    expect(h.ports.retry).toHaveBeenCalledOnce();
  });
  it("keeps an ambiguous dispatch durable; escalates instead of resending after reload", async () => {
    const h = harness(); vi.mocked(h.ports.retry).mockRejectedValueOnce(new Error("connection dropped after dispatch"));
    expect(await resumeAfterHostReconnect(h.ports, row, failure)).toBe("waiting");
    h.tick(60_000);
    expect(await resumeAfterHostReconnect({ ...h.ports }, row, failure)).toBe("blocked");
    expect(h.ports.retry).toHaveBeenCalledOnce();
    expect(h.ports.block).toHaveBeenCalledOnce();
    expect(h.db.prepare("SELECT state FROM agency_host_retry").get()).toEqual({ state: "uncertain" });
  });
  it("leaves a queued retry to BB even after the ambiguity grace period", async () => {
    const h = harness(); vi.mocked(h.ports.retry).mockResolvedValueOnce({ ok: true, delivery: "queued" });
    expect(await resumeAfterHostReconnect(h.ports, row, failure)).toBe("retried");
    h.tick(120_000); vi.mocked(h.ports.queuedCount).mockResolvedValue(1);
    expect(await resumeAfterHostReconnect(h.ports, row, failure)).toBe("waiting");
    expect(h.ports.retry).toHaveBeenCalledOnce(); expect(h.ports.block).not.toHaveBeenCalled();
  });
  it("routes the third transport failure to the lead without a third automatic retry", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
      const next = { ...failure, hostTurn: { requestId: `creq_${i}`, errorSeq: i + 10 } };
      expect(await resumeAfterHostReconnect(h.ports, row, next)).toBe(i < 2 ? "retried" : "blocked");
    }
    expect(h.ports.retry).toHaveBeenCalledTimes(2); expect(h.ports.block).toHaveBeenCalledOnce();
  });
  it("bounds offline waiting through the ordinary watchdog rather than hiding it indefinitely", async () => {
    const h = harness(); vi.mocked(h.ports.hostOnline).mockResolvedValue(false);
    const watch = { ...h.ports, hostOnline: () => false, lastProgressAt: () => null, providerError: () => failure.detail, bbWillRetry: () => true };
    const reading = { threadStatus: "error", threadUpdatedAt: null, backgroundAgents: 0 };
    expect(await resumeAfterHostReconnect(h.ports, row, failure)).toBe("waiting");
    superviseRun(watch, row, reading); h.tick(RUN_WATCH_PROVIDER_WAIT_MS);
    expect(await resumeAfterHostReconnect(h.ports, row, failure)).toBe("waiting");
    expect(superviseRun(watch, row, reading)).toBe("blocked"); expect(h.ports.retry).not.toHaveBeenCalled();
  });
});
