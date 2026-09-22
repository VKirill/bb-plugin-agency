import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { fail, ok } from "../src/domain";
import { openMigratedDatabase } from "../src/server/db";
import { dequeueLaunch, dropFromQueue, enqueueLaunch, listAssignedBacklogJobIds, listLaunchQueue, refusalIfLaunchDidNotStart, reopenDroppedAssignedJobs, repairQueuedJobs, sweepLaunchQueue, WAIT_CODES, type LaunchQueuePorts } from "../src/server/runtime/launch-queue/service";
import { createJobCommandSchema } from "../src/shared/contracts/job";
import { seed } from "./role-types.test";

function setup() {
  const db = openMigratedDatabase(new Database(":memory:"));
  const s = seed(db);
  const job = (title: string, priority: "low" | "normal" | "high" | "urgent" = "normal") => {
    const created = s.store.createJob(s.ctx, {
      ...createJobCommandSchema.parse({ requestId: randomUUID(), bindingId: s.ctx.allowedBindingIds[0], departmentId: s.departmentId, title, brief: "Бриф.", acceptance: "Критерий.", assignedAgentId: s.developer, priority }),
    });
    if (!created.ok) throw new Error(created.error.message);
    return created.value;
  };
  return { db, s, job };
}

describe("launch queue", () => {
  it("orders by priority, then by request time", () => {
    const { db, job } = setup();
    const a = job("Обычная");
    const b = job("Срочная", "urgent");
    const c = job("Ещё обычная");
    enqueueLaunch(db, a.id, "2026-09-17T10:00:00.000Z");
    enqueueLaunch(db, c.id, "2026-09-17T10:05:00.000Z");
    enqueueLaunch(db, b.id, "2026-09-17T10:10:00.000Z");
    enqueueLaunch(db, a.id, "2026-09-17T11:00:00.000Z");
    expect(listLaunchQueue(db).map((row) => [row.jobId, row.position])).toEqual([[b.id, 1], [a.id, 2], [c.id, 3]]);
    expect(dequeueLaunch(db, a.id)).toBe(true);
    expect(dequeueLaunch(db, a.id)).toBe(false);
  });

  it("keeps waiting jobs with the reason, launches when allowed and drops refused ones with a comment", async () => {
    const { db, s, job } = setup();
    const waiting = job("Ждёт слот");
    const ready = job("Готова");
    const broken = job("Сломана");
    for (const [index, item] of [waiting, ready, broken].entries()) enqueueLaunch(db, item.id, `2026-09-17T10:0${index}:00.000Z`);
    const comments: [string, string][] = [];
    const launched: string[] = [];
    const ports: LaunchQueuePorts = {
      db,
      getJob: (id) => s.store.getJob(id),
      checkLimits: async (item) => (item.id === waiting.id ? fail("concurrency_limit_reached", "Уже работают запусков отдела: 2, лимит 2.") : ok({ warnings: [] })),
      launch: async (item) => {
        if (item.id === broken.id) return fail("machine_offline", "Машина не в сети");
        launched.push(item.id);
        return ok({});
      },
      comment: (item, text) => {
        comments.push([item.id, text]);
        return true;
      },
      now: () => "2026-09-17T10:10:00.000Z",
    };
    expect(await sweepLaunchQueue(ports)).toEqual({ launched: 1, removed: 1 });
    expect(launched).toEqual([ready.id]);
    expect(listLaunchQueue(db)).toEqual([{ jobId: waiting.id, position: 1, requestedAt: "2026-09-17T10:00:00.000Z", waitingReason: "Уже работают запусков отдела: 2, лимит 2." }]);
    expect(comments.find(([id]) => id === broken.id)?.[1]).toContain("Снята с очереди запуска: Машина не в сети");
    expect(comments.find(([id]) => id === ready.id)?.[1]).toContain("Запущена из очереди");
  });

  it("waits out a machine that blinked, tells the owner, and gives up only after an hour", async () => {
    const { db, s, job } = setup();
    const item = job("Проверка");
    enqueueLaunch(db, item.id, "2026-09-17T10:00:00.000Z");
    const comments: string[] = [];
    const owner: { text: string; dedupeKey: string }[] = [];
    let now = "2026-09-17T10:00:10.000Z";
    const ports: LaunchQueuePorts = {
      db,
      getJob: (id) => s.store.getJob(id),
      checkLimits: async () => ok({ warnings: [] }),
      // The real failure that left a review hanging: the host answered 502 for a moment.
      launch: async () => fail("launch_not_started", "HTTP 502: Host is not connected"),
      comment: (_item, text) => {
        comments.push(text);
        return true;
      },
      notifyOwner: (input) => owner.push({ text: input.text, dedupeKey: input.dedupeKey }),
      now: () => now,
    };
    expect(await sweepLaunchQueue(ports)).toEqual({ launched: 0, removed: 0 });
    expect(listLaunchQueue(db)[0]?.waitingReason).toContain("502");
    expect(owner).toEqual([]);
    now = "2026-09-17T10:12:00.000Z";
    expect(await sweepLaunchQueue(ports)).toEqual({ launched: 0, removed: 0 });
    expect(owner[0]?.text).toContain("ждёт в очереди запуска дольше");
    now = "2026-09-17T11:30:00.000Z";
    expect(await sweepLaunchQueue(ports)).toEqual({ launched: 0, removed: 1 });
    expect(comments.at(-1)).toContain("Снята с очереди запуска");
    expect(owner.at(-1)?.text).toContain("Снята с очереди запуска");
    // The dropped row stays: the queue does not retry in a loop and the repair leaves it alone.
    expect(listLaunchQueue(db)).toEqual([]);
    expect(repairQueuedJobs(db, "2026-09-17T12:00:00.000Z")).toEqual([]);
    expect(await sweepLaunchQueue(ports)).toEqual({ launched: 0, removed: 0 });
    expect(comments.filter((text) => text.includes("Снята с очереди"))).toHaveLength(1);
    // Putting it back by hand starts a new round.
    enqueueLaunch(db, item.id, "2026-09-17T12:05:00.000Z");
    expect(listLaunchQueue(db).map((row) => row.jobId)).toEqual([item.id]);
  });

  it("puts a queued job with no queue row and no attempt back in line", () => {
    const { db, s, job } = setup();
    const stuck = job("Потерялась");
    const fresh = job("Только что");
    for (const item of [stuck, fresh]) {
      const moved = s.store.transitionJob(s.ctx, { requestId: randomUUID(), jobId: item.id, expectedRevision: item.revision, to: "queued" });
      expect(moved.ok).toBe(true);
    }
    // The job moved to queued long ago; the other one just now.
    db.prepare(`UPDATE agency_job SET updated_at = ? WHERE id = ?`).run("2026-09-17T10:00:00.000Z", stuck.id);
    db.prepare(`UPDATE agency_job SET updated_at = ? WHERE id = ?`).run("2026-09-17T10:09:30.000Z", fresh.id);
    expect(repairQueuedJobs(db, "2026-09-17T10:10:00.000Z")).toEqual([stuck.id]);
    expect(listLaunchQueue(db).map((row) => row.jobId)).toEqual([stuck.id]);
    // The one already in the queue is not repaired twice; the second job waits out its grace.
    expect(repairQueuedJobs(db, "2026-09-17T10:20:00.000Z")).toEqual([fresh.id]);
  });

  it("has no handshake wait class: a launch that did not start is a transient refusal", async () => {
    const { db, s, job } = setup();
    const item = job("Не стартовал");
    enqueueLaunch(db, item.id, "2026-09-17T10:00:00.000Z");
    expect(WAIT_CODES.has("handshake_unready")).toBe(false);
    const mapped = refusalIfLaunchDidNotStart({
      ok: true,
      value: { launched: null, reason: "spawn was not called", reasonCode: "launch_not_authorized" },
    });
    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.error.code).toBe("launch_not_started");
    const result = await sweepLaunchQueue({
      db,
      getJob: (id) => s.store.getJob(id),
      checkLimits: async () => ok({ warnings: [] }),
      launch: async () => mapped,
      comment: () => true,
      now: () => "2026-09-17T12:00:00.000Z",
    });
    expect(result).toEqual({ launched: 0, removed: 0 });
    expect(listLaunchQueue(db).map((row) => row.jobId)).toEqual([item.id]);
    expect(listLaunchQueue(db)[0]?.waitingReason).toContain("spawn was not called");
  });

  it("keeps a job when the pinned skill hash is stale", async () => {
    const { db, s, job } = setup();
    const item = job("Ждёт закрепление навыка");
    enqueueLaunch(db, item.id, "2026-09-17T10:00:00.000Z");
    expect(WAIT_CODES.has("catalog_skill_hash_mismatch")).toBe(true);
    const result = await sweepLaunchQueue({
      db,
      getJob: (id) => s.store.getJob(id),
      checkLimits: async () => ok({ warnings: [] }),
      launch: async () => ({ ok: false, error: { code: "catalog_skill_hash_mismatch", message: "skill hash stale" } }),
      comment: () => true,
      now: () => "2026-09-17T12:00:00.000Z",
    });
    expect(result).toEqual({ launched: 0, removed: 0 });
    expect(listLaunchQueue(db).map((row) => row.jobId)).toEqual([item.id]);
    expect(listLaunchQueue(db)[0]?.waitingReason).toBe("skill hash stale");
  });

  it("does not retry a permanent refusal until its job revision changes", () => {
    const { db, s, job } = setup();
    const item = job("Сняли из-за навыка");
    const moved = s.store.transitionJob(s.ctx, { requestId: randomUUID(), jobId: item.id, expectedRevision: item.revision, to: "queued" });
    expect(moved.ok).toBe(true);
    enqueueLaunch(db, item.id, "2026-09-17T10:00:00.000Z");
    dropFromQueue(db, item.id, "skill hash stale", "2026-09-17T10:01:00.000Z");
    expect(listLaunchQueue(db)).toEqual([]);
    expect(reopenDroppedAssignedJobs(db, "2026-09-17T10:02:00.000Z")).toEqual([]);
    const updated = s.store.updateJob(s.ctx, { requestId: randomUUID(), jobId: item.id, expectedRevision: s.store.getJob(item.id)!.revision, brief: "Вход исправлен." });
    expect(updated.ok).toBe(true);
    expect(reopenDroppedAssignedJobs(db, "2026-09-17T10:03:00.000Z")).toEqual([item.id]);
    expect(listLaunchQueue(db).map((row) => row.jobId)).toEqual([item.id]);
  });

  it("lists assigned backlog jobs that have no attempt yet", () => {
    const { db, s, job } = setup();
    const assigned = job("С исполнителем");
    const unassigned = s.store.createJob(s.ctx, {
      ...createJobCommandSchema.parse({
        requestId: randomUUID(),
        bindingId: s.ctx.allowedBindingIds[0],
        departmentId: s.departmentId,
        title: "Черновик",
        brief: "Бриф.",
        acceptance: "Критерий.",
        assignedAgentId: null,
      }),
    });
    expect(unassigned.ok).toBe(true);
    expect(listAssignedBacklogJobIds(db)).toEqual([assigned.id]);
  });

  it("forgets a job that was launched or canceled by hand", async () => {
    const { db, s, job } = setup();
    const item = job("Отменена");
    enqueueLaunch(db, item.id, "2026-09-17T10:00:00.000Z");
    const canceled = s.store.transitionJob(s.ctx, { requestId: randomUUID(), jobId: item.id, expectedRevision: item.revision, to: "canceled" });
    expect(canceled.ok).toBe(true);
    const result = await sweepLaunchQueue({
      db,
      getJob: (id) => s.store.getJob(id),
      checkLimits: async () => ok({ warnings: [] }),
      launch: async () => ok({}),
      comment: () => true,
      now: () => "2026-09-17T10:10:00.000Z",
    });
    expect(result).toEqual({ launched: 0, removed: 1 });
    expect(listLaunchQueue(db)).toEqual([]);
  });
});

