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
  it("keeps a lead-arranged predeploy/final reviewer and asks for exact final resolution without adopting its old verdict", async () => {
    const t = setup(); const reviewer = t.s.job("Single predeploy and final review", t.s.reviewer);
    t.db.prepare("UPDATE agency_job SET parent_job_id = ?, state = 'running' WHERE id = ?").run(t.main.id, reviewer.id);
    t.s.input(reviewer.id, t.work.id);
    const count = t.db.prepare("SELECT COUNT(*) AS n FROM agency_job").get();
    expect(await startAutoReview(t.ports, t.work.id)).toBe("manual");
    expect(t.queued).toEqual([]); expect(t.attached).toEqual([reviewer.id]);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM agency_job").get()).toEqual(count);
    expect(t.db.prepare("SELECT outcome, review_job_id FROM agency_auto_review WHERE job_id = ?").get(t.work.id)).toEqual({ outcome: "manual", review_job_id: null });
    expect(t.comments[0]).toContain(reviewer.key); expect(t.comments[0]).toContain("reviewResolution");
    expect(await startAutoReview(t.ports, t.work.id)).toBe("pending"); expect(t.comments).toHaveLength(1);
    expect(t.s.store.getJob(reviewer.id)?.state).toBe("running");
    t.db.close();
  });
  it.each(["canceled", "done", "unrelated_parent", "other_work"])("does not reserve a reviewer from %s", async (scope) => {
    const t = setup(); const reviewer = t.s.job("Other review", t.s.reviewer);
    t.db.prepare("UPDATE agency_job SET parent_job_id = ?, state = ? WHERE id = ?")
      .run(scope === "unrelated_parent" ? null : t.main.id, ["canceled", "done"].includes(scope) ? scope : "running", reviewer.id);
    t.s.input(reviewer.id, scope === "other_work" ? t.main.id : t.work.id);
    expect(await startAutoReview(t.ports, t.work.id)).toBe("created");
    expect(t.queued).toHaveLength(1); expect(t.queued[0]).not.toBe(reviewer.id);
    t.db.close();
  });
  it("does not choose between two overlapping reviews or create a third", async () => {
    const t = setup();
    for (const name of ["Review A", "Review B"]) {
      const reviewer = t.s.job(name, t.s.reviewer);
      t.db.prepare("UPDATE agency_job SET parent_job_id = ?, state = 'running' WHERE id = ?").run(t.main.id, reviewer.id);
      t.s.input(reviewer.id, t.work.id);
    }
    expect(await startAutoReview(t.ports, t.work.id)).toBe("manual");
    expect(t.queued).toEqual([]); expect(t.attached).toEqual([]);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM agency_job").get()).toEqual({ n: 4 });
    t.db.close();
  });

  it("creates one review next to the handed-in work, assigns a reviewer and queues it", async () => {
    const t = setup();
    expect(await startAutoReview(t.ports, t.work.id)).toBe("created");
    expect(await startAutoReview(t.ports, t.work.id)).toBe("pending");
    const review = (t.db.prepare(`SELECT id FROM agency_job WHERE title LIKE 'Проверка %'`).all() as { id: string }[]).map((row) => t.s.store.getJob(row.id)!);
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ parentJobId: t.main.id, assignedAgentId: t.s.reviewer, priority: "high" });
    expect(review[0]!.brief).toContain(`версии v2 результата ${t.work.key}`);
    expect(t.attached).toEqual([review[0]!.id]);
    expect(t.queued).toEqual([review[0]!.id]);
    expect(t.comments[0]).toContain(`Автопроверка: создана ${review[0]!.key} по версии v2, проверка в очереди запуска`);
  });

  it("copies normative inputs before queueing the review (AG-191)", async () => {
    const t = setup();
    const spec = t.s.job("Нормативная спецификация", t.s.lead);
    t.s.input(t.work.id, spec.id);
    const sources: string[] = [];
    t.ports.attachInput = async (_review, source) => { sources.push(source.id); return ok({}); };
    t.ports.queue = review => {
      expect(sources).toEqual([t.work.id, spec.id]);
      return ok(review.id);
    };
    expect(await startAutoReview(t.ports, t.work.id)).toBe("created");
    t.db.close();
  });

  it("never queues a review with an inherited input that failed to attach", async () => {
    const t = setup();
    const spec = t.s.job("Спецификация", t.s.lead);
    t.s.input(t.work.id, spec.id);
    t.ports.attachInput = async (_review, source) => source.id === spec.id ? fail("input_missing", "missing spec") : ok({});
    expect(await startAutoReview(t.ports, t.work.id)).toBe("failed");
    expect(t.queued).toEqual([]);
    t.db.close();
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
