import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { fail, ok } from "../src/domain";
import { openMigratedDatabase } from "../src/server/db";
import { reviewJobText, startAutoReview, type AutoReviewPorts } from "../src/server/runtime/auto-review/service";
import type { Job } from "../src/shared/contracts";
import { seed } from "./role-types.test";

function setup(options: { enabled?: boolean; attach?: "ok" | "fail" } = {}) {
  const db = openMigratedDatabase(new Database(":memory:"));
  const s = seed(db);
  const main = s.job("Главная", s.lead);
  const work = s.store.createJob(s.ctx, {
    requestId: randomUUID(), bindingId: s.ctx.allowedBindingIds[0]!, departmentId: s.departmentId, title: "Реализация", brief: "Бриф.", acceptance: "Критерий.",
    parentJobId: main.id, assignedAgentId: s.developer, priority: "high", dueAt: null,
  });
  if (!work.ok) throw new Error(work.error.message);
  db.prepare(`UPDATE agency_job SET state = 'review' WHERE id = ?`).run(work.value.id);
  const comments: string[] = [];
  const queued: string[] = [];
  const attached: string[] = [];
  const version = { artifactId: "art_work0001", version: 2, hash: "cd".repeat(32) };
  const ports: AutoReviewPorts = {
    db,
    getJob: (id) => s.store.getJob(id),
    enabled: () => options.enabled ?? true,
    memberRole: (departmentId, agentId) => s.store.memberRole(departmentId, agentId),
    latestVersion: () => version,
    createReview: (job, v) => {
      const text = reviewJobText(job, v);
      return s.store.createJob({ actor: { kind: "system" }, allowedBindingIds: [job.bindingId] }, {
        requestId: randomUUID(), bindingId: job.bindingId, departmentId: job.departmentId, title: text.title, brief: text.brief, acceptance: text.acceptance,
        parentJobId: job.parentJobId ?? job.id, assignedAgentId: null, assignment: "reviewer", priority: job.priority, dueAt: job.dueAt,
      });
    },
    attachInput: async (review) => {
      attached.push(review.id);
      return options.attach === "fail" ? fail("self_review", "Проверяющий не может проверять свою работу") : ok({});
    },
    queue: (review: Job) => {
      queued.push(review.id);
      return ok(review.id);
    },
    comment: (_job, text) => {
      comments.push(text);
      return true;
    },
    discard: (review) => {
      s.store.transitionJob(s.ctx, { requestId: randomUUID(), jobId: review.id, expectedRevision: review.revision, to: "canceled" });
    },
    now: () => "2026-09-17T10:00:00.000Z",
  };
  return { db, s, main, work: work.value, ports, comments, queued, attached };
}

describe("executor → reviewer chain", () => {
  it("creates one review next to the handed-in work, assigns a reviewer and queues it", async () => {
    const t = setup();
    expect(await startAutoReview(t.ports, t.work.id)).toBe("created");
    expect(await startAutoReview(t.ports, t.work.id)).toBe("skipped");
    const review = (t.db.prepare(`SELECT id FROM agency_job WHERE title LIKE 'Проверка %'`).all() as { id: string }[]).map((row) => t.s.store.getJob(row.id)!);
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ parentJobId: t.main.id, assignedAgentId: t.s.reviewer, priority: "high" });
    expect(review[0]!.brief).toContain(`версии v2 результата ${t.work.key}`);
    expect(t.attached).toEqual([review[0]!.id]);
    expect(t.queued).toEqual([review[0]!.id]);
    expect(t.comments[0]).toContain(`Автопроверка: создана ${review[0]!.key} по версии v2, проверка в очереди запуска`);
  });

  it("does nothing when the rule is off or the work is not an executor's", async () => {
    const off = setup({ enabled: false });
    expect(await startAutoReview(off.ports, off.work.id)).toBe("skipped");
    const lead = setup();
    lead.db.prepare(`UPDATE agency_job SET state = 'review' WHERE id = ?`).run(lead.main.id);
    expect(await startAutoReview(lead.ports, lead.main.id)).toBe("skipped");
  });

  it("tells the lead when the review could not be prepared", async () => {
    const t = setup({ attach: "fail" });
    expect(await startAutoReview(t.ports, t.work.id)).toBe("failed");
    expect(t.queued).toEqual([]);
    expect(t.comments[0]).toContain("Автопроверка не создана: Проверяющий не может проверять свою работу");
    const review = t.db.prepare(`SELECT state FROM agency_job WHERE title LIKE 'Проверка %'`).get() as { state: string };
    expect(review.state).toBe("canceled");
  });
});
