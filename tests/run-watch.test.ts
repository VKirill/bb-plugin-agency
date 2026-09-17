import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import {
  RUN_WATCH_CEILING_MS,
  RUN_WATCH_ERROR_MS,
  RUN_WATCH_PROVIDER_WAIT_MS,
  RUN_WATCH_QUIET_MS,
  RUN_WATCH_STALL_MS,
  RUN_WATCH_START_MS,
  lastProgressFromDatabase,
  superviseRun,
  type RunWatchPorts,
} from "../src/server/runtime/run-watch/service";
import type { Job } from "../src/shared/contracts";

const job: Job = {
  id: "job_worker0001",
  key: "AG-601",
  bindingId: "bnd_aaaaaaaa",
  departmentId: "dep_aaaaaaaa",
  title: "Реализация",
  brief: "Бриф.",
  acceptance: "Критерий.",
  state: "running",
  parentJobId: null,
  assignedAgentId: "agt_dev00001",
  priority: "normal",
  dueAt: null,
  revision: 3,
  updatedAt: "2026-09-16T10:00:00.000Z",
};

function harness(overrides: Partial<RunWatchPorts> = {}) {
  const db = openMigratedDatabase(new Database(":memory:"));
  let clock = Date.parse("2026-09-16T10:00:00.000Z");
  let progress: string | null = null;
  const comments: string[] = [];
  const blocked: string[] = [];
  let current = { ...job };
  const ports: RunWatchPorts = {
    db,
    getJob: () => current,
    attemptForLaunch: () => ({ id: "run_attempt0001", state: "running" }),
    lastProgressAt: () => progress,
    comment: (_job, text) => {
      comments.push(text);
      return true;
    },
    block: (_job, text) => {
      blocked.push(text);
      current = { ...current, state: "blocked" };
      return true;
    },
    now: () => new Date(clock).toISOString(),
    ...overrides,
  };
  const row = { threadId: "thr_worker0001", jobId: job.id, launchId: "launch-1" };
  return {
    db,
    ports,
    row,
    comments,
    blocked,
    tick: (ms: number) => {
      clock += ms;
    },
    progressNow: () => {
      progress = new Date(clock).toISOString();
    },
  };
}

const active = { threadStatus: "active", threadUpdatedAt: null, backgroundAgents: 0 };

