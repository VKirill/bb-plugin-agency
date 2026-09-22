import { createHash } from "node:crypto";
import type { z } from "zod";
import { traceQuerySchema, type TraceQuery, type traceRecordSchema, type traceOutcomeSchema } from "../../../shared/contracts/trace";
import type { SqlDatabase } from "../../db/sql";
function rootJobId(db: SqlDatabase, id: string): string {
  const seen = new Set<string>(); let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const row = db.prepare("SELECT parent_job_id FROM agency_job WHERE id = ?").get(current) as { parent_job_id: string | null } | undefined;
    if (!row?.parent_job_id) return current;
    current = row.parent_job_id;
  }
  return id;
}

export const TRACE_MIGRATION = `CREATE TABLE agency_trace (
  id INTEGER PRIMARY KEY AUTOINCREMENT, first_at TEXT NOT NULL, last_at TEXT NOT NULL,
  repeats INTEGER NOT NULL DEFAULT 1, job_id TEXT, job_key TEXT, root_job_id TEXT,
  revision INTEGER, state TEXT, step TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT NOT NULL,
  request_id TEXT, attempt_id TEXT, launch_id TEXT, thread_id TEXT, artifact_hash TEXT,
  related_job_id TEXT, duration_ms INTEGER, facts TEXT NOT NULL, signature TEXT NOT NULL
);
CREATE INDEX agency_trace_job_idx ON agency_trace(job_id, id);
CREATE INDEX agency_trace_step_idx ON agency_trace(job_id, step, id);
CREATE INDEX agency_trace_last_idx ON agency_trace(last_at);`;
export const TRACE_DAYS = 30;
export const TRACE_MAX_ROWS = 50_000;

type Health = { writeFailures: number; lastFailureAt: string | null; lastPrune: number; writes: number; warn?: () => void };
const health = new WeakMap<SqlDatabase, Health>();
function status(db: SqlDatabase): Health {
  let value = health.get(db);
  if (!value) { value = { writeFailures: 0, lastFailureAt: null, lastPrune: 0, writes: 0 }; health.set(db, value); }
  return value;
}
export function configureTrace(db: SqlDatabase, warn: () => void): void { status(db).warn = warn; }
export function traceHealth(db: SqlDatabase) { const { writeFailures, lastFailureAt } = status(db); return { writeFailures, lastFailureAt }; }

// Only identifiers and fixed reason codes are accepted. Never copy error messages, prompts or tool payloads.
export function traceCode(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value) ? value : null;
}
const FACT_KEYS = new Set(["beforeState", "afterState", "expectedRevision", "version", "ageMs", "count", "cause", "relation", "seed", "delivery", "point"]);
export type TraceInput = {
  jobId?: string | null; step: string; outcome: z.infer<typeof traceOutcomeSchema>; reason: string;
  requestId?: string | null; relatedJobId?: string | null; artifactHash?: string | null;
  attemptId?: string | null; launchId?: string | null; threadId?: string | null;
  durationMs?: number; facts?: Record<string, unknown>; collapse?: boolean;
};

