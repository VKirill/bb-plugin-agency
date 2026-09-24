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
    const limited = harness({ providerError: () => "Rate limit reached; resets in 42 minutes", bbWillRetry: () => true });
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

  it("switches to the owner-set reserve immediately on a usage limit", () => {
    const switched: string[] = [];
    const limited = harness({
      providerError: () => "Codex usage limit reached. Your subscription window resets in 5h",
      canSwitchToFallback: () => true,
      switchToFallback: (rowJob) => {
        switched.push(rowJob.key);
        return true;
      },
    });
    expect(superviseRun(limited.ports, limited.row, { ...active, threadStatus: "error" })).toBe("fallback");
    expect(switched).toEqual(["AG-601"]);
    expect(limited.blocked).toEqual([]);
    expect(superviseRun(limited.ports, limited.row, { ...active, threadStatus: "error" })).toBe("skipped");
  });

  it("blocks immediately when BB will not retry a usage limit and there is no reserve", () => {
    const dead = harness({
      providerError: () => "You've hit your usage limit. Try again at Sep 21st, 2026 7:46 PM.",
      bbWillRetry: () => false,
      canSwitchToFallback: () => false,
    });
    expect(superviseRun(dead.ports, dead.row, { ...active, threadStatus: "error" })).toBe("blocked");
    expect(dead.blocked[0]).toContain("нет запасной модели");
    expect(superviseRun(dead.ports, dead.row, { ...active, threadStatus: "error" })).toBe("skipped");
  });

  it("does not assume a retry when the reserve is missing or refused", () => {
    const waiting = harness({
      providerError: () => "Codex usage limit reached",
      canSwitchToFallback: () => false,
    });
    expect(superviseRun(waiting.ports, waiting.row, { ...active, threadStatus: "error" })).toBe("ok");
    waiting.tick(RUN_WATCH_ERROR_MS + 1000);
    expect(superviseRun(waiting.ports, waiting.row, { ...active, threadStatus: "error" })).toBe("blocked");

    const failed = harness({
      providerError: () => "Codex usage limit reached",
      canSwitchToFallback: () => true,
      switchToFallback: () => false,
    });
    expect(superviseRun(failed.ports, failed.row, { ...active, threadStatus: "error" })).toBe("ok");
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
    expect(h.blocked[0]).toContain("не отменяйте и не перезапускайте себя");
  });

  it("starts the same attempt's rework phase from confirmed return time, even when review was missed by polling", () => {
    const h = harness();
    superviseRun(h.ports, h.row, active);
    h.tick(RUN_WATCH_CEILING_MS - 10 * 60_000);
    const returnedAt = "2026-09-16T11:50:00.000Z";
    h.db.prepare(`INSERT INTO agency_rework
      (request_id,job_id,attempt_id,thread_id,returned_hash,comment,send_state,created_at,updated_at)
      VALUES ('return1',?,'run_attempt0001','thr_worker0001','hash','D1/D2','confirmed',?,?)`)
      .run(job.id, returnedAt, returnedAt);
    h.tick(25 * 60_000); // Old attempt over 2h, actual rework only 25min.
    h.progressNow();
    expect(superviseRun(h.ports, h.row, active)).toBe("ok");
    expect(h.db.prepare("SELECT active_since, rework_at FROM agency_run_watch").get())
      .toEqual({ active_since: returnedAt, rework_at: returnedAt });
    // Resolving a publication updates the ledger updated_at, not its phase boundary.
    h.db.prepare("UPDATE agency_rework SET updated_at = '2026-09-16T12:15:00.000Z', resolved_at = '2026-09-16T12:15:00.000Z'").run();
    // Neither repeated polls nor progress grants more time after the new phase's ceiling.
    h.tick(RUN_WATCH_CEILING_MS - 25 * 60_000);
    h.progressNow();
    expect(superviseRun(h.ports, h.row, active)).toBe("blocked");
    h.db.close();
  });

  it("does not count an observed idle interval when adopting an older confirmed phase on upgrade", () => {
    const h = harness();
    superviseRun(h.ports, h.row, active);
    h.tick(30 * 60_000);
    superviseRun(h.ports, h.row, { ...active, threadStatus: "idle" });
    h.tick(90 * 60_000);
    superviseRun(h.ports, h.row, active);
    h.db.prepare(`INSERT INTO agency_rework
      (request_id,job_id,attempt_id,thread_id,returned_hash,comment,send_state,created_at,updated_at)
      VALUES ('priorReturn',?,'run_attempt0001','thr_worker0001','hash','repair','confirmed',
      '2026-09-16T10:30:00.000Z','2026-09-16T10:30:00.000Z')`).run(job.id);
    h.progressNow();
    expect(superviseRun(h.ports, h.row, active)).toBe("ok");
    expect(h.db.prepare("SELECT active_since FROM agency_run_watch").get())
      .toEqual({ active_since: "2026-09-16T12:00:00.000Z" });
    h.db.close();
  });

  it("repairs a pre-upgrade stale ceiling only with a newer confirmed return; plain running reset cannot bypass it", () => {
    const h = harness({ getJob: () => ({ ...job, state: "running" }) });
    superviseRun(h.ports, h.row, active);
    h.tick(RUN_WATCH_CEILING_MS);
    h.progressNow();
    expect(superviseRun(h.ports, h.row, active)).toBe("blocked");
    expect(superviseRun(h.ports, h.row, active)).toBe("skipped");
    const phase = "2026-09-16T11:45:00.000Z";
    h.db.prepare(`INSERT INTO agency_rework
      (request_id,job_id,attempt_id,thread_id,returned_hash,comment,send_state,created_at,updated_at)
      VALUES ('return2',?,'run_attempt0001','thr_worker0001','hash','repair','failed',?,?)`)
      .run(job.id, phase, phase);
    expect(superviseRun(h.ports, h.row, active)).toBe("skipped");
    h.db.prepare("UPDATE agency_rework SET send_state = 'confirmed'").run();
    expect(superviseRun(h.ports, h.row, active)).toBe("ok");
    expect(h.db.prepare("SELECT outcome, active_since FROM agency_run_watch").get())
      .toEqual({ outcome: null, active_since: phase });
    h.tick(RUN_WATCH_CEILING_MS);
    h.progressNow();
    expect(superviseRun(h.ports, h.row, active)).toBe("blocked");
    expect(superviseRun(h.ports, h.row, active)).toBe("skipped");
    h.db.close();
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

describe("supervision after same-attempt BB retry", () => {
  it("requires actual error-to-active recovery before rearming an error-blocked watch", () => {
    // The lead has returned the job to running, but that alone must not reset it.
    const h = harness({ getJob: () => ({ ...job, state: "running" }) });
    const error = { ...active, threadStatus: "error" };
    superviseRun(h.ports, h.row, error);
    h.tick(RUN_WATCH_ERROR_MS);
    expect(superviseRun(h.ports, h.row, error)).toBe("blocked");
    expect(superviseRun(h.ports, h.row, error)).toBe("skipped");
    expect(superviseRun(h.ports, h.row, active)).toBe("ok");
    h.tick(RUN_WATCH_STALL_MS);
    expect(superviseRun(h.ports, h.row, active)).toBe("blocked");
    expect(h.blocked).toHaveLength(2);
  });
  it("does not rearm a work ceiling just because the thread is active", () => {
    const h = harness({ getJob: () => ({ ...job, state: "running" }) });
    superviseRun(h.ports, h.row, active);
    h.tick(RUN_WATCH_CEILING_MS); h.progressNow();
    expect(superviseRun(h.ports, h.row, active)).toBe("blocked");
    expect(superviseRun(h.ports, h.row, active)).toBe("skipped");
    expect(h.blocked).toHaveLength(1);
  });
});

describe("structured retry and actionable errors", () => {
  it("trusts willRetry=true even with unfamiliar provider text", () => {
    const h = harness({ providerError: () => "temporary vendor condition ABC", bbWillRetry: () => true });
    const error = { ...active, threadStatus: "error" };
    expect(superviseRun(h.ports, h.row, error)).toBe("warned");
    h.tick(RUN_WATCH_ERROR_MS + 1);
    expect(superviseRun(h.ports, h.row, error)).toBe("ok");
    expect(h.blocked).toEqual([]);
  });
  it("does not wait six hours solely because an error mentions timeout/502", () => {
    const h = harness({ providerError: () => "502 request timeout", bbWillRetry: () => null });
    const error = { ...active, threadStatus: "error" };
    expect(superviseRun(h.ports, h.row, error)).toBe("ok");
    h.tick(RUN_WATCH_ERROR_MS + 1);
    expect(superviseRun(h.ports, h.row, error)).toBe("blocked");
    expect(h.blocked[0]).toContain("transient");
  });
  it("leaves confirmed queued continuation to BB, including on a usage limit", () => {
    let switched = false;
    const h = harness({ providerError: () => "usage limit", bbWillRetry: () => false, queuedWork: () => true,
      canSwitchToFallback: () => true, switchToFallback: () => { switched = true; return true; } });
    expect(superviseRun(h.ports, h.row, { ...active, threadStatus: "error" })).toBe("warned");
    expect(switched).toBe(false); expect(h.blocked).toEqual([]);
  });
  it.each([
    ["401 unauthorized", "auth"], ["context_length_exceeded", "context"],
    ["model_not_found", "model"], ["spawn ENOENT", "environment"], ["ENOSPC", "environment"],
  ])("immediately gives the lead an actionable diagnosis for %s", (detail, kind) => {
    const h = harness({ providerError: () => detail });
    expect(superviseRun(h.ports, h.row, { ...active, threadStatus: "error" })).toBe("blocked");
    expect(h.blocked[0]).toContain(`(${kind})`);
  });
});
