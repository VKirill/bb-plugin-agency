import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { knowledgeBlock, listKnowledge, saveKnowledge, setKnowledgeStatus } from "../src/server/knowledge/store";
import { listGoals, saveGoal, setJobGoal } from "../src/server/organization/goals";
import { openEscalations, setDepartmentParent, sweepEscalations } from "../src/server/organization/hierarchy";
import { agentMetrics } from "../src/server/insights/metrics";
import { archivedJobIds, deleteSavedView, listSavedViews, saveSavedView, searchJobs } from "../src/server/insights/archive";
import { resolveAlias } from "../src/server/cli/aliases";
import { seed } from "./role-types.test";

const NOW = "2026-09-17T10:00:00.000Z";
const open = () => {
  const db = openMigratedDatabase(new Database(":memory:"));
  return { db, s: seed(db) };
};

describe("knowledge", () => {
  it("delivers only accepted materials of the scope, and an employee's save is a proposal", () => {
    const { db, s } = open();
    const agency = saveKnowledge(db, { expectedRevision: 0, title: "Тон", body: "Коротко.", source: "Владелец", scopeKind: "agency", scopeId: null }, { proposedBy: null }, NOW);
    expect(agency.ok && agency.value.status).toBe("accepted");
    const proposal = saveKnowledge(db, { expectedRevision: 0, title: "Идея", body: "Черновик.", source: "Сотрудник", scopeKind: "department", scopeId: s.departmentId }, { proposedBy: s.developer }, NOW);
    expect(proposal.ok && proposal.value.status).toBe("proposal");
    expect(knowledgeBlock(db, "department", s.departmentId).ids).toEqual([]);
    if (!proposal.ok) return;
    expect(setKnowledgeStatus(db, { id: proposal.value.id, expectedRevision: 1, status: "accepted" }, NOW).ok).toBe(true);
    // Обычная запись приходит строкой индекса: тело сотрудник берёт по id.
    expect(knowledgeBlock(db, "department", s.departmentId).text).toContain("- [fact] Идея — Черновик. (");
    expect(knowledgeBlock(db, "department", s.departmentId).text).not.toContain("### Идея");
    expect(knowledgeBlock(db, "agency", null).text).toContain("Коротко.");
    expect(saveKnowledge(db, { expectedRevision: 0, title: "x", body: "y", source: "z", scopeKind: "project", scopeId: null }, { proposedBy: null }, NOW).ok).toBe(false);
    expect(listKnowledge(db, { status: "accepted" })).toHaveLength(2);
  });

  it("keeps the important and pinned materials whole and the rest as an index", () => {
    const { db, s } = open();
    saveKnowledge(
      db,
      { expectedRevision: 0, title: "Правило релиза", summary: "Релиз только после зелёных тестов.", body: "Полный текст правила релиза.", kind: "procedure", importance: 90, source: "Владелец", scopeKind: "department", scopeId: s.departmentId },
      { proposedBy: null },
      NOW,
    );
    saveKnowledge(
      db,
      { expectedRevision: 0, title: "Мелочь", summary: "Незначимая заметка.", body: "Тело мелочи.", kind: "fact", importance: 20, source: "Владелец", scopeKind: "department", scopeId: s.departmentId },
      { proposedBy: null },
      NOW,
    );
    const block = knowledgeBlock(db, "department", s.departmentId);
    expect(block.text).toContain("- [procedure] Правило релиза — Релиз только после зелёных тестов.");
    expect(block.text).toContain("- [fact] Мелочь — Незначимая заметка.");
    // Важная запись приходит целиком, незначимая — только строкой.
    expect(block.text).toContain("Полный текст правила релиза.");
    expect(block.text).not.toContain("Тело мелочи.");
    // Обе записи закреплены в снимке: правка любой из них видна по хэшу.
    expect(block.ids).toHaveLength(2);
  });
});

