import { fail, ok, type DomainResult } from "../../domain";
import {
  DECISION_ENDPOINT_KINDS,
  DECISION_KEY_SOURCES,
  DECISION_POINTS,
  DEFAULT_DECISION_SETTINGS,
  type DecisionSettings,
} from "../../shared/decisions";
import type { SqlDatabase } from "../db/sql";

/**
 * Настройки оценщика. Одна строка на Агентство: включён ли, куда ходим, какой моделью и **под
 * каким именем лежит ключ**. Самого ключа здесь нет и не будет: база уходит в резервные копии и
 * в экспорт, а секрет там не место. Ключ живёт в Env Catalog или в окружении машины.
 */

export const DECISION_SETTINGS_MIGRATION = `CREATE TABLE agency_decision_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    enabled INTEGER NOT NULL,
    endpoint_kind TEXT NOT NULL,
    base_url TEXT NOT NULL,
    model TEXT NOT NULL,
    key_source TEXT NOT NULL,
    key_name TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL,
    points TEXT NOT NULL,
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`;

type Row = {
  enabled: number;
  endpoint_kind: string;
  base_url: string;
  model: string;
  key_source: string;
  key_name: string;
  timeout_ms: number;
  points: string;
  revision: number;
};

const POINT_KEYS = new Set(DECISION_POINTS.map((point) => point.key));

function toSettings(row: Row): DecisionSettings {
  const kind = (DECISION_ENDPOINT_KINDS as readonly string[]).includes(row.endpoint_kind)
    ? (row.endpoint_kind as DecisionSettings["endpointKind"])
    : "openrouter";
  const source = (DECISION_KEY_SOURCES as readonly string[]).includes(row.key_source)
    ? (row.key_source as DecisionSettings["keySource"])
    : "env-catalog";
  const points = row.points.split(",").map((item) => item.trim()).filter((item) => POINT_KEYS.has(item));
  return {
    enabled: row.enabled === 1,
    endpointKind: kind,
    baseUrl: row.base_url,
    model: row.model,
    keySource: source,
    keyName: row.key_name,
    timeoutMs: row.timeout_ms,
    points,
    revision: row.revision,
  };
}

export function getDecisionSettings(db: SqlDatabase): DecisionSettings {
  // База, открытая старой миграцией, этой таблицы ещё не знает: оценщик просто выключен.
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agency_decision_settings'`).get()) {
    return DEFAULT_DECISION_SETTINGS;
  }
  const row = db.prepare(`SELECT * FROM agency_decision_settings WHERE id = 1`).get() as Row | undefined;
  return row ? toSettings(row) : DEFAULT_DECISION_SETTINGS;
}

export type SaveDecisionSettingsInput = {
  expectedRevision: number;
  enabled: boolean;
  endpointKind: string;
  baseUrl?: string;
  model: string;
  keySource: string;
  keyName: string;
  timeoutMs?: number;
  points?: readonly string[];
};

export function saveDecisionSettings(db: SqlDatabase, input: SaveDecisionSettingsInput, now: string): DomainResult<DecisionSettings> {
  const current = getDecisionSettings(db);
  if (current.revision !== input.expectedRevision) {
    return fail("revision_conflict", "Настройки оценщика изменились: перечитайте и повторите.");
  }
  if (!(DECISION_ENDPOINT_KINDS as readonly string[]).includes(input.endpointKind)) {
    return fail("invalid_command", "Неизвестный вид подключения оценщика.");
  }
  if (!(DECISION_KEY_SOURCES as readonly string[]).includes(input.keySource)) {
    return fail("invalid_command", "Ключ берётся из Env Catalog или из окружения машины.");
  }
  const model = input.model.trim();
  const keyName = input.keyName.trim();
  // Включённый оценщик без модели и имени ключа молча не работал бы: лучше отказ в настройках.
  if (input.enabled && (!model || !keyName)) {
    return fail("invalid_command", "Для работы оценщика нужны модель и имя ключа.");
  }
  if (input.endpointKind === "custom" && input.enabled && !(input.baseUrl ?? "").trim()) {
    return fail("invalid_command", "Для своего подключения нужен адрес.");
  }
  const timeoutMs = Math.max(1_000, Math.min(60_000, Math.round(input.timeoutMs ?? current.timeoutMs)));
  const points = (input.points ?? current.points).filter((point) => POINT_KEYS.has(point));
  const revision = current.revision + 1;
  db.prepare(
    `INSERT INTO agency_decision_settings (id, enabled, endpoint_kind, base_url, model, key_source, key_name, timeout_ms, points, revision, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, endpoint_kind = excluded.endpoint_kind, base_url = excluded.base_url,
       model = excluded.model, key_source = excluded.key_source, key_name = excluded.key_name, timeout_ms = excluded.timeout_ms,
       points = excluded.points, revision = excluded.revision, updated_at = excluded.updated_at`,
  ).run(
    input.enabled ? 1 : 0,
    input.endpointKind,
    (input.baseUrl ?? "").trim(),
    model,
    input.keySource,
    keyName,
    timeoutMs,
    points.join(","),
    revision,
    now,
  );
  return ok(getDecisionSettings(db));
}
