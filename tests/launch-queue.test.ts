import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { fail, ok } from "../src/domain";
import { openMigratedDatabase } from "../src/server/db";
import { dequeueLaunch, enqueueLaunch, listLaunchQueue, sweepLaunchQueue, type LaunchQueuePorts } from "../src/server/runtime/launch-queue/service";
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