describe("goals and hierarchy", () => {
  it("links only main jobs to a goal and counts progress", () => {
    const { db, s } = open();
    const goal = saveGoal(db, { expectedRevision: 0, title: "Запустить продукт", description: "", status: "active", dueAt: null }, NOW);
    if (!goal.ok) throw new Error(goal.error.message);
    const main = s.job("Главная", s.lead);
    const child = s.store.createJob(s.ctx, { requestId: randomUUID(), bindingId: s.ctx.allowedBindingIds[0]!, departmentId: s.departmentId, title: "Под", brief: "Б.", acceptance: "К.", parentJobId: main.id, assignedAgentId: s.developer, priority: "normal", dueAt: null });
    if (!child.ok) throw new Error(child.error.message);
    expect(setJobGoal(db, { jobId: child.value.id, goalId: goal.value.id }, NOW).ok).toBe(false);
    expect(setJobGoal(db, { jobId: main.id, goalId: goal.value.id }, NOW).ok).toBe(true);
    expect(listGoals(db)[0]!.progress).toEqual({ total: 1, done: 0, open: 1 });
  });

  it("refuses a cycle and escalates a long-blocked main job once", () => {
    const { db, s } = open();
    const parent = s.store.provisionDepartment(s.bootstrap, { requestId: randomUUID(), name: "Управление", leadAgentId: s.lead, process: { instructions: "## Принимаем\n- Решения", acceptance: "Решение.", reviewPolicy: { required: false } } });
    if (!parent.ok) throw new Error(parent.error.message);
    const parentId = parent.value.department.id;
    expect(setDepartmentParent(db, { departmentId: s.departmentId, parentDepartmentId: parentId }, NOW).ok).toBe(true);
    expect(setDepartmentParent(db, { departmentId: parentId, parentDepartmentId: s.departmentId }, NOW)).toMatchObject({ ok: false, error: { code: "department_cycle" } });
    const job = s.job("Застряла", s.developer);
    const moved = s.store.transitionJob(s.ctx, { requestId: randomUUID(), jobId: job.id, expectedRevision: job.revision, to: "blocked" });
    expect(moved.ok).toBe(true);
    db.prepare(`UPDATE agency_activity SET timestamp = '2026-09-15T00:00:00.000Z' WHERE job_id = ? AND kind = 'job_transitioned'`).run(job.id);
    const comments: string[] = [];
    const ports = { db, escalateAfterHours: () => 24, comment: (_id: string, text: string) => { comments.push(text); }, now: () => new Date(NOW) };
    expect(sweepEscalations(ports)).toBe(1);
    expect(sweepEscalations(ports)).toBe(0);
    expect(openEscalations(db)).toEqual({ [job.id]: parentId });
    expect(comments[0]).toContain("Эскалировано в отдел «Управление»");
  });
});

describe("metrics, archive, search, views", () => {
  it("counts an employee's load and outcomes", () => {
    const { db, s } = open();
    const done = s.job("Сделано", s.developer);
    db.prepare(`UPDATE agency_job SET state = 'done', closed_at = '2026-09-16T10:00:00.000Z' WHERE id = ?`).run(done.id);
    db.prepare(`UPDATE agency_activity SET timestamp = '2026-09-15T10:00:00.000Z' WHERE job_id = ?`).run(done.id);
    s.job("В работе", s.developer);
    const metrics = agentMetrics(db, s.developer, new Date(NOW));
    expect(metrics).toMatchObject({ open: 1, done30d: 1, firstPassPercent: 100 });
    expect(metrics.medianLeadHours).toBe(24);
  });

  it("archives a fully closed old tree and finds jobs by text", () => {
    const { db, s } = open();
    const old = s.job("Старый счёт", s.lead);
    db.prepare(`UPDATE agency_job SET state = 'done', closed_at = '2026-07-01T00:00:00.000Z' WHERE id = ?`).run(old.id);
    const fresh = s.job("Новый счёт", s.lead);
    const archived = archivedJobIds(db, 30, new Date(NOW));
    expect([...archived]).toEqual([old.id]);
    expect(archivedJobIds(db, 0, new Date(NOW)).size).toBe(0);
    const hits = searchJobs(db, { query: "счёт", archivedIds: archived });
    expect(hits.map((hit) => [hit.key, hit.archived])).toEqual(expect.arrayContaining([[old.key, true], [fresh.key, false]]));
    expect(searchJobs(db, { query: "с", archivedIds: archived })).toEqual([]);
    const bindingId = (db.prepare(`SELECT binding_id FROM agency_job WHERE id = ?`).get(old.id) as { binding_id: string }).binding_id;
    expect(searchJobs(db, { query: "счёт", archivedIds: archived, bindingIds: [bindingId] })).toHaveLength(2);
    expect(searchJobs(db, { query: "счёт", archivedIds: archived, bindingIds: ["bnd_other"] })).toEqual([]);
    expect(searchJobs(db, { query: "счёт", archivedIds: archived, bindingIds: [] })).toEqual([]);
  });

  it("saves, lists and deletes views", () => {
    const { db } = open();
    const view = saveSavedView(db, { name: "Срочное", filters: { priority: "Срочный", "bad key!": "x" } }, NOW);
    expect(view.ok && view.value.filters).toEqual({ priority: "Срочный" });
    expect(listSavedViews(db)).toHaveLength(1);
    if (view.ok) expect(deleteSavedView(db, view.value.id)).toBe(true);
  });

  it("routes the new CLI aliases", () => {
    for (const [argv, operation] of [
      [["knowledge", "list"], "listKnowledge"],
      [["goal", "link"], "setJobGoal"],
      [["job", "search"], "searchJobs"],
      [["agent", "metrics"], "agentMetrics"],
    ] as const) {
      expect(resolveAlias([...argv])).toBe(operation);
    }
  });
});