describe("automatic assignment", () => {
  it("picks the lead, or the member of the role type with the fewest open jobs", () => {
    const { db, s, job } = setup();
    const policyId = (db.prepare(`SELECT id FROM agency_policy_version LIMIT 1`).get() as { id: string }).id;
    const second = s.store.provisionAgent(s.bootstrap, {
      requestId: randomUUID(),
      name: "Второй разработчик",
      state: "active",
      version: { version: 1, role: "Разработчик", instructions: "Код.", providerId: "claude-code", model: "claude-sonnet-5", skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"], mcpIds: [], policyVersionId: policyId },
    });
    if (!second.ok) throw new Error(second.error.message);
    expect(s.store.addMembership(s.bootstrap, { requestId: randomUUID(), departmentId: s.departmentId, agentId: second.value.agent.id, role: "executor" }).ok).toBe(true);
    job("Нагрузка первого разработчика");
    const create = (assignment: "lead" | "executor" | "reviewer") =>
      s.store.createJob(s.ctx, {
        ...createJobCommandSchema.parse({ requestId: randomUUID(), bindingId: s.ctx.allowedBindingIds[0], departmentId: s.departmentId, title: `Авто ${assignment}`, brief: "Бриф.", acceptance: "Критерий.", assignment }),
      });
    const toSecond = create("executor");
    expect(toSecond.ok && toSecond.value.assignedAgentId).toBe(second.value.agent.id);
    expect((() => { const r = create("reviewer"); return r.ok && r.value.assignedAgentId; })()).toBe(s.reviewer);
    expect((() => { const r = create("lead"); return r.ok && r.value.assignedAgentId; })()).toBe(s.lead);
  });

  it("explains when the department has nobody of that role type", () => {
    const { db, s } = setup();
    db.prepare(`UPDATE agency_agent SET state = 'paused' WHERE id = ?`).run(s.reviewer);
    const result = s.store.createJob(s.ctx, {
      ...createJobCommandSchema.parse({ requestId: randomUUID(), bindingId: s.ctx.allowedBindingIds[0], departmentId: s.departmentId, title: "Проверка", brief: "Бриф.", acceptance: "Критерий.", assignment: "reviewer" }),
    });
    expect(result.ok ? null : result.error.code).toBe("no_member_for_assignment");
  });
});
