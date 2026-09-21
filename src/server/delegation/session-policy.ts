import { fail, ok, type DomainResult } from "../../domain";
import type { DelegationMode } from "./instructions";
import type {
  SessionEffectiveMode,
  SessionPolicyMode,
  SessionPolicyScope,
  SessionPolicyView,
} from "../../shared/contracts/session-policy";
import type { SqlDatabase } from "../db/sql";

export const SESSION_POLICY_MIGRATION = `CREATE TABLE agency_session_policy (
    scope TEXT NOT NULL CHECK(scope IN ('project', 'binding', 'thread')),
    scope_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('ordinary', 'suggest', 'pm')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(scope, scope_id)
  )`;

/** One-shot draft for the next new chat in a BB project (composer before first send). */
export const SESSION_PENDING_MIGRATION = `CREATE TABLE agency_session_pending (
    bb_project_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK(mode IN ('ordinary', 'suggest', 'pm')),
    updated_at TEXT NOT NULL
  )`;

const PENDING_TTL_MS = 30 * 60 * 1000;

const STORED = new Set<Exclude<SessionPolicyMode, "inherit">>(["ordinary", "suggest", "pm"]);

export function agencyFallbackMode(global: DelegationMode): SessionEffectiveMode {
  if (global === "off") return "ordinary";
  if (global === "suggest") return "suggest";
  return "pm";
}

function storedMode(db: SqlDatabase, scope: SessionPolicyScope, scopeId: string): SessionPolicyMode {
  if (!hasTable(db)) return "inherit";
  const row = db
    .prepare(`SELECT mode FROM agency_session_policy WHERE scope = ? AND scope_id = ?`)
    .get(scope, scopeId) as { mode: string } | undefined;
  return row && STORED.has(row.mode as Exclude<SessionPolicyMode, "inherit">)
    ? (row.mode as Exclude<SessionPolicyMode, "inherit">)
    : "inherit";
}

function hasTable(db: SqlDatabase): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agency_session_policy'`).get());
}

function hasPendingTable(db: SqlDatabase): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agency_session_pending'`).get());
}

function readPendingMode(db: SqlDatabase, bbProjectId: string, now: string): SessionPolicyMode {
  if (!hasPendingTable(db)) return "inherit";
  const row = db
    .prepare(`SELECT mode, updated_at FROM agency_session_pending WHERE bb_project_id = ?`)
    .get(bbProjectId) as { mode: string; updated_at: string } | undefined;
  if (!row || !STORED.has(row.mode as Exclude<SessionPolicyMode, "inherit">)) return "inherit";
  const age = Date.parse(now) - Date.parse(row.updated_at);
  if (!Number.isFinite(age) || age > PENDING_TTL_MS) {
    db.prepare(`DELETE FROM agency_session_pending WHERE bb_project_id = ?`).run(bbProjectId);
    return "inherit";
  }
  return row.mode as Exclude<SessionPolicyMode, "inherit">;
}

function clearPendingMode(db: SqlDatabase, bbProjectId: string): void {
  if (!hasPendingTable(db)) return;
  db.prepare(`DELETE FROM agency_session_pending WHERE bb_project_id = ?`).run(bbProjectId);
}

export function liveBindingForProject(db: SqlDatabase, bbProjectId: string): { id: string } | null {
  const rows = db
    .prepare(
      `SELECT id FROM agency_project_binding
       WHERE bb_project_id = ? AND (archived_at IS NULL OR archived_at = '')
       ORDER BY updated_at DESC`,
    )
    .all(bbProjectId) as { id: string }[];
  return rows.length === 1 ? rows[0] : null;
}

export function projectIdOfBinding(db: SqlDatabase, bindingId: string): string | null {
  const row = db.prepare(`SELECT bb_project_id FROM agency_project_binding WHERE id = ?`).get(bindingId) as
    | { bb_project_id: string }
    | undefined;
  return row?.bb_project_id ?? null;
}

