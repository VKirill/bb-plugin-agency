import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { backupsDirFor, createBackup, listBackups, restoreBackup } from "../src/server/backup/service";
import { seed } from "./role-types.test";

describe("database backup and restore", () => {
  it("backs up a consistent snapshot and restores it after saving the current state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-backup-"));
    const db = openMigratedDatabase(new Database(join(dir, "data.db")));
    db.pragma("journal_mode = WAL");
    const s = seed(db);
    const kept = s.job("До копии", s.lead);
    const backups = backupsDirFor(db);
    const backup = await createBackup(db, backups, "manual", new Date("2026-09-17T10:00:00.000Z"));
    expect(backup.size).toBeGreaterThan(0);
    s.job("После копии", s.lead);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM agency_job`).get() as { n: number }).n).toBe(2);

    const restored = await restoreBackup(db, backups, backup.name, new Date("2026-09-17T11:00:00.000Z"));
    expect(restored.ok).toBe(true);
    const titles = (db.prepare(`SELECT title FROM agency_job`).all() as { title: string }[]).map((row) => row.title);
    expect(titles).toEqual([kept.title]);
    expect(listBackups(backups).map((file) => file.name)).toEqual(expect.arrayContaining([backup.name, restored.ok ? restored.value.safetyBackup.name : ""]));
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("refuses a foreign file and a path outside the backups folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-backup-"));
    const db = openMigratedDatabase(new Database(join(dir, "data.db")));
    const backups = backupsDirFor(db);
    const foreign = new Database(join(dir, "foreign.db"));
    foreign.exec(`CREATE TABLE notes (id TEXT)`);
    foreign.close();
    await createBackup(db, backups, "", new Date());
    const { copyFileSync } = await import("node:fs");
    copyFileSync(join(dir, "foreign.db"), join(backups, "foreign.db"));
    expect(await restoreBackup(db, backups, "foreign.db", new Date())).toMatchObject({ ok: false, error: { code: "backup_foreign" } });
    expect(await restoreBackup(db, backups, "../data.db", new Date())).toMatchObject({ ok: false, error: { code: "invalid_command" } });
  });
});
