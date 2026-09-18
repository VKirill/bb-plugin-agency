import { createHash, randomUUID } from "node:crypto";
import { fail, ok, type DomainResult } from "../../domain";
import {
  PASSPORT_HEADER_LIMIT,
  PASSPORT_SECTIONS,
  type PassportSection,
  type PassportSectionKey,
  type ProjectPassport,
} from "../../shared/passport.js";
import type { SqlDatabase } from "../db/sql";

/**
 * Хранение паспорта проекта и его прежних редакций. Паспорт применяется сразу — и моделью, и
 * владельцем, — поэтому каждая редакция ложится в историю: откат должен быть одним движением, а
 * не восстановлением из резервной копии.
 */

export const PASSPORT_MIGRATION = `CREATE TABLE agency_project_passport (
    id TEXT PRIMARY KEY,
    bb_project_id TEXT NOT NULL UNIQUE,
    header TEXT NOT NULL,
    sections TEXT NOT NULL,
    source_digest TEXT NOT NULL,
    accepted_jobs INTEGER NOT NULL,
    built_by TEXT NOT NULL CHECK(built_by IN ('model', 'owner')),
    model TEXT,
    built_at TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

export const PASSPORT_VERSION_MIGRATION = `CREATE TABLE agency_project_passport_version (
    id TEXT PRIMARY KEY,
    bb_project_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    header TEXT NOT NULL,
    sections TEXT NOT NULL,
    built_by TEXT NOT NULL,
    model TEXT,
    note TEXT NOT NULL,
    built_at TEXT NOT NULL,
    UNIQUE(bb_project_id, revision)
  )`;

const SECTION_KEYS = new Set<string>(PASSPORT_SECTIONS.map((section) => section.key));

type Row = {
  id: string;
  bb_project_id: string;
  header: string;
  sections: string;
  source_digest: string;
  accepted_jobs: number;
  built_by: "model" | "owner";
  model: string | null;
  built_at: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

export function parseSections(raw: string): PassportSection[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is { key: string; text: string } => typeof item?.key === "string" && typeof item?.text === "string")
      .filter((item) => SECTION_KEYS.has(item.key))
      .map((item) => ({ key: item.key as PassportSectionKey, text: item.text }));
  } catch {
    return [];
  }
}

const toPassport = (row: Row): ProjectPassport => ({
  id: row.id,
  bbProjectId: row.bb_project_id,
  header: row.header,
  sections: parseSections(row.sections),
  sourceDigest: row.source_digest,
  acceptedJobs: row.accepted_jobs,
  builtBy: row.built_by,
  model: row.model,
  builtAt: row.built_at,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function tableReady(db: SqlDatabase): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agency_project_passport'`).get());
}

export function getPassport(db: SqlDatabase, bbProjectId: string): ProjectPassport | null {
  if (!tableReady(db)) return null;
  const row = db.prepare(`SELECT * FROM agency_project_passport WHERE bb_project_id = ?`).get(bbProjectId) as Row | undefined;
  return row ? toPassport(row) : null;
}

export function listPassports(db: SqlDatabase): ProjectPassport[] {
  if (!tableReady(db)) return [];
  return (db.prepare(`SELECT * FROM agency_project_passport ORDER BY bb_project_id`).all() as Row[]).map(toPassport);
}

export type PassportVersion = {
  id: string;
  bbProjectId: string;
  revision: number;
  header: string;
  sections: PassportSection[];
  builtBy: "model" | "owner";
  model: string | null;
  /** Чем эта редакция появилась: сборка по счёту задач, кнопка владельца, правка, откат. */
  note: string;
  builtAt: string;
};

export function listPassportVersions(db: SqlDatabase, bbProjectId: string, limit = 20): PassportVersion[] {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agency_project_passport_version'`).get()) return [];
  const rows = db
    .prepare(`SELECT * FROM agency_project_passport_version WHERE bb_project_id = ? ORDER BY revision DESC LIMIT ?`)
    .all(bbProjectId, limit) as Array<{
    id: string;
    bb_project_id: string;
    revision: number;
    header: string;
    sections: string;
    built_by: "model" | "owner";
    model: string | null;
    note: string;
    built_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    bbProjectId: row.bb_project_id,
    revision: row.revision,
    header: row.header,
    sections: parseSections(row.sections),
    builtBy: row.built_by,
    model: row.model,
    note: row.note,
    builtAt: row.built_at,
  }));
}

