import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { listSkillGrants, listSkillPool, logSkillGrants, setSkillPool } from "../src/server/organization/skill-pool";
import { knowledgeBlock, saveKnowledge } from "../src/server/knowledge/store";
import { seed } from "./role-types.test";

const NOW = "2026-09-20T10:00:00.000Z";

describe("the department's skill library", () => {
  it("keeps what the department may raise, and says who put it there", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    expect(listSkillPool(db, s.departmentId)).toEqual([]);

    const saved = setSkillPool(db, { departmentId: s.departmentId, skillIds: ["skill_drmax", "skill_ru", "skill_drmax"] }, { agentId: s.lead }, NOW);
    expect(saved.ok && saved.value.skillIds).toEqual(["skill_drmax", "skill_ru"]);
    expect(listSkillPool(db, s.departmentId)).toEqual(["skill_drmax", "skill_ru"]);

    // Библиотека — это набор целиком: сохранение без mode заменяет её, а не дописывает.
    setSkillPool(db, { departmentId: s.departmentId, skillIds: ["skill_ru"] }, { agentId: null }, NOW);
    expect(listSkillPool(db, s.departmentId)).toEqual(["skill_ru"]);
    expect(setSkillPool(db, { departmentId: s.departmentId, skillIds: Array.from({ length: 61 }, (_, index) => `s${index}`) }, { agentId: null }, NOW).ok).toBe(false);
  });

  it("merges new ids onto the current library instead of wiping it", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    setSkillPool(db, { departmentId: s.departmentId, skillIds: ["skill_drmax", "skill_ru"] }, { agentId: s.lead }, NOW);
    const merged = setSkillPool(
      db,
      { departmentId: s.departmentId, skillIds: ["skill_app"], mode: "merge" },
      { agentId: s.lead },
      NOW,
    );
    expect(merged.ok && merged.value.skillIds.sort()).toEqual(["skill_app", "skill_drmax", "skill_ru"]);
    expect(listSkillPool(db, s.departmentId).sort()).toEqual(["skill_app", "skill_drmax", "skill_ru"]);
  });

  it("writes every grant down: who got what, for which job and who decided", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    logSkillGrants(
      db,
      [
        { departmentId: s.departmentId, agentId: s.developer, jobId: "job_1", jobKey: "AG-42", skillId: "skill_drmax", skillName: "drmax", decidedBy: "decision-model", confidence: 0.95 },
        { departmentId: s.departmentId, agentId: s.developer, jobId: "job_2", jobKey: "AG-43", skillId: "skill_ru", skillName: "ru-text", decidedBy: "lead", confidence: null },
      ],
      NOW,
    );
    const rows = listSkillGrants(db, { departmentId: s.departmentId });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.skillName).sort()).toEqual(["drmax", "ru-text"]);
    expect(rows.find((row) => row.skillName === "drmax")?.decidedBy).toBe("decision-model");
    expect(listSkillGrants(db, { agentId: "agt_nobody" })).toEqual([]);
  });
});

describe("knowledge focused on one job", () => {
  it("shows the picked records and hides the rest behind a command", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const write = (title: string, importance = 40, kind: "lesson" | "procedure" = "lesson") =>
      saveKnowledge(
        db,
        { expectedRevision: 0, title, summary: `${title}.`, body: `Полный текст: ${title}`, kind, importance, source: "Тест", scopeKind: "department", scopeId: s.departmentId },
        { proposedBy: null },
        NOW,
      );
    const picked = write("Про аудит сайта");
    write("Про пост в канал");
    write("Про график расхода");
    const important = write("Правило релиза", 95, "procedure");
    if (!picked.ok || !important.ok) throw new Error("fixture");

    write("Неподходящий важный урок", 99);
    const focused = knowledgeBlock(db, "department", s.departmentId, new Set([picked.value.id]));
    expect(focused.text).toContain("Полный текст: Про аудит сайта");
    expect(focused.text).not.toContain("Неподходящий важный урок");
    const empty = s.store.knowledgeForLaunch(s.departmentId, s.bindingId, []);
    expect(JSON.stringify(empty)).not.toContain("Про аудит сайта");
    expect(JSON.stringify(empty)).not.toContain("Неподходящий важный урок");
    expect(JSON.stringify(empty)).toContain("Правило релиза");
    // Важная запись остаётся всегда: она действует независимо от задачи.
    expect(focused.text).toContain("Правило релиза");
    expect(focused.text).not.toContain("Про пост в канал");
    expect(focused.text).toContain("Показаны записи под эту задачу: 2 из 5");
    // В снимок попадает ровно то, что сотрудник увидел.
    expect(focused.ids).toHaveLength(2);

    const everything = knowledgeBlock(db, "department", s.departmentId);
    expect(everything.text).toContain("Про пост в канал");
  });
});
