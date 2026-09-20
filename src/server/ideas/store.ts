import { randomUUID } from "node:crypto";
import { fail, ok, type DomainResult } from "../../domain";
import type { IdeaKind, IdeaStatus, SaveIdeaInput } from "../../shared/contracts/idea";
import type { SqlDatabase } from "../db/sql";

export const IDEAS_MIGRATION = `CREATE TABLE agency_idea (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('idea', 'todo')),
    status TEXT NOT NULL CHECK(status IN ('open', 'parked', 'done', 'archived')),
    binding_id TEXT NOT NULL,
    section_id TEXT,
    section_label TEXT NOT NULL DEFAULT '',
    source_thread_id TEXT,
    relative_path TEXT NOT NULL,
    file_hash TEXT,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

export const IDEA_FILE_DIR = ".bb/agency/ideas";

export type IdeaRecord = {
  id: string;
  title: string;
  body: string;
  kind: IdeaKind;
  status: IdeaStatus;
  bindingId: string;
  sectionId: string | null;
  sectionLabel: string;
  sourceThreadId: string | null;
  relativePath: string;
  fileHash: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  id: string;
  title: string;
  body: string;
  kind: IdeaKind;
  status: IdeaStatus;
  binding_id: string;
  section_id: string | null;
  section_label: string | null;
  source_thread_id: string | null;
  relative_path: string;
  file_hash: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

export function ideaRelativePath(id: string): string {
  return `${IDEA_FILE_DIR}/${id}.md`;
}

function fromRow(row: Row): IdeaRecord {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    kind: row.kind,
    status: row.status,
    bindingId: row.binding_id,
    sectionId: row.section_id,
    sectionLabel: row.section_label ?? "",
    sourceThreadId: row.source_thread_id,
    relativePath: row.relative_path,
    fileHash: row.file_hash,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getIdea(db: SqlDatabase, id: string): IdeaRecord | undefined {
  const row = db.prepare(`SELECT * FROM agency_idea WHERE id = ?`).get(id) as Row | undefined;
  return row ? fromRow(row) : undefined;
}

export function listIdeas(
  db: SqlDatabase,
  filter: {
    bindingId?: string;
    sectionId?: string;
    kind?: IdeaKind;
    status?: IdeaStatus;
  } = {},
): IdeaRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM agency_idea
       WHERE (? IS NULL OR binding_id = ?)
         AND (? IS NULL OR section_id = ?)
         AND (? IS NULL OR kind = ?)
         AND (? IS NULL OR status = ?)
       ORDER BY updated_at DESC`,
    )
    .all(
      filter.bindingId ?? null,
      filter.bindingId ?? null,
      filter.sectionId ?? null,
      filter.sectionId ?? null,
      filter.kind ?? null,
      filter.kind ?? null,
      filter.status ?? null,
      filter.status ?? null,
    ) as Row[];
  return rows.map(fromRow);
}

export function saveIdea(db: SqlDatabase, input: SaveIdeaInput, now: string): DomainResult<IdeaRecord> {
  const title = input.title.trim();
  if (!title) return fail("invalid_command", "У идеи должно быть название.");
  const body = input.body.trim();
  if (!body) return fail("invalid_command", "У идеи должно быть содержание.");
  const kind = input.kind ?? "idea";
  const status = input.status ?? "open";
  const sectionId = input.sectionId?.trim() || null;
  const sectionLabel = input.sectionLabel?.trim() ?? "";
  const sourceThreadId = input.sourceThreadId === undefined ? null : input.sourceThreadId?.trim() || null;

  if (!input.id) {
    const id = `ide_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    db.prepare(
      `INSERT INTO agency_idea (
        id, title, body, kind, status, binding_id, section_id, section_label,
        source_thread_id, relative_path, file_hash, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
    ).run(
      id,
      title,
      body,
      kind,
      status,
      input.bindingId,
      sectionId,
      sectionLabel,
      sourceThreadId,
      ideaRelativePath(id),
      now,
      now,
    );
    return ok(getIdea(db, id)!);
  }

  const current = getIdea(db, input.id);
  if (!current) return fail("not_found", `idea ${input.id} not found`);
  const changed = db
    .prepare(
      `UPDATE agency_idea SET
        title = ?, body = ?, kind = ?, status = ?, binding_id = ?, section_id = ?,
        section_label = ?, source_thread_id = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
    )
    .run(
      title,
      body,
      kind,
      status,
      input.bindingId,
      sectionId,
      sectionLabel,
      sourceThreadId ?? current.sourceThreadId,
      now,
      input.id,
      input.expectedRevision,
    );
  if (changed.changes !== 1) return fail("revision_conflict", "Идея изменилась или не найдена: перечитайте и повторите.");
  return ok(getIdea(db, input.id)!);
}

export function setIdeaStatus(
  db: SqlDatabase,
  input: { id: string; expectedRevision: number; status: IdeaStatus },
  now: string,
): DomainResult<IdeaRecord> {
  const changed = db
    .prepare(`UPDATE agency_idea SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`)
    .run(input.status, now, input.id, input.expectedRevision);
  if (changed.changes !== 1) return fail("revision_conflict", "Идея изменилась или не найдена: перечитайте и повторите.");
  return ok(getIdea(db, input.id)!);
}

export function setIdeaFileHash(db: SqlDatabase, id: string, hash: string | null): void {
  db.prepare(`UPDATE agency_idea SET file_hash = ? WHERE id = ?`).run(hash, id);
}
