import { recordTrace } from "../trace/store";
import { randomBytes } from "node:crypto";
import { sha256Hex } from "../context-snapshot/canonical.js";
import type { SqlDatabase } from "../../db/sql";
import { asCause, asRelation, type LoopCause, type LoopMark, type LoopRelation } from "./mark.js";

export const LOOP_MARK_MIGRATION = `CREATE TABLE agency_loop_mark (
    id TEXT PRIMARY KEY,
    root_job_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    relation TEXT,
    cause TEXT,
    created_at TEXT NOT NULL
  );
CREATE INDEX agency_loop_mark_root_idx ON agency_loop_mark(root_job_id, created_at)`;

type MarkRow = { relation: string | null; cause: string | null };

function tableReady(db: SqlDatabase): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agency_loop_mark'`).get());
}

/** Walk parents to the product. A missing row stays itself so a caller still has a key. */
export function rootJobId(db: SqlDatabase, jobId: string): string {
  let current = jobId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const row = db.prepare(`SELECT parent_job_id FROM agency_job WHERE id = ?`).get(current) as
      | { parent_job_id: string | null }
      | undefined;
    if (!row?.parent_job_id) return current;
    current = row.parent_job_id;
  }
  return jobId;
}

export function latestLoopMark(db: SqlDatabase, rootId: string, workJobId?: string): LoopMark | null {
  if (!tableReady(db)) return null;
  const row = db
    .prepare(`SELECT relation, cause FROM agency_loop_mark WHERE root_job_id = ? AND (? IS NULL OR work_job_id = ? OR work_job_id IS NULL) ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(rootId, workJobId ?? null, workJobId ?? null) as MarkRow | undefined;
  if (!row) return null;
  return { relation: asRelation(row.relation), cause: asCause(row.cause) };
}

export function loopFingerprint(acceptance: string, defects: string, evidenceHash: string): string {
  const body = defects.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 2_000);
  return sha256Hex(`${acceptance.trim()}\n${body}\n${evidenceHash}`);
}

export function hasLoopFingerprint(db: SqlDatabase, rootId: string, fingerprint: string): boolean {
  if (!tableReady(db)) return false;
  return Boolean(
    db.prepare(`SELECT 1 FROM agency_loop_mark WHERE root_job_id = ? AND fingerprint = ? LIMIT 1`).get(rootId, fingerprint),
  );
}

/** Session key is the attempt. An empty attempt is not a session: the caller skips the write. */
export function insertLoopMark(
  db: SqlDatabase,
  input: {
    rootJobId: string;
    workJobId?: string | null;
    attemptId: string;
    fingerprint: string;
    relation: LoopRelation | null;
    cause: LoopCause | null;
    createdAt: string;
  },
): void {
  if (!input.attemptId.trim() || !tableReady(db)) return;
  db.prepare(
    `INSERT INTO agency_loop_mark (id, root_job_id, attempt_id, fingerprint, relation, cause, created_at, work_job_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `lmk_${randomBytes(12).toString("hex")}`,
    input.rootJobId,
    input.attemptId,
    input.fingerprint,
    input.relation,
    input.cause,
    input.createdAt,
    input.workJobId ?? null,
  );
  recordTrace(db, { jobId: input.workJobId ?? input.rootJobId, step: "loop.mark", outcome: "blocked", reason: input.cause ?? "unclassified", attemptId: input.attemptId, artifactHash: input.fingerprint, facts: { relation: input.relation, cause: input.cause } });
}

export function latestAttemptId(db: SqlDatabase, jobId: string): string | null {
  const row = db
    .prepare(`SELECT id FROM agency_run_attempt WHERE job_id = ? ORDER BY attempt_no DESC LIMIT 1`)
    .get(jobId) as { id: string } | undefined;
  return row?.id ?? null;
}

export function latestEvidenceHash(db: SqlDatabase, jobId: string): string {
  const row = db
    .prepare(`SELECT hash FROM agency_artifact_version WHERE job_id = ? ORDER BY rowid DESC LIMIT 1`)
    .get(jobId) as { hash: string } | undefined;
  return row?.hash ?? "none";
}