export function projectIsConnected(db: SqlDatabase, bbProjectId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM agency_project_binding
       WHERE bb_project_id = ? AND (archived_at IS NULL OR archived_at = '')
       LIMIT 1`,
    )
    .get(bbProjectId) as { ok: number } | undefined;
  return Boolean(row);
}

/** Wider scope loses to a stored override. A unique live folder can pin a section. */
export function resolveSessionPolicy(
  db: SqlDatabase,
  input: { bbProjectId?: string | null; bindingId?: string | null; threadId?: string | null },
  global: DelegationMode,
): SessionPolicyView {
  const agency = agencyFallbackMode(global);
  const bbProjectId = input.bbProjectId?.trim() || (input.bindingId ? projectIdOfBinding(db, input.bindingId) : null);
  const unique = bbProjectId ? liveBindingForProject(db, bbProjectId) : null;
  const bindingId = unique?.id ?? null;
  const threadId = input.threadId?.trim() || null;
  const layers = {
    agency,
    project: bbProjectId ? storedMode(db, "project", bbProjectId) : "inherit",
    binding: bindingId ? storedMode(db, "binding", bindingId) : "inherit",
    thread: threadId ? storedMode(db, "thread", threadId) : "inherit",
  } as const;
  const pick = (mode: SessionPolicyMode, source: SessionPolicyView["source"]): { effective: SessionEffectiveMode; source: SessionPolicyView["source"] } | null =>
    mode === "inherit" ? null : { effective: mode, source };
  const resolved =
    pick(layers.thread, "thread") ??
    pick(layers.binding, "binding") ??
    pick(layers.project, "project") ?? { effective: agency, source: "agency" as const };
  const now = new Date().toISOString();
  return {
    effective: resolved.effective,
    source: resolved.source,
    layers,
    pending: bbProjectId ? readPendingMode(db, bbProjectId, now) : "inherit",
    bbProjectId,
    bindingId,
    threadId,
    connected: bbProjectId ? projectIsConnected(db, bbProjectId) : false,
  };
}

export function saveSessionPolicy(
  db: SqlDatabase,
  input: { scope: SessionPolicyScope; scopeId: string; mode: SessionPolicyMode },
  now: string,
): DomainResult<{ scope: SessionPolicyScope; scopeId: string; mode: SessionPolicyMode }> {
  if (input.scope === "binding" && !projectIdOfBinding(db, input.scopeId)) {
    return fail("not_found", `project binding ${input.scopeId} not found`);
  }
  if ((input.scope === "project" || input.scope === "pending") && !projectIsConnected(db, input.scopeId)) {
    return fail("not_found", `project ${input.scopeId} is not connected to the Agency`);
  }
  if (input.scope === "pending") {
    if (input.mode === "inherit") {
      clearPendingMode(db, input.scopeId);
      return ok({ scope: input.scope, scopeId: input.scopeId, mode: "inherit" });
    }
    db.prepare(
      `INSERT INTO agency_session_pending (bb_project_id, mode, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(bb_project_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
    ).run(input.scopeId, input.mode, now);
    return ok({ scope: input.scope, scopeId: input.scopeId, mode: input.mode });
  }
  if (input.mode === "inherit") {
    if (hasTable(db)) db.prepare(`DELETE FROM agency_session_policy WHERE scope = ? AND scope_id = ?`).run(input.scope, input.scopeId);
    return ok({ scope: input.scope, scopeId: input.scopeId, mode: "inherit" });
  }
  db.prepare(
    `INSERT INTO agency_session_policy (scope, scope_id, mode, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(scope, scope_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
  ).run(input.scope, input.scopeId, input.mode, now);
  return ok({ scope: input.scope, scopeId: input.scopeId, mode: input.mode });
}

/**
 * Pin a new-chat draft onto this thread the first time ordinary-chat instructions
 * are built. Isolated Agency runs never call this (worker threads exit earlier).
 */
export function applyPendingSessionPolicy(
  db: SqlDatabase,
  input: { bbProjectId: string; threadId: string },
  now: string,
): void {
  const pending = readPendingMode(db, input.bbProjectId, now);
  if (pending === "inherit") return;
  if (storedMode(db, "thread", input.threadId) !== "inherit") return;
  saveSessionPolicy(db, { scope: "thread", scopeId: input.threadId, mode: pending }, now);
  clearPendingMode(db, input.bbProjectId);
}