export type WritePassportInput = {
  bbProjectId: string;
  header: string;
  sections: readonly PassportSection[];
  sourceDigest: string;
  /** Сколько задач проекта было принято на момент сборки: по разнице считается следующий порог. */
  acceptedJobs: number;
  builtBy: "model" | "owner";
  model?: string | null;
  note: string;
  /** Правка владельца идёт с ожидаемой ревизией; сборка модели догоняет текущую. */
  expectedRevision?: number;
};

/**
 * Записать редакцию паспорта. Прежняя уходит в историю до записи новой: откат читает её оттуда,
 * а не пересобирает моделью заново.
 */
export function writePassport(db: SqlDatabase, input: WritePassportInput, now: string): DomainResult<ProjectPassport> {
  const header = input.header.trim().slice(0, PASSPORT_HEADER_LIMIT);
  const sections = input.sections
    .filter((section) => SECTION_KEYS.has(section.key) && section.text.trim())
    .map((section) => ({ key: section.key, text: section.text.trim() }));
  if (!header && !sections.length) return fail("invalid_command", "Паспорт пустой: нужна хотя бы шапка.");
  const current = getPassport(db, input.bbProjectId);
  if (input.expectedRevision !== undefined && (current?.revision ?? 0) !== input.expectedRevision) {
    return fail("revision_conflict", `passport revision ${current?.revision ?? 0} != expected ${input.expectedRevision}`);
  }
  const revision = (current?.revision ?? 0) + 1;
  const passport: ProjectPassport = {
    id: current?.id ?? randomUUID(),
    bbProjectId: input.bbProjectId,
    header,
    sections,
    sourceDigest: input.sourceDigest,
    acceptedJobs: input.acceptedJobs,
    builtBy: input.builtBy,
    model: input.model ?? null,
    builtAt: now,
    revision,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO agency_project_passport (id, bb_project_id, header, sections, source_digest, accepted_jobs, built_by, model, built_at, revision, created_at, updated_at)
       VALUES (@id, @bbProjectId, @header, @sections, @sourceDigest, @acceptedJobs, @builtBy, @model, @builtAt, @revision, @createdAt, @updatedAt)
       ON CONFLICT(bb_project_id) DO UPDATE SET header = @header, sections = @sections, source_digest = @sourceDigest,
         accepted_jobs = @acceptedJobs, built_by = @builtBy, model = @model, built_at = @builtAt, revision = @revision, updated_at = @updatedAt`,
    ).run({ ...passport, sections: JSON.stringify(passport.sections) });
    db.prepare(
      `INSERT INTO agency_project_passport_version (id, bb_project_id, revision, header, sections, built_by, model, note, built_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bb_project_id, revision) DO NOTHING`,
    ).run(randomUUID(), passport.bbProjectId, revision, header, JSON.stringify(passport.sections), passport.builtBy, passport.model, input.note.trim(), now);
  });
  write();
  return ok(passport);
}

/** Вернуть прежнюю редакцию: она записывается новой, чтобы история осталась цельной. */
export function rollbackPassport(db: SqlDatabase, bbProjectId: string, revision: number, now: string): DomainResult<ProjectPassport> {
  const version = listPassportVersions(db, bbProjectId, 200).find((item) => item.revision === revision);
  if (!version) return fail("not_found", `У паспорта нет редакции ${revision}.`);
  return writePassport(
    db,
    {
      bbProjectId,
      header: version.header,
      sections: version.sections,
      // Материал с тех пор изменился: пустой отпечаток заставит следующую сборку пересчитать всё.
      sourceDigest: "",
      acceptedJobs: getPassport(db, bbProjectId)?.acceptedJobs ?? 0,
      builtBy: "owner",
      model: version.model,
      note: `Возврат к редакции ${revision}`,
    },
    now,
  );
}

export function deletePassport(db: SqlDatabase, bbProjectId: string): DomainResult<{ removed: boolean }> {
  if (!tableReady(db)) return ok({ removed: false });
  const current = getPassport(db, bbProjectId);
  if (!current) return ok({ removed: false });
  db.prepare(`DELETE FROM agency_project_passport WHERE bb_project_id = ?`).run(bbProjectId);
  db.prepare(`DELETE FROM agency_project_passport_version WHERE bb_project_id = ?`).run(bbProjectId);
  return ok({ removed: true });
}

export function passportDigest(material: string): string {
  return createHash("sha256").update(material, "utf8").digest("hex").slice(0, 32);
}
