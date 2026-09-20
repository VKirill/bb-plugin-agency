import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ok, type DomainResult } from "../src/domain";
import { openMigratedDatabase } from "../src/server/db";
import { assertOwnershipFree } from "../src/server/flow/ownership";
import { checkLaunchLimits, liveLaunchCount } from "../src/server/rules/limits";
import { enqueueLaunch, listLaunchQueue, sweepLaunchQueue, type LaunchQueuePorts } from "../src/server/runtime/launch-queue/service";
import type { Job } from "../src/shared/contracts";
import { createJobCommandSchema } from "../src/shared/contracts/job";
import { seed } from "./role-types.test";

type Priority = "low" | "normal" | "high" | "urgent";

/**
 * The real launch gate (ownership, then limits) over a real database; only the BB thread is
 * a fake. A «spawn» stays open until the test releases it, the way a slow `threads.spawn` does.
 */
function setup() {
  const db = openMigratedDatabase(new Database(":memory:"));
  const s = seed(db);
  const job = (title: string, mayChange: string[], priority: Priority = "normal") => {
    const created = s.store.createJob(s.ctx, {
      ...createJobCommandSchema.parse({
        requestId: randomUUID(),
        bindingId: s.ctx.allowedBindingIds[0],
        departmentId: s.departmentId,
        title,
        brief: "Бриф.",
        acceptance: "Критерий.",
        assignedAgentId: s.developer,
        priority,
        contract: { mayChange, mustNotTouch: [], checks: [] },
      }),
    });
    if (!created.ok) throw new Error(created.error.message);
    return created.value;
  };
  const save = (scope: string, rules: Record<string, unknown>) => {
    const current = s.store.getWorkRules(scope);
    const saved = s.store.saveWorkRules(s.bootstrap, { requestId: randomUUID(), scope, expectedRevision: current.ok ? current.value.revision : 0, rules });
    if (!saved.ok) throw new Error(saved.error.message);
  };
  const threadOf = (jobId: string) =>
    (db.prepare(`SELECT thread_id FROM agency_run_attempt WHERE job_id = ? AND state = 'running'`).get(jobId) as { thread_id: string } | undefined)?.thread_id ?? null;

  const started: string[] = [];
  const spawns = new Map<string, () => void>();
  /** Resolves when `count` launches are inside their spawn at once. */
  const spawning = async (count: number) => {
    for (let turn = 0; turn < 50 && spawns.size < count; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    return spawns.size;
  };
  const gate = async (item: Job, pending: readonly string[] = []): Promise<DomainResult<{ warnings: string[] }>> => {
    const ownership = assertOwnershipFree(db, item, false, pending);
    if (!ownership.ok) return ownership;
    return checkLaunchLimits({ db, spend: async () => null }, item, pending);
  };
  const ports: LaunchQueuePorts = {
    db,
    getJob: (id) => s.store.getJob(id),
    checkLimits: gate,
    launch: async (item) => {
      started.push(item.id);
      // What prepareLaunch does: the authoritative check at the reservation, then the spawn.
      const allowed = await gate(item);
      if (!allowed.ok) return allowed;
      await new Promise<void>((resolve) => spawns.set(item.id, resolve));
      db.pragma("foreign_keys = OFF");
      db.prepare(
        `INSERT INTO agency_run_attempt (id, job_id, attempt_no, snapshot_id, digest, thread_id, launch_id, state, revision, created_at, updated_at)
         VALUES (?, ?, 1, 'snp_fixture', 'digest', ?, ?, 'running', 1, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z')`,
      ).run(`run_${item.id}`, item.id, `thr_${item.id}`, randomUUID());
      db.pragma("foreign_keys = ON");
      db.prepare(`UPDATE agency_job SET state = 'running' WHERE id = ?`).run(item.id);
      return ok({});
    },
    comment: () => true,
    now: () => "2026-09-20T10:00:00.000Z",
  };
  const releaseAll = () => {
    for (const release of spawns.values()) release();
  };
  return { db, s, job, save, ports, started, spawns, spawning, releaseAll, threadOf };
}

describe("launch queue: independent jobs start side by side", () => {
  it("starts two jobs with different files in one sweep, without waiting for the first spawn", async () => {
    const t = setup();
    const first = t.job("Карточки", ["src/cards/**"]);
    const second = t.job("Счета", ["src/billing/**"]);
    enqueueLaunch(t.db, first.id, "2026-09-20T09:00:00.000Z");
    enqueueLaunch(t.db, second.id, "2026-09-20T09:01:00.000Z");

    const sweep = sweepLaunchQueue(t.ports);
    // Both are inside their spawn at once: the second did not wait for the first to finish.
    expect(await t.spawning(2)).toBe(2);
    expect(t.started).toEqual([first.id, second.id]);
    t.releaseAll();

    expect(await sweep).toEqual({ launched: 2, removed: 0 });
    for (const item of [first, second]) {
      expect(t.s.store.getJob(item.id)?.state).toBe("running");
      expect(t.threadOf(item.id)).toBe(`thr_${item.id}`);
    }
    expect(listLaunchQueue(t.db)).toEqual([]);
  });

  it("gives one employee several threads when no limit is set", async () => {
    const t = setup();
    const jobs = [t.job("Один", ["a/**"]), t.job("Два", ["b/**"]), t.job("Три", ["c/**"])];
    jobs.forEach((item, index) => enqueueLaunch(t.db, item.id, `2026-09-20T09:0${index}:00.000Z`));
    const sweep = sweepLaunchQueue(t.ports);
    expect(await t.spawning(3)).toBe(3);
    t.releaseAll();
    expect(await sweep).toEqual({ launched: 3, removed: 0 });
    expect(liveLaunchCount(t.db, { kind: "agent", id: t.s.developer, name: "Разработчик" })).toBe(3);
  });

  it("keeps the second job in the queue with owns_overlap, and starts it when the first is done", async () => {
    const t = setup();
    const first = t.job("Общий код", ["src/shared/**"]);
    const second = t.job("Тоже общий код", ["src/shared/contracts/job.ts"]);
    enqueueLaunch(t.db, first.id, "2026-09-20T09:00:00.000Z");
    enqueueLaunch(t.db, second.id, "2026-09-20T09:01:00.000Z");

    const sweep = sweepLaunchQueue(t.ports);
    expect(await t.spawning(1)).toBe(1);
    // The first job has no attempt row yet, and the second one is held all the same.
    expect(t.started).toEqual([first.id]);
    t.releaseAll();
    expect(await sweep).toEqual({ launched: 1, removed: 0 });

    const waiting = listLaunchQueue(t.db);
    expect(waiting.map((row) => row.jobId)).toEqual([second.id]);
    expect(waiting[0]?.waitingReason).toContain(first.key);
    expect(waiting[0]?.waitingReason).toContain("src/shared");
    expect(t.s.store.getJob(second.id)?.state).not.toBe("running");

    // The first one finishes: its attempt leaves the live states and the files are free.
    t.db.prepare(`UPDATE agency_run_attempt SET state = 'succeeded' WHERE job_id = ?`).run(first.id);
    t.spawns.clear();
    const next = sweepLaunchQueue(t.ports);
    expect(await t.spawning(1)).toBe(1);
    t.releaseAll();
    expect(await next).toEqual({ launched: 1, removed: 0 });
    expect(t.s.store.getJob(second.id)?.state).toBe("running");
    expect(t.threadOf(second.id)).toBe(`thr_${second.id}`);
  });

  it("fills a concurrency limit by priority and leaves the rest in line", async () => {
    const t = setup();
    t.save("agency", { concurrencyLimit: 2 });
    const low = t.job("Низкая", ["a/**"], "low");
    const normal = t.job("Обычная", ["b/**"]);
    const urgent = t.job("Срочная", ["c/**"], "urgent");
    for (const item of [low, normal, urgent]) enqueueLaunch(t.db, item.id, "2026-09-20T09:00:00.000Z");

    const sweep = sweepLaunchQueue(t.ports);
    expect(await t.spawning(2)).toBe(2);
    expect(t.started).toEqual([urgent.id, normal.id]);
    t.releaseAll();
    expect(await sweep).toEqual({ launched: 2, removed: 0 });

    const waiting = listLaunchQueue(t.db);
    expect(waiting.map((row) => row.jobId)).toEqual([low.id]);
    expect(waiting[0]?.waitingReason).toContain("лимит 2");
  });

  it("a launch that throws does not take the other launches of the sweep down", async () => {
    const t = setup();
    const broken = t.job("Сломана", ["a/**"]);
    const fine = t.job("Годна", ["b/**"]);
    enqueueLaunch(t.db, broken.id, "2026-09-20T09:00:00.000Z");
    enqueueLaunch(t.db, fine.id, "2026-09-20T09:01:00.000Z");
    const launch = t.ports.launch;
    t.ports.launch = async (item, requestedAt) => {
      if (item.id === broken.id) throw new Error("socket hang up");
      return launch(item, requestedAt);
    };
    const sweep = sweepLaunchQueue(t.ports);
    expect(await t.spawning(1)).toBe(1);
    t.releaseAll();
    expect(await sweep).toEqual({ launched: 1, removed: 0 });
    // A passing failure: the job stays in line with the reason.
    expect(listLaunchQueue(t.db).map((row) => [row.jobId, row.waitingReason])).toEqual([[broken.id, "socket hang up"]]);
  });
});

describe("a job being launched holds its slot before the attempt exists", () => {
  it("counts a pending job once, and not at all against itself", () => {
    const t = setup();
    const a = t.job("A", ["a/**"]);
    const b = t.job("B", ["b/**"]);
    const scope = { kind: "agency" } as const;
    expect(liveLaunchCount(t.db, scope, "", [a.id, b.id])).toBe(2);
    expect(liveLaunchCount(t.db, scope, a.id, [a.id, b.id])).toBe(1);
    t.db.pragma("foreign_keys = OFF");
    t.db.prepare(
      `INSERT INTO agency_run_attempt (id, job_id, attempt_no, snapshot_id, digest, thread_id, launch_id, state, revision, created_at, updated_at)
       VALUES ('run_a', ?, 1, 'snp_fixture', 'digest', NULL, NULL, 'prepared', 1, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z')`,
    ).run(a.id);
    // The attempt is reserved now: the job is still one slot, not two.
    expect(liveLaunchCount(t.db, scope, "", [a.id, b.id])).toBe(2);
  });
});
