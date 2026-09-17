import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fail, ok, type DomainResult } from "../../domain";
import { applyAgencyMigrations } from "../db/migrations";
import type { SqlDatabase } from "../db/sql";

/**
 * Backups of the Agency database.
 *
 * A backup is SQLite's online backup of the live connection: a consistent
 * snapshot including what still sits in the WAL. Restore does not swap the open
 * file: the chosen copy is migrated to the current schema in a temporary file and
 * its rows replace the live rows in one transaction, after an automatic backup
 * of the current state. Secrets (webhook keys, skill pins) live outside the
 * database and are neither saved nor overwritten.
 */

export type BackupFile = { name: string; size: number; createdAt: string };

type DatabaseCtor = new (path: string, options?: { readonly?: boolean }) => SqlDatabase & { close(): void; backup(path: string): Promise<unknown> };

const NAME = /^[A-Za-z0-9._-]+\.db$/;

export function backupsDirFor(db: SqlDatabase): string {
  const live = (db as unknown as { name: string }).name;
  return join(dirname(live), "backups");
}

export async function createBackup(db: SqlDatabase, dir: string, label: string, now: Date): Promise<BackupFile> {
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const name = `agency-${stamp}${label ? `-${label.replace(/[^a-z0-9-]/gi, "").slice(0, 32)}` : ""}.db`;
  const path = join(dir, name);
  await (db as unknown as { backup(path: string): Promise<unknown> }).backup(path);
  return { name, size: statSync(path).size, createdAt: now.toISOString() };
}

export function listBackups(dir: string): BackupFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => NAME.test(name))
    .map((name) => {
      const stat = statSync(join(dir, name));
      return { name, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function userTables(db: SqlDatabase, schema: "main" | "src"): string[] {
  return (db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_bb_migrations' ORDER BY name`).all() as { name: string }[]).map((row) => row.name);
}

export async function restoreBackup(db: SqlDatabase, dir: string, name: string, now: Date): Promise<DomainResult<{ restored: string; safetyBackup: BackupFile; tables: number }>> {
  if (!NAME.test(name) || basename(name) !== name) return fail("invalid_command", "Неверное имя резервной копии.");
  const source = join(dir, name);
  if (!existsSync(source)) return fail("not_found", "Резервная копия не найдена.");
  const Ctor = (db as unknown as { constructor: DatabaseCtor }).constructor;
  const temp = join(dir, `.restore-${now.getTime()}.db`);
  copyFileSync(source, temp);
  let copy: (SqlDatabase & { close(): void }) | null = null;
  try {
    copy = new Ctor(temp);
    const integrity = copy.prepare(`PRAGMA integrity_check`).get() as { integrity_check: string };
    if (integrity.integrity_check !== "ok") return fail("backup_corrupt", "Копия повреждена: проверка целостности SQLite не пройдена.");
    if (!copy.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_bb_migrations'`).get()) {
      return fail("backup_foreign", "Это не резервная копия Агентства.");
    }
    try {
      applyAgencyMigrations(copy);
    } catch (error) {
      return fail("backup_incompatible", `Копию не удалось привести к текущей схеме: ${String(error)}`);
    }
    copy.close();
    copy = null;
    const safetyBackup = await createBackup(db, dir, "before-restore", now);
    db.pragma("foreign_keys = OFF");
    try {
      db.prepare(`ATTACH DATABASE ? AS src`).run(temp);
      try {
        const tables = userTables(db, "main").filter((table) => userTables(db, "src").includes(table));
        db.transaction(() => {
          for (const table of tables) {
            db.prepare(`DELETE FROM main."${table}"`).run();
            db.prepare(`INSERT INTO main."${table}" SELECT * FROM src."${table}"`).run();
          }
        })();
        return ok({ restored: name, safetyBackup, tables: tables.length });
      } finally {
        db.prepare(`DETACH DATABASE src`).run();
      }
    } finally {
      db.pragma("foreign_keys = ON");
    }
  } finally {
    copy?.close();
    rmSync(temp, { force: true });
    rmSync(`${temp}-wal`, { force: true });
    rmSync(`${temp}-shm`, { force: true });
  }
}
