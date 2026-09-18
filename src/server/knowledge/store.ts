import { createHash, randomUUID } from "node:crypto";
import { fail, ok, type DomainResult } from "../../domain";
import type { SqlDatabase } from "../db/sql";

/**
 * Knowledge: materials the owner accepted for the Agency, a department or a
 * project. An accepted material reaches every launch in its scope as part of the
 * prompt; a proposal (from an employee or an unreviewed edit) waits for the
 * owner. Archived materials stay for history and reach nobody.
 */

export const KNOWLEDGE_MIGRATION = `CREATE TABLE agency_knowledge (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    source TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('agency', 'department', 'project')),
    scope_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('proposal', 'accepted', 'archived')),
    proposed_by TEXT,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

export type KnowledgeScopeKind = "agency" | "department" | "project";
export type KnowledgeStatus = "proposal" | "accepted" | "archived";

/** Как обращаться с записью: факт проверяют, процедуре следуют, предпочтение соблюдают. */
export const KNOWLEDGE_KINDS = ["fact", "decision", "procedure", "preference", "reference", "lesson"] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

/** Записи важнее этого порога приходят в запуск целиком, остальные — строкой индекса. */
export const KNOWLEDGE_FULL_TEXT_IMPORTANCE = 80;

export type KnowledgeItem = {
  id: string;
  title: string;
  /** Одна строка для индекса в промпте: по ней сотрудник решает, читать ли целиком. */
  summary: string;
  body: string;
  kind: KnowledgeKind;
  importance: number;
  pinned: boolean;
  /** Зачем записали: помогает владельцу решить, нужна ли запись дальше. */
  writeReason: string;
  source: string;
  scopeKind: KnowledgeScopeKind;
  scopeId: string | null;
  status: KnowledgeStatus;
  proposedBy: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  id: string;
  title: string;
  summary?: string | null;
  kind?: string | null;
  importance?: number | null;
  pinned?: number | null;
  write_reason?: string | null;
  body: string;
  source: string;
  scope_kind: KnowledgeScopeKind;
  scope_id: string | null;
  status: KnowledgeStatus;
  proposed_by: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

const toItem = (row: Row): KnowledgeItem => ({
  id: row.id,
  title: row.title,
  summary: (row.summary ?? "").trim() || firstLine(row.body),
  body: row.body,
  kind: (KNOWLEDGE_KINDS as readonly string[]).includes(row.kind ?? "") ? (row.kind as KnowledgeKind) : "fact",
  importance: typeof row.importance === "number" ? row.importance : 50,
  pinned: row.pinned === 1,
  writeReason: (row.write_reason ?? "").trim(),
  source: row.source,
  scopeKind: row.scope_kind,
  scopeId: row.scope_id,
  status: row.status,
  proposedBy: row.proposed_by,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Старые записи сводки не имеют: первая строка текста работает как сводка. */
function firstLine(body: string): string {
  const line = body.split("\n").map((row) => row.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

export function listKnowledge(db: SqlDatabase, filter: { scopeKind?: KnowledgeScopeKind; scopeId?: string; status?: KnowledgeStatus } = {}): KnowledgeItem[] {
  return (db.prepare(`SELECT * FROM agency_knowledge ORDER BY updated_at DESC`).all() as Row[])
    .map(toItem)
    .filter((item) => (!filter.scopeKind || item.scopeKind === filter.scopeKind) && (!filter.scopeId || item.scopeId === filter.scopeId) && (!filter.status || item.status === filter.status));
}

export type SaveKnowledgeInput = {
  id?: string;
  expectedRevision: number;
  title: string;
  summary?: string;
  body: string;
  kind?: KnowledgeKind;
  importance?: number;
  pinned?: boolean;
  writeReason?: string;
  source: string;
  scopeKind: KnowledgeScopeKind;
  scopeId: string | null;
};

/**
 * The owner saves an accepted material directly; an employee's save (`proposedBy`
 * set) is a proposal, and editing an accepted material that way turns it back
 * into a proposal until the owner accepts it again.
 */
export function saveKnowledge(db: SqlDatabase, input: SaveKnowledgeInput, actor: { proposedBy: string | null }, now: string): DomainResult<KnowledgeItem> {
  const title = input.title.trim();
  const body = input.body.trim();
  const source = input.source.trim();
  if (!title || !body || !source) return fail("invalid_command", "Нужны название, текст и источник материала.");
  if (body.length > 20_000) return fail("invalid_command", "Материал длиннее 20 000 символов: сократите или разделите его.");
  if (input.scopeKind === "agency" ? input.scopeId !== null : !input.scopeId) {
    return fail("invalid_command", "Область: Агентство без id, отдел или проект — с id.");
  }
  const status: KnowledgeStatus = actor.proposedBy ? "proposal" : "accepted";
  const summary = (input.summary ?? "").trim() || firstLine(body);
  const kind: KnowledgeKind = input.kind ?? "fact";
  const importance = Math.max(0, Math.min(100, Math.round(input.importance ?? 50)));
  const pinned = input.pinned ? 1 : 0;
  const writeReason = (input.writeReason ?? "").trim();
  if (!input.id) {
    const id = `kno_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    db.prepare(
      `INSERT INTO agency_knowledge (id, title, summary, body, kind, importance, pinned, write_reason, source, scope_kind, scope_id, status, proposed_by, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, title, summary, body, kind, importance, pinned, writeReason, source, input.scopeKind, input.scopeId, status, actor.proposedBy, now, now);
    return ok(toItem(db.prepare(`SELECT * FROM agency_knowledge WHERE id = ?`).get(id) as Row));
  }
  const current = db.prepare(`SELECT * FROM agency_knowledge WHERE id = ?`).get(input.id) as Row | undefined;
  if (!current) return fail("not_found", `knowledge ${input.id} not found`);
  if (current.revision !== input.expectedRevision) return fail("revision_conflict", "Материал изменился: перечитайте и повторите.");
  const changed = db
    .prepare(
      `UPDATE agency_knowledge SET title = ?, summary = ?, body = ?, kind = ?, importance = ?, pinned = ?, write_reason = ?, source = ?, scope_kind = ?, scope_id = ?, status = ?, proposed_by = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
    )
    .run(title, summary, body, kind, importance, pinned, writeReason, source, input.scopeKind, input.scopeId, status, actor.proposedBy ?? current.proposed_by, now, input.id, input.expectedRevision);
  if (changed.changes !== 1) return fail("revision_conflict", "Материал изменился: перечитайте и повторите.");
  return ok(toItem(db.prepare(`SELECT * FROM agency_knowledge WHERE id = ?`).get(input.id) as Row));
}

