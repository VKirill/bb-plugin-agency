import type Database from "better-sqlite3";

export type SqlDatabase = Database.Database;

export function enableForeignKeys(db: SqlDatabase): void {
  db.pragma("foreign_keys = ON");
}

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value);
}
