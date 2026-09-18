import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { draftLesson, expireLessons, lessonExists, proposeLessonForJob, trimDepartmentMemory } from "../src/server/knowledge/lessons";
import { listKnowledge, markKnowledgeRead, saveKnowledge, type KnowledgeItem } from "../src/server/knowledge/store";
import { knowledgeDecisionRefusal } from "../src/server/knowledge/decide";
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

  it("lets the department keep the lesson itself when the rule says so", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const main = s.job("Сама запомнила", s.developer);
    const written = proposeLessonForJob(db, main.id, NOW, { autoLearn: true, memoryLimit: 40 });
    // Владелец не нужен: запись сразу в работе, за ним остаётся вето.
    expect(written.ok && written.value.proposed?.status).toBe("accepted");
    expect(listKnowledge(db, { status: "accepted" })).toHaveLength(1);
  });

  it("keeps the department's memory inside its budget, pinned records first", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const write = (title: string, importance: number, pinned = false) =>
      saveKnowledge(
        db,
        { expectedRevision: 0, title, summary: title, body: "Тело.", kind: "lesson", importance, pinned, source: "Тест", scopeKind: "department", scopeId: s.departmentId },
        { proposedBy: null },
        NOW,
      );
    write("Закреплённая", 10, true);
    write("Важная", 90);
    write("Первая мелочь", 20);
    write("Вторая мелочь", 30);

    const archived = trimDepartmentMemory(db, s.departmentId, 2, NOW);
    expect(archived.map((row) => row.title)).toEqual(["Первая мелочь", "Вторая мелочь"]);
    const left = listKnowledge(db, { scopeKind: "department", scopeId: s.departmentId, status: "accepted" }).map((row) => row.title);
    // Закреплённое не вытесняется, даже если у него низкая важность.
    expect(left.sort()).toEqual(["Важная", "Закреплённая"]);
  });

  it("retires an auto lesson after its term and leaves a pinned one", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const old = "2026-01-01T00:00:00.000Z";
    const write = (title: string, pinned: boolean, author: string | null) =>
      saveKnowledge(
        db,
        { expectedRevision: 0, title, summary: title, body: "Тело.", kind: "lesson", pinned, source: "Тест", scopeKind: "department", scopeId: s.departmentId },
        { proposedBy: author },
        old,
      );
    const auto = write("Старый авто-урок", false, "agency:lesson");
    if (auto.ok) db.prepare(`UPDATE agency_knowledge SET status = 'accepted' WHERE id = ?`).run(auto.value.id);
    const pinned = write("Закреплённый урок", true, "agency:lesson");
    if (pinned.ok) db.prepare(`UPDATE agency_knowledge SET status = 'accepted' WHERE id = ?`).run(pinned.value.id);
    const byOwner = write("Урок владельца", false, null);
    expect(byOwner.ok && byOwner.value.status).toBe("accepted");

    const expired = expireLessons(db, 90, NOW);
    expect(expired.map((row) => row.title)).toEqual(["Старый авто-урок"]);
    const left = listKnowledge(db, { status: "accepted" }).map((row) => row.title).sort();
    expect(left).toEqual(["Закреплённый урок", "Урок владельца"]);
  });
});

describe("who decides a knowledge record", () => {
  const LEAD = "agt_lead";
  const item = (over: Partial<KnowledgeItem> = {}) =>
    ({ id: "kn_1", kind: "lesson", scopeKind: "department", scopeId: "dep_1", ...over }) as KnowledgeItem;

  it("lets the owner decide anything: their call has no employee thread", () => {
    expect(knowledgeDecisionRefusal(null, item({ scopeKind: "agency", scopeId: null }), null)).toBeNull();
    expect(knowledgeDecisionRefusal(null, null, null)).toBeNull();
  });

  it("lets the lead decide their own department's lesson", () => {
    expect(knowledgeDecisionRefusal(LEAD, item(), LEAD)).toBeNull();
    expect(knowledgeDecisionRefusal(LEAD, item({ kind: "procedure" }), LEAD)).toBeNull();
    expect(knowledgeDecisionRefusal(LEAD, item({ kind: "reference" }), LEAD)).toBeNull();
  });

  it("refuses everything else: another department, another kind, a plain employee", () => {
    expect(knowledgeDecisionRefusal(LEAD, item(), "agt_other")?.code).toBe("forbidden");
    expect(knowledgeDecisionRefusal("agt_worker", item(), LEAD)?.code).toBe("forbidden");
    // Решение и предпочтение владельца отдел себе не выписывает.
    expect(knowledgeDecisionRefusal(LEAD, item({ kind: "decision" }), LEAD)?.code).toBe("forbidden");
    expect(knowledgeDecisionRefusal(LEAD, item({ kind: "preference" }), LEAD)?.code).toBe("forbidden");
    expect(knowledgeDecisionRefusal(LEAD, item({ scopeKind: "project", scopeId: "proj_1" }), LEAD)?.message).toContain("владелец");
    expect(knowledgeDecisionRefusal(LEAD, null, LEAD)?.code).toBe("not_found");
  });
});

describe("what the department keeps when the budget is full", () => {
  it("drops what nobody opened before what employees keep reading", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const write = (title: string) =>
      saveKnowledge(
        db,
        { expectedRevision: 0, title, summary: title, body: "Тело.", kind: "lesson", importance: 50, source: "Тест", scopeKind: "department", scopeId: s.departmentId },
        { proposedBy: null },
        NOW,
      );
    const read = write("К этому возвращаются");
    write("Никто не открывал");
    if (!read.ok) throw new Error("fixture");
    markKnowledgeRead(db, read.value.id, NOW);

    const archived = trimDepartmentMemory(db, s.departmentId, 1, NOW);
    // Важность и дата у записей одинаковые: решает то, что одну читают, а вторую нет.
    expect(archived.map((row) => row.title)).toEqual(["Никто не открывал"]);
  });
});
