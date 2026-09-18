import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { saveKnowledge, listKnowledge } from "../src/server/knowledge/store";
import { trimAllDepartments } from "../src/server/knowledge/lessons";

/**
 * Бюджет памяти отдела раньше применялся только тогда, когда отдел принимал свой урок сам.
 * Обходчик выравнивает его у всех отделов: иначе индекс в промпте рос бы без предела у отдела,
 * где записи заводит владелец руками.
 */

const NOW = "2026-09-18T09:00:00.000Z";

function seedRecords(db: ReturnType<typeof openMigratedDatabase>, count: number) {
  for (let index = 0; index < count; index += 1) {
    const saved = saveKnowledge(
      db,
      {
        expectedRevision: 0,
        title: `Запись ${index}`,
        body: `Текст записи ${index}`,
        summary: `Сводка ${index}`,
        source: "владелец",
        scopeKind: "department",
        scopeId: "dep_one",
        importance: index === 0 ? 90 : 50,
        pinned: index === 1,
      },
      { proposedBy: null },
      NOW,
    );
    if (!saved.ok) throw new Error(saved.error.message);
  }
}

describe("бюджет памяти отдела", () => {
  it("обходчик выравнивает отдел, который не учится сам", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    seedRecords(db, 8);
    const archived = trimAllDepartments(db, () => 5, NOW);
    expect(archived).toHaveLength(3);
    const left = listKnowledge(db, { scopeKind: "department", scopeId: "dep_one", status: "accepted" });
    expect(left).toHaveLength(5);
    // Закреплённая запись остаётся всегда, важная уходит последней.
    expect(left.some((item) => item.pinned)).toBe(true);
    expect(left.some((item) => item.importance === 90)).toBe(true);
  });

  it("отдел в пределах бюджета не трогается", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    seedRecords(db, 3);
    expect(trimAllDepartments(db, () => 40, NOW)).toHaveLength(0);
  });
});