describe("run watch", () => {
  it("warns once after a quiet spell and blocks a stalled run", () => {
    const h = harness();
    expect(superviseRun(h.ports, h.row, active)).toBe("ok");
    h.tick(RUN_WATCH_QUIET_MS);
    expect(superviseRun(h.ports, h.row, active)).toBe("warned");
    h.tick(60_000);
    expect(superviseRun(h.ports, h.row, active)).toBe("ok");
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]).toContain("AG-601");
    h.tick(RUN_WATCH_STALL_MS - RUN_WATCH_QUIET_MS);
    expect(superviseRun(h.ports, h.row, active)).toBe("blocked");
    expect(h.blocked[0]).toContain("завис");
    expect(superviseRun(h.ports, h.row, active)).toBe("skipped");
  });

  it("treats token usage, thread updates and background agents as progress", () => {
    const h = harness();
    superviseRun(h.ports, h.row, active);
    h.tick(RUN_WATCH_STALL_MS - 60_000);
    h.progressNow();
    h.tick(RUN_WATCH_STALL_MS - 60_000);
    // Quiet long enough for a warning, not for a stall: the usage event reset the clock.
    expect(superviseRun(h.ports, h.row, active)).toBe("warned");
    h.tick(RUN_WATCH_STALL_MS - 60_000);
    const updatedAt = new Date(Date.parse(h.ports.now()) - 1000).toISOString();
    expect(superviseRun(h.ports, h.row, { ...active, threadUpdatedAt: updatedAt })).toBe("ok");
    h.tick(RUN_WATCH_STALL_MS);
    expect(superviseRun(h.ports, h.row, { ...active, backgroundAgents: 1 })).toBe("ok");
    expect(h.blocked).toHaveLength(0);
  });

  it("blocks a thread that never starts or stays in error", () => {
    const starting = harness();
    superviseRun(starting.ports, starting.row, { ...active, threadStatus: "pending" });
    starting.tick(RUN_WATCH_START_MS);
    expect(superviseRun(starting.ports, starting.row, { ...active, threadStatus: "pending" })).toBe("blocked");
    expect(starting.blocked[0]).toContain("не запустился");

    const failing = harness();
    superviseRun(failing.ports, failing.row, { ...active, threadStatus: "error" });
    failing.tick(RUN_WATCH_ERROR_MS - 1000);
    expect(superviseRun(failing.ports, failing.row, { ...active, threadStatus: "error" })).toBe("ok");
    failing.tick(1000);
    expect(superviseRun(failing.ports, failing.row, { ...active, threadStatus: "error" })).toBe("blocked");
  });

  it("waits out an error BB retries by itself, and still blocks a dead one", () => {
    // A subscription window: BB waits for the reset and carries the same thread on.
    const limited = harness({ providerError: () => "Rate limit reached; resets in 42 minutes" });
    // The owner hears it once, then the watch simply waits.
    expect(superviseRun(limited.ports, limited.row, { ...active, threadStatus: "error" })).toBe("warned");
    expect(limited.comments[0]).toContain("BB сам ждёт возможности продолжить");
    limited.tick(RUN_WATCH_ERROR_MS + 1000);
    expect(superviseRun(limited.ports, limited.row, { ...active, threadStatus: "error" })).toBe("ok");
    expect(limited.comments).toHaveLength(1);
    expect(limited.blocked).toEqual([]);
    // Six hours later it is not a wait any more.
    limited.tick(RUN_WATCH_PROVIDER_WAIT_MS);
    expect(superviseRun(limited.ports, limited.row, { ...active, threadStatus: "error" })).toBe("blocked");

    // The machine went offline: nothing is lost, the attempt waits for it to come back.
    const offline = harness({ hostOnline: () => false });
    expect(superviseRun(offline.ports, offline.row, { ...active, threadStatus: "error" })).toBe("warned");
    offline.tick(RUN_WATCH_ERROR_MS + 1000);
    expect(superviseRun(offline.ports, offline.row, { ...active, threadStatus: "error" })).toBe("ok");
    expect(offline.blocked).toEqual([]);

    // A dead attempt is still blocked: no balance, no retry.
    const broke = harness({ providerError: () => "Internal error: Insufficient Balance", hostOnline: () => true });
    superviseRun(broke.ports, broke.row, { ...active, threadStatus: "error" });
    broke.tick(RUN_WATCH_ERROR_MS + 1000);
    expect(superviseRun(broke.ports, broke.row, { ...active, threadStatus: "error" })).toBe("blocked");
  });

  it("leaves idle threads to the completion reminder and restarts the episode", () => {
    const h = harness();
    superviseRun(h.ports, h.row, active);
    h.tick(RUN_WATCH_QUIET_MS + 1000);
    expect(superviseRun(h.ports, h.row, { ...active, threadStatus: "idle" })).toBe("ok");
    h.tick(RUN_WATCH_STALL_MS * 3);
    expect(superviseRun(h.ports, h.row, { ...active, threadStatus: "idle" })).toBe("ok");
    expect(superviseRun(h.ports, h.row, active)).toBe("ok");
    expect(h.comments).toHaveLength(0);
    expect(h.blocked).toHaveLength(0);
  });

  it("stops a run that stays active past the ceiling even with progress", () => {
    const h = harness();
    superviseRun(h.ports, h.row, active);
    for (let spent = 10 * 60_000; spent < RUN_WATCH_CEILING_MS; spent += 10 * 60_000) {
      h.tick(10 * 60_000);
      h.progressNow();
      expect(superviseRun(h.ports, h.row, active)).not.toBe("blocked");
    }
    h.tick(10 * 60_000);
    h.progressNow();
    expect(superviseRun(h.ports, h.row, active)).toBe("blocked");
    expect(h.blocked[0]).toContain("потолок");
  });

  it("skips jobs or attempts that are not running", () => {
    const h = harness({ attemptForLaunch: () => ({ id: "run_attempt0001", state: "awaiting_review" }) });
    expect(superviseRun(h.ports, h.row, active)).toBe("skipped");
  });

  it("reads the latest progress from usage events and job activity", () => {
    const h = harness();
    h.db
      .prepare(
        `INSERT INTO agency_usage_event (thread_id, event_id, seq, created_at, provider_thread_id, turn_id, last_json, total_json, captured_at)
         VALUES ('thr_worker0001', 'e1', 1, '2026-09-16T10:05:00.000Z', NULL, NULL, '{}', '{}', '2026-09-16T12:00:00.000Z')`,
      )
      .run();
    expect(lastProgressFromDatabase(h.db, "thr_worker0001", job.id)).toBe("2026-09-16T10:05:00.000Z");
    expect(lastProgressFromDatabase(h.db, "thr_other", "job_other")).toBeNull();
  });
});
