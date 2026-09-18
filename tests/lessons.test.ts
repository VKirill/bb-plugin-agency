import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { draftLesson, lessonExists, proposeLessonForJob } from "../src/server/knowledge/lessons";
import { listKnowledge } from "../src/server/knowledge/store";
import { seed } from "./role-types.test";

const NOW = "2026-09-20T10:00:00.000Z";

function withRework(db: ReturnType<typeof openMigratedDatabase>, jobId: string, comment: string) {
  db.prepare(
    `INSERT INTO agency_rework (request_id, job_id, attempt_id, thread_id, returned_hash, comment, send_state, created_at, updated_at)
     VALUES (?, ?, 'run_x', 'thr_x', 'hash', ?, 'confirmed', ?, ?)`,
  ).run(randomUUID(), jobId, comment, NOW, NOW);
}

describe("lesson after acceptance", () => {
  it("collects the facts of the job tree", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const main = s.job("Главная задача", s.developer);
    const child = s.store.createJob(s.ctx, {
      requestId: randomUUID(),
      bindingId: s.bindingId,
      departmentId: s.departmentId,
      parentJobId: main.id,
      assignedAgentId: s.developer,
      title: "Подзадача",
      brief: "Бриф.",
      acceptance: "Критерий.",
    } as never);
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    withRework(db, child.value.id, "Не прогнаны тесты перед сдачей.\nПодробности ниже.");

    const draft = draftLesson(db, main.id, NOW)!;
    expect(draft.title).toContain(`Урок из ${main.key}`);
    expect(draft.body).toContain("Подзадач: 1.");
    expect(draft.body).toContain("Кругов доработки: 1.");
    expect(draft.body).toContain("Не прогнаны тесты перед сдачей.");
    expect(draft.summary).toContain(main.key);
    expect(draft.departmentId).toBe(s.departmentId);
  });

  it("writes nothing for a subtask: a lesson belongs to the whole job", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const main = s.job("Главная", s.developer);
    const child = s.store.createJob(s.ctx, {
      requestId: randomUUID(),
      bindingId: s.bindingId,
      departmentId: s.departmentId,
      parentJobId: main.id,
      assignedAgentId: s.developer,
      title: "Часть",
      brief: "Б.",
      acceptance: "К.",
    } as never);
    if (!child.ok) return;
    expect(draftLesson(db, child.value.id, NOW)).toBeNull();
    expect(proposeLessonForJob(db, child.value.id, NOW)).toMatchObject({ ok: true, value: { proposed: null } });
  });

  it("proposes once, as a proposal for the owner, in the department's knowledge", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const main = s.job("Главная задача", s.developer);

    const first = proposeLessonForJob(db, main.id, NOW);
    expect(first.ok && first.value.proposed?.status).toBe("proposal");
    expect(first.ok && first.value.proposed?.kind).toBe("lesson");
    expect(first.ok && first.value.proposed?.scopeId).toBe(s.departmentId);
    expect(lessonExists(db, main.key)).toBe(true);

    // Повторная приёмка версии не плодит предложения.
    const again = proposeLessonForJob(db, main.id, NOW);
    expect(again.ok && again.value.proposed).toBeNull();
    expect(listKnowledge(db, { status: "proposal" })).toHaveLength(1);
    // Пока владелец не принял, урок в запуски не идёт.
    expect(listKnowledge(db, { status: "accepted" })).toHaveLength(0);
  });
});
