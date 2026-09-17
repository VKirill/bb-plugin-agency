import { createHash, randomUUID } from "node:crypto";
import { fail, ok, type DomainResult } from "../../domain";
import { defaultTemplates, TEMPLATE_KEYS, type TemplateKey } from "../../shared/templates";
import { agencyLanguage } from "../i18n/language";
import type { SqlDatabase } from "../db/sql";
import { charterAccepts } from "../delegation/instructions";

/**
 * Owner-editable templates and the agency-wide rules.
 *
 * A template is a starting text for forms: saving one changes what new
 * departments, employees and jobs start with, never existing records. A reset
 * deletes the owner's text and the standard one applies again.
 *
 * Agency rules are the top prompt layer for every launched employee. Each save
 * is a new immutable version; a launch pins the version it was prepared with.
 */

export const TEMPLATES_MIGRATION = `CREATE TABLE agency_template (
    key TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`;

export const AGENCY_RULES_MIGRATION = `CREATE TABLE agency_rules_version (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL UNIQUE,
    text TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;

export type TemplateView = { key: TemplateKey; text: string; custom: boolean; revision: number };

/** Templates with the standard texts in the Agency language where the owner kept the standard. */
export function listTemplates(db: SqlDatabase, language = agencyLanguage()): TemplateView[] {
  const standard = defaultTemplates(language);
  const rows = db.prepare(`SELECT key, text, revision FROM agency_template`).all() as { key: string; text: string; revision: number }[];
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return TEMPLATE_KEYS.map((key) => {
    const row = byKey.get(key);
    return row ? { key, text: row.text, custom: true, revision: row.revision } : { key, text: standard[key], custom: false, revision: 0 };
  });
}

/** Saves the owner's text, or resets to the standard one with `text: null`. */
export function saveTemplate(
  db: SqlDatabase,
  input: { key: TemplateKey; expectedRevision: number; text: string | null },
  now: string,
): DomainResult<TemplateView> {
  const current = listTemplates(db).find((row) => row.key === input.key)!;
  if (current.revision !== input.expectedRevision) {
    return fail("revision_conflict", `template ${input.key} revision ${current.revision} != expected ${input.expectedRevision}`);
  }
  if (input.text === null) {
    db.prepare(`DELETE FROM agency_template WHERE key = ?`).run(input.key);
    return ok({ key: input.key, text: defaultTemplates(agencyLanguage())[input.key], custom: false, revision: 0 });
  }
  const text = input.text.trim();
  const en = agencyLanguage() === "en";
  if (!text) return fail("template_empty", en ? "A template cannot be empty: reset it to the standard one." : "Шаблон не может быть пустым: сбросьте его к стандартному.");
  if (input.key === "charter" && !charterAccepts(text)) {
    return fail(
      "template_invalid",
      en ? "The charter template needs an «## Accepts» section: agents choose the department by it." : "В шаблоне регламента нужен раздел «## Принимаем»: по нему агенты выбирают отдел.",
    );
  }
  const revision = current.revision + 1;
  db.prepare(
    `INSERT INTO agency_template (key, text, revision, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET text = excluded.text, revision = excluded.revision, updated_at = excluded.updated_at`,
  ).run(input.key, text, revision, now);
  return ok({ key: input.key, text, custom: true, revision });
}

export type AgencyRulesVersion = { id: string; version: number; text: string; hash: string; createdAt: string };

type RulesRow = { id: string; version: number; text: string; hash: string; created_at: string };

const toVersion = (row: RulesRow): AgencyRulesVersion => ({ id: row.id, version: row.version, text: row.text, hash: row.hash, createdAt: row.created_at });

/** The rules in force: the latest version, or none when the owner never wrote any (or cleared them). */
export function currentAgencyRules(db: SqlDatabase): AgencyRulesVersion | null {
  // A database opened by an older migration step has no rules table yet: no rules are in force.
  const table = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agency_rules_version'`).get();
  if (!table) return null;
  const row = db.prepare(`SELECT * FROM agency_rules_version ORDER BY version DESC LIMIT 1`).get() as RulesRow | undefined;
  return row && row.text.trim() ? toVersion(row) : null;
}

export function listAgencyRulesVersions(db: SqlDatabase, limit = 20): AgencyRulesVersion[] {
  return (db.prepare(`SELECT * FROM agency_rules_version ORDER BY version DESC LIMIT ?`).all(limit) as RulesRow[]).map(toVersion);
}

/** A new version when the text changed; an empty text is a version that switches the layer off. */
export function saveAgencyRules(db: SqlDatabase, input: { expectedVersion: number; text: string }, now: string): DomainResult<AgencyRulesVersion | null> {
  const latest = db.prepare(`SELECT * FROM agency_rules_version ORDER BY version DESC LIMIT 1`).get() as RulesRow | undefined;
  const version = latest?.version ?? 0;
  if (version !== input.expectedVersion) {
    return fail("revision_conflict", `agency rules version ${version} != expected ${input.expectedVersion}`);
  }
  const text = input.text.trim();
  if (text.length > 12_000) return fail("rules_too_long", "Общие правила длиннее 12 000 символов: сократите, они идут в каждый запуск.");
  if (latest && latest.text === text) return ok(currentAgencyRules(db));
  const row: RulesRow = {
    id: `rul_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    version: version + 1,
    text,
    hash: createHash("sha256").update(text, "utf8").digest("hex"),
    created_at: now,
  };
  db.prepare(`INSERT INTO agency_rules_version (id, version, text, hash, created_at) VALUES (?, ?, ?, ?, ?)`).run(row.id, row.version, row.text, row.hash, row.created_at);
  return ok(text ? toVersion(row) : null);
}