/** Best effort diagnostics must never change a business result, including after disposal/disk failure. */
export function recordTrace(db: SqlDatabase, input: TraceInput, now = new Date().toISOString()): void {
  try {
    const job = input.jobId ? db.prepare(`SELECT id, key, state, revision FROM agency_job WHERE id = ? OR key = ?`).get(input.jobId, input.jobId) as
      { id: string; key: string; state: string; revision: number } | undefined : undefined;
    const attempt = job ? db.prepare(`SELECT id, launch_id, thread_id FROM agency_run_attempt WHERE job_id = ? ORDER BY attempt_no DESC LIMIT 1`).get(job.id) as
      { id: string; launch_id: string | null; thread_id: string | null } | undefined : undefined;
    const facts = Object.fromEntries(Object.entries(input.facts ?? {}).filter(([k, v]) => FACT_KEYS.has(k) &&
      (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || traceCode(v) !== null)));
    const hash = input.artifactHash && /^[a-f0-9]{64}$/.test(input.artifactHash) ? input.artifactHash : null;
    const values = [job?.id ?? null, job?.key ?? null, job ? rootJobId(db, job.id) : null,
      job?.revision ?? null, job?.state ?? null, traceCode(input.step) ?? "unknown", input.outcome, traceCode(input.reason) ?? "unspecified",
      traceCode(input.requestId), traceCode(input.attemptId) ?? attempt?.id ?? null,
      traceCode(input.launchId) ?? attempt?.launch_id ?? null, traceCode(input.threadId) ?? attempt?.thread_id ?? null,
      hash, traceCode(input.relatedJobId), JSON.stringify(facts)];
    const signature = createHash("sha256").update(JSON.stringify(values)).digest("hex");
    const ms = Number.isFinite(input.durationMs) ? Math.max(0, Math.round(input.durationMs!)) : null;
    db.transaction(() => {
      const previous = input.collapse ? db.prepare(`SELECT id, signature FROM agency_trace WHERE job_id IS ? AND step = ? ORDER BY id DESC LIMIT 1`)
        .get(job?.id ?? null, values[5]) as { id: number; signature: string } | undefined : undefined;
      if (previous?.signature === signature) {
        db.prepare(`UPDATE agency_trace SET last_at = ?, repeats = repeats + 1, duration_ms = CASE WHEN ? IS NULL THEN duration_ms ELSE MAX(COALESCE(duration_ms, 0), ?) END WHERE id = ?`)
          .run(now, ms, ms, previous.id);
      } else {
        db.prepare(`INSERT INTO agency_trace (first_at, last_at, job_id, job_key, root_job_id, revision, state, step, outcome, reason, request_id, attempt_id, launch_id, thread_id, artifact_hash, related_job_id, facts, duration_ms, signature)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(now, now, ...values, ms, signature);
      }
      const s = status(db); s.writes++;
      if (s.writes % 100 === 1 || Date.parse(now) - s.lastPrune > 3_600_000) {
        pruneTrace(db, now, TRACE_MAX_ROWS - 99); s.lastPrune = Date.parse(now);
      }
    })();
  } catch {
    const s = status(db); s.writeFailures++;
    const warn = !s.lastFailureAt || Date.parse(now) - Date.parse(s.lastFailureAt) >= 60_000;
    if (warn) { try { s.warn?.(); } catch { /* Disposed BB handles cannot affect execution either. */ } }
    s.lastFailureAt = now;
  }
}

export function pruneTrace(db: SqlDatabase, now: string, maxRows = TRACE_MAX_ROWS): void {
  const cutoff = new Date(Date.parse(now) - TRACE_DAYS * 86_400_000).toISOString();
  db.prepare(`DELETE FROM agency_trace WHERE last_at < ?`).run(cutoff);
  db.prepare(`DELETE FROM agency_trace WHERE id <= COALESCE((SELECT id FROM agency_trace ORDER BY id DESC LIMIT 1 OFFSET ?), -1)`).run(maxRows);
}

/** Owner-only RPC supplies this query. Cursor pages newest to oldest; repeated waits update their episode. */
export function listTrace(db: SqlDatabase, raw: Partial<TraceQuery>) {
  const q = traceQuerySchema.parse(raw);
  const clauses: string[] = []; const args: (string | number)[] = [];
  if (q.jobId) {
    clauses.push(q.descendants ? `job_id IN (WITH RECURSIVE family(id) AS (SELECT id FROM agency_job WHERE id = ? OR key = ? UNION SELECT j.id FROM agency_job j JOIN family f ON j.parent_job_id = f.id) SELECT id FROM family)` : `job_id IN (SELECT id FROM agency_job WHERE id = ? OR key = ?)`);
    args.push(q.jobId, q.jobId);
  }
  for (const [column, value, op] of [["last_at", q.since, ">="], ["step", q.step, "="], ["outcome", q.outcome, "="], ["repeats", q.minRepeats, ">="], ["duration_ms", q.minDurationMs, ">="]] as const) {
    if (value !== undefined) { clauses.push(`${column} ${op} ?`); args.push(value); }
  }
  const where = clauses.length ? clauses.join(" AND ") : "1=1";
  const summary = db.prepare(`SELECT step, outcome, reason, COUNT(*) AS episodes, SUM(repeats) AS observations, MAX(duration_ms) AS maxDurationMs FROM agency_trace WHERE ${where} GROUP BY step, outcome, reason ORDER BY observations DESC LIMIT 30`).all(...args) as Array<{ step: string; outcome: string; reason: string; episodes: number; observations: number; maxDurationMs: number | null }>;
  if (q.beforeId) { clauses.push("id < ?"); args.push(q.beforeId); }
  const rows = db.prepare(`SELECT id, first_at AS firstAt, last_at AS lastAt, repeats, job_id AS jobId, job_key AS jobKey, root_job_id AS rootJobId,
    revision, state, step, outcome, reason, request_id AS requestId, attempt_id AS attemptId, launch_id AS launchId, thread_id AS threadId,
    artifact_hash AS artifactHash, related_job_id AS relatedJobId, duration_ms AS durationMs, facts
    FROM agency_trace WHERE ${clauses.length ? clauses.join(" AND ") : "1=1"} ORDER BY id DESC LIMIT ?`).all(...args, q.limit + 1) as Array<Omit<z.infer<typeof traceRecordSchema>, "facts"> & { facts: string }>;
  const more = rows.length > q.limit; const records = rows.slice(0, q.limit).map(row => ({ ...row, facts: JSON.parse(row.facts) as Record<string, string | number | boolean> }));
  const oldest = db.prepare(`SELECT MIN(first_at) AS at FROM agency_trace`).get() as { at: string | null };
  return { records, nextBeforeId: more ? records.at(-1)!.id : null, summary, retention: { days: TRACE_DAYS, maxRows: TRACE_MAX_ROWS, oldestAt: oldest.at }, health: traceHealth(db) };
}
