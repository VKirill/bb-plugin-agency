import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyAgencyMigrations, migrations } from "../src/server/db/migrations";
import { openMigratedDatabase } from "../src/server/db";

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
  ).map((row) => row.name);
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
}

function indexes(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map((row) => row.name);
}

describe("миграция agency_stale_nudge", () => {
  const sql = migrations.find((item) => item.includes("CREATE TABLE agency_stale_nudge"));

  it("добавлена одной миграцией и не переписывает предыдущие", () => {
    expect(sql).toBeDefined();
    expect(migrations.filter((item) => item.includes("CREATE TABLE agency_stale_nudge"))).toHaveLength(1);
    expect(migrations.indexOf(sql!)).toBeGreaterThanOrEqual(0);
  });

  it("создаёт таблицу на свежей базе", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    expect(tableNames(db)).toContain("agency_stale_nudge");
    expect(columns(db, "agency_stale_nudge")).toEqual([
      "nudge_id",
      "batch_id",
      "job_id",
      "origin_thread_id",
      "state_since",
      "attempt",
      "send_state",
      "dispatch_claimed",
      "queued_message_id",
      "revision_at_send",
      "next_check_at",
      "decision",
      "reason_code",
      "created_at",
    ]);
    expect(indexes(db, "agency_stale_nudge")).toEqual(
      expect.arrayContaining(["agency_stale_nudge_job_idx", "agency_stale_nudge_batch_idx"]),
    );
    applyAgencyMigrations(db);
    expect(tableNames(db)).toContain("agency_stale_nudge");
    db.close();
  });

  it("добавляет таблицу к существующей базе и повторный прогон идемпотентен", () => {
    const raw = new Database(":memory:");
    applyAgencyMigrations(raw, { throughId: migrations.indexOf(sql!) - 1 });
    expect(tableNames(raw)).not.toContain("agency_stale_nudge");
    applyAgencyMigrations(raw);
    expect(tableNames(raw)).toContain("agency_stale_nudge");
    const ids = (raw.prepare(`SELECT id FROM _bb_migrations ORDER BY id`).all() as { id: number }[]).map((row) => row.id);
    expect(ids).toHaveLength(migrations.length);
    applyAgencyMigrations(raw);
    const again = (raw.prepare(`SELECT id FROM _bb_migrations ORDER BY id`).all() as { id: number }[]).map(
      (row) => row.id,
    );
    expect(again).toEqual(ids);
    raw.close();
  });
});
