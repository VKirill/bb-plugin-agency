import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { listKnowledge } from "../src/server/knowledge/store";
import { clusterRemarks, remarkLines, remarkSimilarity, remarkStems, sweepRemarkPatterns } from "../src/server/knowledge/remark-patterns";
import { createJobCommandSchema, type Job } from "../src/shared/contracts/job";
import { seed } from "./role-types.test";

const NOW = new Date("2026-09-17T12:00:00.000Z");

function setup() {
  const db = openMigratedDatabase(new Database(":memory:"));
  const s = seed(db);
  const job = (title: string) => {
    const created = s.store.createJob(s.ctx, createJobCommandSchema.parse({ requestId: randomUUID(), bindingId: s.ctx.allowedBindingIds[0], departmentId: s.departmentId, title, brief: "Б.", acceptance: "К.", assignedAgentId: s.developer }));
    if (!created.ok) throw new Error(created.error.message);
    return created.value;
  };
  const rework = (item: Job, comment: string, at: string) =>
    db
      .prepare(
        `INSERT INTO agency_rework (request_id, job_id, attempt_id, thread_id, returned_hash, comment, send_state, resolved_at, created_at, updated_at)
         VALUES (?, ?, 'run_x', 'thr_x', ?, ?, 'sent', NULL, ?, ?)`,
      )
      .run(randomUUID(), item.id, "a".repeat(64), comment, at, at);
  const reviewerComment = (item: Job, comment: string, at: string) =>
    db
      .prepare(`INSERT INTO agency_activity (id, job_id, actor, kind, causation_id, timestamp, references_json, comment) VALUES (?, ?, ?, 'comment', NULL, ?, '[]', ?)`)
      .run(`act_${randomUUID().replace(/-/g, "")}`, item.id, JSON.stringify({ kind: "agent", agentId: s.reviewer }), at, comment);
  return { db, s, job, rework, reviewerComment };
}

describe("repeated remarks", () => {
  it("splits a remark into lines and compares stems across word forms", () => {
    expect(remarkLines("Вердикт: доработать.\n- Нет проверки мобильной вёрстки на ширине 375 пикселей\n- ок")).toEqual(["Нет проверки мобильной вёрстки на ширине 375 пикселей"]);
    const a = remarkStems("Не проверена мобильная вёрстка на ширине 375 пикселей в AG-12");
    const b = remarkStems("Нет проверки мобильной вёрстки на ширине 375 пикселей");
    expect(remarkSimilarity(a, b).score).toBeGreaterThanOrEqual(0.5);
    expect(remarkSimilarity(a, remarkStems("Ссылки в письме ведут на старый домен сайта")).shared).toBe(0);
  });

  it("proposes department knowledge once when the same remark returns in three jobs", () => {
    const ctx = setup();
    const [one, two, three] = [ctx.job("Лендинг"), ctx.job("Каталог"), ctx.job("Корзина")];
    ctx.rework(one!, "Не проверена мобильная вёрстка на ширине 375 пикселей.", "2026-09-10T10:00:00.000Z");
    ctx.rework(two!, "- Нет проверки мобильной вёрстки на ширине 375 пикселей\n- Заголовок длинный, но это мелочь по тексту", "2026-09-12T10:00:00.000Z");
    expect(sweepRemarkPatterns(ctx.db, NOW, false)).toEqual([]);

    ctx.reviewerComment(three!, "Вердикт: доработать.\n- Мобильная вёрстка на ширине 375 пикселей не проверена", "2026-09-15T10:00:00.000Z");
    const [id] = sweepRemarkPatterns(ctx.db, NOW, false);
    expect(id).toBeTruthy();
    const [item] = listKnowledge(ctx.db, { scopeKind: "department", scopeId: ctx.s.departmentId });
    expect(item).toMatchObject({ status: "proposal", proposedBy: "agency:remarks" });
    expect(item!.title).toBe("Повторяющееся замечание: Не проверена мобильная вёрстка на ширине 375 пикселей.");
    expect(item!.body).toContain(`${one!.key} (2026-09-10), ${two!.key} (2026-09-12), ${three!.key} (2026-09-15)`);
    expect(item!.source).toBe("Агентство: 3 замечаний в 3 задачах за 30 дней");

    ctx.rework(ctx.job("Оплата"), "Мобильная вёрстка на ширине 375 пикселей опять не проверена", "2026-09-16T10:00:00.000Z");
    expect(sweepRemarkPatterns(ctx.db, NOW, false)).toEqual([]);
  });

  it("ignores remarks outside the window and reviewer comments without defects", () => {
    const ctx = setup();
    const jobs = [ctx.job("A"), ctx.job("B"), ctx.job("C")];
    ctx.rework(jobs[0]!, "Не проверена мобильная вёрстка на ширине 375 пикселей.", "2026-07-01T10:00:00.000Z");
    ctx.rework(jobs[1]!, "Не проверена мобильная вёрстка на ширине 375 пикселей.", "2026-09-12T10:00:00.000Z");
    ctx.reviewerComment(jobs[2]!, "Всё хорошо: мобильная вёрстка на ширине 375 пикселей проверена.", "2026-09-15T10:00:00.000Z");
    expect(sweepRemarkPatterns(ctx.db, NOW, false)).toEqual([]);
    expect(clusterRemarks([]).length).toBe(0);
  });
});
