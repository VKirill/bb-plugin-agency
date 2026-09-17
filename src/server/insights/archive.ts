import { randomUUID } from "node:crypto";
import { fail, ok, type DomainResult } from "../../domain";
import type { SqlDatabase } from "../db/sql";

/**
 * Server archive and search. A closed main job whose whole tree closed more
 * than `archiveAfterDays` ago leaves the working snapshot; it stays in the
 * database and is reachable through the archive list and search.
 */

export const SAVED_VIEWS_MIGRATION = `CREATE TABLE agency_saved_view (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    filters_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

export const DEFAULT_ARCHIVE_AFTER_DAYS = 30;

/** Ids of jobs in archived trees: every job of the tree is closed and the latest close is older than the cut. */
export function archivedJobIds(db: SqlDatabase, afterDays: number, now: Date): Set<string> {
  if (afterDays <= 0) return new Set();
  const cut = new Date(now.getTime() - afterDays * 86_400_000).toISOString();
  const rows = db.prepare(`SELECT id, parent_job_id, state, closed_at FROM agency_job`).all() as { id: string; parent_job_id: string | null; state: string; closed_at: string | null }[];
  const children = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.parent_job_id) continue;
    children.set(row.parent_job_id, [...(children.get(row.parent_job_id) ?? []), row]);
  }
  const archived = new Set<string>();
  for (const root of rows.filter((row) => !row.parent_job_id)) {
    const tree: typeof rows = [];
    const stack = [root];
    const seen = new Set<string>();
    while (stack.length) {
      const next = stack.pop()!;
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      tree.push(next);
      stack.push(...(children.get(next.id) ?? []));
    }
    const closed = tree.every((job) => (job.state === "done" || job.state === "canceled") && job.closed_at && job.closed_at < cut);
    if (closed) for (const job of tree) archived.add(job.id);
  }
  return archived;
}

export type JobSearchHit = { jobId: string; key: string; title: string; state: string; archived: boolean; field: "key" | "title" | "brief" | "comment"; snippet: string };

function snippet(text: string, query: string): string {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text.slice(0, 140);
  const start = Math.max(0, at - 60);
  return `${start > 0 ? "…" : ""}${text.slice(start, at + query.length + 80).replace(/\s+/g, " ")}${at + query.length + 80 < text.length ? "…" : ""}`;
}

export function searchJobs(db: SqlDatabase, input: { query: string; limit?: number; archivedIds: Set<string>; bindingIds?: readonly string[] }): JobSearchHit[] {
  const query = input.query.trim();
  if (query.length < 2) return [];
  if (input.bindingIds && input.bindingIds.length === 0) return [];
  // Search stays inside the projects the caller may read.
  const scope = input.bindingIds ? ` AND j.binding_id IN (${input.bindingIds.map(() => "?").join(", ")})` : "";
  const scopeArgs = input.bindingIds ?? [];
  const like = `%${query.replace(/[%_]/g, (char) => `\\${char}`)}%`;
  const limit = Math.min(input.limit ?? 50, 200);
  const jobs = db
    .prepare(
      `SELECT j.id, j.key, j.title, j.brief, j.acceptance, j.state FROM agency_job j
       WHERE (j.key LIKE ? ESCAPE '\\' OR j.title LIKE ? ESCAPE '\\' OR j.brief LIKE ? ESCAPE '\\' OR j.acceptance LIKE ? ESCAPE '\\')${scope}
       ORDER BY j.rowid DESC LIMIT ?`,
    )
    .all(like, like, like, like, ...scopeArgs, limit) as { id: string; key: string; title: string; brief: string; acceptance: string; state: string }[];
  const hits: JobSearchHit[] = jobs.map((job) => {
    const lower = query.toLowerCase();
    const field = job.key.toLowerCase().includes(lower) ? "key" : job.title.toLowerCase().includes(lower) ? "title" : "brief";
    const text = field === "brief" ? (job.brief.toLowerCase().includes(lower) ? job.brief : job.acceptance) : job.title;
    return { jobId: job.id, key: job.key, title: job.title, state: job.state, archived: input.archivedIds.has(job.id), field, snippet: snippet(text, query) };
  });
  if (hits.length < limit) {
    const found = new Set(hits.map((hit) => hit.jobId));
    const comments = db
      .prepare(
        `SELECT a.job_id, a.comment, j.key, j.title, j.state FROM agency_activity a JOIN agency_job j ON j.id = a.job_id
         WHERE a.kind = 'comment' AND a.comment LIKE ? ESCAPE '\\'${scope} ORDER BY a.timestamp DESC LIMIT ?`,
      )
      .all(like, ...scopeArgs, limit) as { job_id: string; comment: string; key: string; title: string; state: string }[];
    for (const row of comments) {
      if (found.has(row.job_id) || hits.length >= limit) continue;
      found.add(row.job_id);
      hits.push({ jobId: row.job_id, key: row.key, title: row.title, state: row.state, archived: input.archivedIds.has(row.job_id), field: "comment", snippet: snippet(row.comment, query) });
    }
  }
  return hits;
}

export type SavedView = { id: string; name: string; filters: Record<string, string>; updatedAt: string };

export function listSavedViews(db: SqlDatabase): SavedView[] {
  return (db.prepare(`SELECT id, name, filters_json, updated_at FROM agency_saved_view ORDER BY name`).all() as { id: string; name: string; filters_json: string; updated_at: string }[]).map((row) => ({
    id: row.id,
    name: row.name,
    filters: JSON.parse(row.filters_json) as Record<string, string>,
    updatedAt: row.updated_at,
  }));
}

export function saveSavedView(db: SqlDatabase, input: { id?: string; name: string; filters: Record<string, string> }, now: string): DomainResult<SavedView> {
  const name = input.name.trim();
  if (!name) return fail("invalid_command", "У вида должно быть название.");
  if (name.length > 80) return fail("invalid_command", "Название вида — до 80 символов.");
  const filters = Object.fromEntries(Object.entries(input.filters).filter(([key, value]) => /^[a-zA-Z]{1,40}$/.test(key) && typeof value === "string" && value.length <= 200));
  const id = input.id ?? `viw_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  db.prepare(
    `INSERT INTO agency_saved_view (id, name, filters_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, filters_json = excluded.filters_json, updated_at = excluded.updated_at`,
  ).run(id, name, JSON.stringify(filters), now, now);
  return ok(listSavedViews(db).find((view) => view.id === id)!);
}

export function deleteSavedView(db: SqlDatabase, id: string): boolean {
  return db.prepare(`DELETE FROM agency_saved_view WHERE id = ?`).run(id).changes > 0;
}
