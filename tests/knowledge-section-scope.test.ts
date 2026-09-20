import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { knowledgeDecisionRefusal } from "../src/server/knowledge/decide";
import { expireLessons, trimAllDepartments } from "../src/server/knowledge/lessons";
import { knowledgeBlock, listKnowledge, saveKnowledge, type KnowledgeItem } from "../src/server/knowledge/store";
import { collectPassportMaterial } from "../src/server/projects/passport-build";
import { knowledgeScopeKindSchema, knowledgeSectionIdSchema } from "../src/shared/contracts/knowledge-scope";

const NOW = "2026-09-19T17:00:00.000Z";
const BINDING = "bnd_parent_section01";
const SECTION_A = "sec_aaaaaaaaaaaaaaaa";
const SECTION_B = "sec_bbbbbbbbbbbbbbbb";

function db() {
  return openMigratedDatabase(new Database(":memory:"));
}

function saveSection(
  database: ReturnType<typeof db>,
  over: { title?: string; scopeId?: string; parentBindingId?: string | null } = {},
) {
  return saveKnowledge(
    database,
    {
      expectedRevision: 0,
      title: over.title ?? "Заметка раздела",
      body: "Текст раздела.",
      source: "тест",
      scopeKind: "section",
      scopeId: over.scopeId ?? SECTION_A,
      parentBindingId: over.parentBindingId === undefined ? BINDING : over.parentBindingId,
    },
    { proposedBy: null },
    NOW,
  );
}

describe("область знаний раздел", () => {
  it("принимает четыре области и id раздела как у папки project-folders", () => {
    expect(knowledgeScopeKindSchema.parse("section")).toBe("section");
    expect(knowledgeScopeKindSchema.safeParse("workspace").success).toBe(false);
    expect(knowledgeSectionIdSchema.parse(`  ${SECTION_A}  `)).toBe(SECTION_A);
    expect(knowledgeSectionIdSchema.safeParse("").success).toBe(false);
    expect(knowledgeSectionIdSchema.safeParse("x".repeat(161)).success).toBe(false);
  });

  it("изолирует запись раздела от другого раздела и от блока проекта", () => {
    const database = db();
    const saved = saveSection(database);
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.value.parentBindingId).toBe(BINDING);
    expect(saved.value.scopeKind).toBe("section");
    expect(saved.value.scopeId).toBe(SECTION_A);

    expect(listKnowledge(database, { scopeKind: "section", scopeId: SECTION_B })).toEqual([]);
    expect(knowledgeBlock(database, "section", SECTION_B).text).toBe("");
    expect(knowledgeBlock(database, "project", BINDING).text).toBe("");
    expect(knowledgeBlock(database, "section", SECTION_A).text).toContain(saved.value.title);
    expect(listKnowledge(database, { scopeKind: "section", scopeId: SECTION_A }).map((item) => item.id)).toEqual([
      saved.value.id,
    ]);
  });

  it("отклоняет section без id или родителя и parentBindingId у остальных областей", () => {
    const database = db();
    const noScope = saveKnowledge(
      database,
      {
        expectedRevision: 0,
        title: "Без раздела",
        body: "Текст.",
        source: "тест",
        scopeKind: "section",
        scopeId: null,
        parentBindingId: BINDING,
      },
      { proposedBy: null },
      NOW,
    );
    expect(noScope.ok).toBe(false);
    if (noScope.ok) throw new Error("expected fail");
    expect(noScope.error.code).toBe("invalid_command");

    const noParent = saveSection(database, { parentBindingId: null });
    expect(noParent.ok).toBe(false);
    if (noParent.ok) throw new Error("expected fail");
    expect(noParent.error.code).toBe("invalid_command");

    for (const [scopeKind, scopeId] of [
      ["agency", null],
      ["department", "dep_one"],
      ["project", BINDING],
    ] as const) {
      const extra = saveKnowledge(
        database,
        {
          expectedRevision: 0,
          title: `Лишний родитель ${scopeKind}`,
          body: "Текст.",
          source: "тест",
          scopeKind,
          scopeId,
          parentBindingId: BINDING,
        },
        { proposedBy: null },
        NOW,
      );
      expect(extra.ok).toBe(false);
      if (extra.ok) throw new Error("expected fail");
      expect(extra.error.code).toBe("invalid_command");
    }
  });

  it("разрешает одно название в двух разделах и запрещает повтор внутри раздела", () => {
    const database = db();
    const first = saveSection(database, { title: "Одинаковое имя" });
    expect(first.ok).toBe(true);
    const other = saveSection(database, { title: "Одинаковое имя", scopeId: SECTION_B });
    expect(other.ok).toBe(true);
    const twin = saveSection(database, { title: "Одинаковое имя" });
    expect(twin.ok).toBe(false);
    if (twin.ok) throw new Error("expected conflict");
    expect(twin.error.code).toBe("conflict");
  });

  it("не отдаёт записи раздела в паспорт и не даёт руководителю отдела их принять", () => {
    const database = db();
    database
      .prepare(
        `INSERT INTO agency_policy_version (id, allowed_capabilities, cli_host_constraints, secret_refs)
         VALUES ('pol_section_scope', '[]', '{}', '[]')`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO agency_project_binding
          (id, bb_project_id, environment_id, host_id, canonical_root, policy_version_id, section_id, revision, updated_at)
         VALUES (?, 'proj_section_scope', 'env_1', 'host_1', '/tmp/section-scope', 'pol_section_scope', NULL, 1, ?)`,
      )
      .run(BINDING, NOW);
    const project = saveKnowledge(
      database,
      {
        expectedRevision: 0,
        title: "Знание проекта",
        body: "Только проект.",
        source: "тест",
        scopeKind: "project",
        scopeId: BINDING,
      },
      { proposedBy: null },
      NOW,
    );
    expect(project.ok).toBe(true);
    const section = saveSection(database, { title: "Знание раздела" });
    expect(section.ok).toBe(true);

    const material = collectPassportMaterial(database, "proj_section_scope");
    expect(material.text).toContain("Знание проекта");
    expect(material.text).not.toContain("Знание раздела");

    const item = {
      id: "kno_section",
      title: "Знание раздела",
      summary: "Сводка.",
      body: "Текст.",
      kind: "lesson",
      importance: 50,
      pinned: false,
      writeReason: "",
      readCount: 0,
      lastReadAt: null,
      source: "тест",
      scopeKind: "section",
      scopeId: SECTION_A,
      parentBindingId: BINDING,
      status: "accepted",
      proposedBy: null,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    } as unknown as KnowledgeItem;
    const refusal = knowledgeDecisionRefusal("agt_lead", item, "agt_lead");
    expect(refusal?.code).toBe("forbidden");
  });

  it("не ломает бюджет и срок жизни на записях section", () => {
    const database = db();
    expect(saveSection(database).ok).toBe(true);
    expect(trimAllDepartments(database, () => 1, NOW)).toEqual([]);
    expect(expireLessons(database, 1, NOW)).toEqual([]);
    expect(listKnowledge(database, { scopeKind: "section", scopeId: SECTION_A })).toHaveLength(1);
  });
});
