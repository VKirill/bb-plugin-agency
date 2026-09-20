import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyAgencyMigrations, migrations } from "../src/server/db/migrations";

const NOW = "2026-09-19T16:00:00.000Z";

const OLD_COLUMNS = [
  "id",
  "title",
  "body",
  "source",
  "scope_kind",
  "scope_id",
  "status",
  "proposed_by",
  "revision",
  "created_at",
  "updated_at",
  "summary",
  "kind",
  "importance",
  "pinned",
  "write_reason",
  "read_count",
  "last_read_at",
] as const;

type OldRow = {
  id: string;
  title: string;
  body: string;
  source: string;
  scope_kind: "agency" | "department" | "project";
  scope_id: string | null;
  status: "proposal" | "accepted" | "archived";
  proposed_by: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  summary: string;
  kind: string;
  importance: number;
  pinned: number;
  write_reason: string;
  read_count: number;
  last_read_at: string;
};

const OLD_ROWS: OldRow[] = [
  {
    id: "kno_agency_old",
    title: "Общее правило",
    body: "Тело агентства.",
    source: "владелец",
    scope_kind: "agency",
    scope_id: null,
    status: "accepted",
    proposed_by: null,
    revision: 3,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: NOW,
    summary: "Сводка агентства.",
    kind: "decision",
    importance: 88,
    pinned: 1,
    write_reason: "Решение владельца.",
    read_count: 7,
    last_read_at: "2026-09-18T12:00:00.000Z",
  },
  {
    id: "kno_dept_old",
    title: "Процедура отдела",
    body: "Тело отдела.",
    source: "руководитель",
    scope_kind: "department",
    scope_id: "dep_old",
    status: "proposal",
    proposed_by: "agt_old",
    revision: 1,
    created_at: "2026-09-02T00:00:00.000Z",
    updated_at: NOW,
    summary: "Сводка отдела.",
    kind: "procedure",
    importance: 40,
    pinned: 0,
    write_reason: "Черновик.",
    read_count: 0,
    last_read_at: "2026-09-02T00:00:00.000Z",
  },
  {
    id: "kno_proj_old",
    title: "Факт проекта",
    body: "Тело проекта.",
    source: "задача",
    scope_kind: "project",
    scope_id: "bnd_old",
    status: "archived",
    proposed_by: null,
    revision: 5,
    created_at: "2026-09-03T00:00:00.000Z",
    updated_at: NOW,
    summary: "Сводка проекта.",
    kind: "fact",
    importance: 15,
    pinned: 0,
    write_reason: "Устарело.",
    read_count: 2,
    last_read_at: "2026-09-10T08:00:00.000Z",
  },
];

describe("миграция области знаний раздел", () => {
  it("переносит старые строки, принимает section и отвергает неизвестный scope_kind", () => {
    const rebuild = migrations.findIndex((sql) => sql.includes("parent_binding_id") && sql.includes("'section'"));
    expect(rebuild).toBeGreaterThan(0);

    const raw = new Database(":memory:");
    applyAgencyMigrations(raw, { throughId: rebuild - 1 });

    const insert = raw.prepare(
      `INSERT INTO agency_knowledge (${OLD_COLUMNS.join(", ")})
       VALUES (${OLD_COLUMNS.map(() => "?").join(", ")})`,
    );
    for (const row of OLD_ROWS) insert.run(...OLD_COLUMNS.map((column) => row[column]));

    expect(() =>
      raw
        .prepare(
          `INSERT INTO agency_knowledge (id, title, body, source, scope_kind, scope_id, status, proposed_by, revision, created_at, updated_at)
           VALUES ('kno_too_soon', 'Рано', 'Текст.', 'тест', 'section', 'sec_1', 'accepted', NULL, 1, ?, ?)`,
        )
        .run(NOW, NOW),
    ).toThrow();

    applyAgencyMigrations(raw);

    for (const row of OLD_ROWS) {
      const stored = raw.prepare(`SELECT * FROM agency_knowledge WHERE id = ?`).get(row.id) as Record<string, unknown>;
      for (const column of OLD_COLUMNS) expect(stored[column]).toBe(row[column]);
      expect(stored.parent_binding_id).toBeNull();
    }

    raw
      .prepare(
        `INSERT INTO agency_knowledge (id, title, body, source, scope_kind, scope_id, parent_binding_id, status, proposed_by, revision, created_at, updated_at)
         VALUES ('kno_section_new', 'Раздел', 'Текст раздела.', 'тест', 'section', 'sec_1', 'bnd_old', 'accepted', NULL, 1, ?, ?)`,
      )
      .run(NOW, NOW);
    expect((raw.prepare(`SELECT COUNT(*) AS n FROM agency_knowledge`).get() as { n: number }).n).toBe(4);

    expect(() =>
      raw
        .prepare(
          `INSERT INTO agency_knowledge (id, title, body, source, scope_kind, scope_id, status, proposed_by, revision, created_at, updated_at)
           VALUES ('kno_unknown', 'Чужое', 'Текст.', 'тест', 'workspace', NULL, 'accepted', NULL, 1, ?, ?)`,
        )
        .run(NOW, NOW),
    ).toThrow();
    raw.close();
  });
});
