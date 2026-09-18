import { fail, ok, type DomainResult } from "../../domain";
import { DECISION_KEY_SOURCES } from "../../shared/decisions.js";
import { DEFAULT_PASSPORT_SETTINGS, type PassportSettings } from "../../shared/passport.js";
import type { SqlDatabase } from "../db/sql";

/**
 * Настройки писаря паспорта: одна строка на Агентство. Как и у оценщика, здесь нет ключа — только
 * имя переменной: база уходит в резервные копии и в экспорт, а секрету там не место.
 */

export const PASSPORT_SETTINGS_MIGRATION = `CREATE TABLE agency_passport_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    enabled INTEGER NOT NULL,
    base_url TEXT NOT NULL,
    model TEXT NOT NULL,
    key_source TEXT NOT NULL,
    key_name TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL,
    trigger_every_n INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`;

type Row = {
  enabled: number;
  base_url: string;
  model: string;
  key_source: string;
  key_name: string;
  timeout_ms: number;
  trigger_every_n: number;
  revision: number;
};

export function getPassportSettings(db: SqlDatabase): PassportSettings {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agency_passport_settings'`).get()) {
    return DEFAULT_PASSPORT_SETTINGS;
  }
  const row = db.prepare(`SELECT * FROM agency_passport_settings WHERE id = 1`).get() as Row | undefined;
  if (!row) return DEFAULT_PASSPORT_SETTINGS;
  return {
    enabled: row.enabled === 1,
    baseUrl: row.base_url,
    model: row.model,
    keySource: (DECISION_KEY_SOURCES as readonly string[]).includes(row.key_source)
      ? (row.key_source as PassportSettings["keySource"])
      : "env-catalog",
    keyName: row.key_name,
    timeoutMs: row.timeout_ms,
    triggerEveryN: row.trigger_every_n,
    revision: row.revision,
  };
}

export type SavePassportSettingsInput = {
  expectedRevision: number;
  enabled: boolean;
  baseUrl?: string;
  model: string;
  keySource: string;
  keyName: string;
  timeoutMs?: number;
  triggerEveryN?: number;
};

export function savePassportSettings(db: SqlDatabase, input: SavePassportSettingsInput, now: string): DomainResult<PassportSettings> {
  const current = getPassportSettings(db);
  if (current.revision !== input.expectedRevision) {
    return fail("revision_conflict", "Настройки паспорта изменились: перечитайте и повторите.");
  }
  if (!(DECISION_KEY_SOURCES as readonly string[]).includes(input.keySource)) {
    return fail("invalid_command", "Ключ берётся из Env Catalog или из окружения машины.");
  }
  const model = input.model.trim();
  const keyName = input.keyName.trim();
  // Включённый писарь без модели и имени ключа молча не работал бы: лучше отказ в настройках.
  if (input.enabled && (!model || !keyName)) return fail("invalid_command", "Для сборки паспорта нужны модель и имя ключа.");
  const timeoutMs = Math.max(5_000, Math.min(120_000, Math.round(input.timeoutMs ?? current.timeoutMs)));
  const triggerEveryN = Math.max(1, Math.min(200, Math.round(input.triggerEveryN ?? current.triggerEveryN)));
  const revision = current.revision + 1;
  db.prepare(
    `INSERT INTO agency_passport_settings (id, enabled, base_url, model, key_source, key_name, timeout_ms, trigger_every_n, revision, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, base_url = excluded.base_url, model = excluded.model,
       key_source = excluded.key_source, key_name = excluded.key_name, timeout_ms = excluded.timeout_ms,
       trigger_every_n = excluded.trigger_every_n, revision = excluded.revision, updated_at = excluded.updated_at`,
  ).run(input.enabled ? 1 : 0, (input.baseUrl ?? "").trim(), model, input.keySource, keyName, timeoutMs, triggerEveryN, revision, now);
  return ok(getPassportSettings(db));
}