export function setKnowledgeStatus(db: SqlDatabase, input: { id: string; expectedRevision: number; status: KnowledgeStatus }, now: string): DomainResult<KnowledgeItem> {
  const changed = db
    .prepare(`UPDATE agency_knowledge SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`)
    .run(input.status, now, input.id, input.expectedRevision);
  if (changed.changes !== 1) return fail("revision_conflict", "Материал изменился или не найден: перечитайте и повторите.");
  return ok(toItem(db.prepare(`SELECT * FROM agency_knowledge WHERE id = ?`).get(input.id) as Row));
}

export const KNOWLEDGE_LEVEL_LIMIT = 8_000;

/** Accepted materials of one scope as a prompt block, oldest first, cut to the level limit. */
export function knowledgeBlock(db: SqlDatabase, scopeKind: KnowledgeScopeKind, scopeId: string | null): { text: string; ids: { id: string; hash: string }[] } {
  // A database opened by an older migration step has no knowledge table yet.
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agency_knowledge'`).get()) return { text: "", ids: [] };
  const items = (db
    .prepare(`SELECT * FROM agency_knowledge WHERE status = 'accepted' AND scope_kind = ? AND COALESCE(scope_id, '') = ? ORDER BY created_at, id`)
    .all(scopeKind, scopeId ?? "") as Row[]).map(toItem);
  if (!items.length) return { text: "", ids: [] };
  const ids: { id: string; hash: string }[] = [];
  // Индекс: одна строка на запись, как в памяти BB. Полный текст сотрудник берёт сам.
  const index = items.map((item) => `- [${item.kind}] ${item.title} — ${item.summary} (${item.id})`);
  const full: string[] = [];
  let used = index.join("\n").length;
  for (const item of items) {
    const whole = item.pinned || item.importance >= KNOWLEDGE_FULL_TEXT_IMPORTANCE;
    const part = `### ${item.title}\nИсточник: ${item.source}\n${item.body}`;
    if (whole && used + part.length <= KNOWLEDGE_LEVEL_LIMIT) {
      full.push(part);
      used += part.length;
      ids.push({ id: item.id, hash: createHash("sha256").update(part, "utf8").digest("hex") });
      continue;
    }
    ids.push({ id: item.id, hash: createHash("sha256").update(item.summary, "utf8").digest("hex") });
  }
  const text = [
    "Материалы этой области. Полный текст любой записи: bb agency knowledge get --input-json '{\"id\":\"kno_…\"}'.",
    ...index,
    ...(full.length ? ["", "Целиком (важные и закреплённые):", ...full] : []),
  ].join("\n");
  return { text, ids };
}

export function getKnowledge(db: SqlDatabase, id: string): KnowledgeItem | null {
  const row = db.prepare(`SELECT * FROM agency_knowledge WHERE id = ?`).get(id) as Row | undefined;
  return row ? toItem(row) : null;
}
