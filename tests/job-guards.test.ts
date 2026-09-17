import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { reworkBlocksReview, reworkText, resolveRework } from "../src/server/runtime/rework/service";
import { MANUAL_STATUS_TARGETS, manualStatusOptions } from "../src/app/data/job-lifecycle";
import { jobKanbanMoveRefusal } from "../src/app/data/job-lifecycle";
import { seed } from "./role-types.test";

function open() {
  return openMigratedDatabase(new Database(":memory:"));
}

describe("server guards on jobs", () => {
  it("refuses assigning a paused employee", () => {
    const db = open();
    const s = seed(db);
    const agent = s.store.getAgent(s.developer)!;
    const paused = s.store.updateAgent(s.bootstrap, { requestId: randomUUID(), expectedRevision: agent.revision, agentId: agent.id, state: "paused" });
    expect(paused.ok).toBe(true);
    expect(() => s.job("Задача", s.developer)).toThrow(/is paused/);
    db.close();
  });

  it("refuses the assignee as a reviewer of the same job", () => {
    const db = open();
    const s = seed(db);
    const job = s.job("Задача", s.developer);
    const moved = s.store.updateJob(s.ctx, { requestId: randomUUID(), jobId: job.id, expectedRevision: job.revision, reviewerAgentIds: [s.developer] });
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.error.code).toBe("assignee_is_reviewer");
    db.close();
  });

  it("keeps the assignee and allows no cancel while a thread may be working", () => {
    const db = open();
    const s = seed(db);
    const job = s.job("Задача", s.developer);
    s.attempt(job.id, "running");
    const reassigned = s.store.updateJob(s.ctx, { requestId: randomUUID(), jobId: job.id, expectedRevision: job.revision, assignedAgentId: s.lead });
    expect(reassigned.ok).toBe(false);
    if (!reassigned.ok) expect(reassigned.error.code).toBe("job_has_live_run");
    const retitled = s.store.updateJob(s.ctx, { requestId: randomUUID(), jobId: job.id, expectedRevision: job.revision, title: "Новое название" });
    expect(retitled.ok).toBe(true);
    const current = s.store.getJob(job.id)!;
    const userCtx = { ...s.ctx, actor: { kind: "user" as const, userId: "usr_owner" } };
    const canceled = s.store.transitionJob(userCtx, { requestId: randomUUID(), jobId: job.id, expectedRevision: current.revision, to: "canceled" });
    expect(canceled.ok).toBe(false);
    if (!canceled.ok) expect(canceled.error.code).toBe("job_has_live_run");
    db.close();
  });

  it("refuses removing a member who still has open jobs in the department", () => {
    const db = open();
    const s = seed(db);
    s.job("Задача", s.developer);
    const removed = s.store.removeMembership(s.bootstrap, { requestId: randomUUID(), departmentId: s.departmentId, agentId: s.developer });
    expect(removed.ok).toBe(false);
    if (!removed.ok) expect(removed.error.code).toBe("member_has_open_jobs");
    db.close();
  });
});

describe("rework", () => {
  it("tells the worker what to fix and blocks review on the returned version only", () => {
    const text = reworkText("AG-7", "Итог не сходится.", "ab".repeat(32), "7a3f0c52-8d1e-4d8e-9a55-0f4a3a6b1c11");
    expect(text).toContain("владелец вернул AG-7 на доработку");
    expect(text).toContain("Итог не сходится.");
    expect(text).toContain("Прежняя версия abababab");
    expect(text).toContain("agency.rework:7a3f0c52-8d1e-4d8e-9a55-0f4a3a6b1c11");

    const db = open();
    const s = seed(db);
    const job = s.job("Задача", s.developer);
    db.prepare(
      `INSERT INTO agency_rework (request_id, job_id, attempt_id, thread_id, returned_hash, comment, send_state, resolved_at, created_at, updated_at)
       VALUES ('req-1', ?, 'run_1', 'thr_1', 'old-hash', 'Итог', 'confirmed', NULL, 'now', 'now')`,
    ).run(job.id);
    expect(reworkBlocksReview(db, job.id, "old-hash")).toBe(true);
    expect(reworkBlocksReview(db, job.id, "new-hash")).toBe(false);
    resolveRework(db, job.id, "later");
    expect(reworkBlocksReview(db, job.id, "old-hash")).toBe(false);
    db.close();
  });
});

describe("manual statuses", () => {
  it("offers only statuses the owner may set by hand", () => {
    expect(manualStatusOptions("backlog")).toEqual(["backlog", "queued", "canceled"]);
    expect(manualStatusOptions("running")).toEqual(["running"]);
    expect(MANUAL_STATUS_TARGETS.waiting_input).toEqual([]);
    expect(jobKanbanMoveRefusal({ state: "running" }, "canceled")).toContain("остановите запуск");
    expect(jobKanbanMoveRefusal({ state: "backlog" }, "review")).toContain("ставит сама работа");
    expect(jobKanbanMoveRefusal({ state: "blocked" }, "queued")).toBeNull();
  });
});
