import type { SqlDatabase } from "../../db/sql";

/**
 * Commands an employee ran outside the CLI sandbox. BB marks such a command in the
 * thread with a badge; the Agency counts them per attempt so the job card shows it
 * instead of the escape passing silently.
 */

export const SANDBOX_ESCAPE_MIGRATION = `CREATE TABLE agency_sandbox_escape (
  attempt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  commands INTEGER NOT NULL,
  last_seq TEXT,
  updated_at TEXT NOT NULL
)`;

/** Badge BB puts on a command the CLI ran with its sandbox disabled. */
const OUTSIDE_SANDBOX_GLYPH = "SquareUnlock02";
const OUTSIDE_SANDBOX_LABEL = "Outside of sandbox";

type EventRow = { seq?: string | number; type?: string; data?: unknown };

export type SandboxEventsPort = {
  /** Events of one thread in ascending order after `afterSeq`. */
  list(args: { threadId: string; afterSeq?: string; limit: number }): Promise<readonly EventRow[]>;
};

/** Item id of a started command that ran outside the sandbox; null for anything else. */
export function outsideSandboxItemId(event: EventRow): string | null {
  if (event.type !== "item/started") return null;
  const item = (event.data as { item?: { id?: unknown; presentation?: { badge?: { glyph?: unknown; label?: unknown } } } } | undefined)?.item;
  const badge = item?.presentation?.badge;
  if (!badge || (badge.glyph !== OUTSIDE_SANDBOX_GLYPH && badge.label !== OUTSIDE_SANDBOX_LABEL)) return null;
  return typeof item?.id === "string" ? item.id : null;
}

type AttemptRef = { attemptId: string; jobId: string; threadId: string };

/**
 * Reads new events of each attempt's thread and adds the escaped commands. Returns the
 * attempts whose count grew. A failing thread read is skipped until the next pass.
 */
export async function scanSandboxEscapes(
  deps: { isActive?: () => boolean; db: SqlDatabase; events: SandboxEventsPort; now: () => string; pageSize?: number; maxPages?: number; onReadError?: (threadId: string, error: unknown) => void },
  attempts: readonly AttemptRef[],
): Promise<string[]> {
  // BB returns at most 100 thread events per call.
  // BB refuses an event limit of 100 («Thread event limit cannot exceed 100»), so pages stay smaller.
  const active = () => deps.isActive?.() !== false;
  if (!active()) return [];
  const pageSize = Math.min(deps.pageSize ?? 50, 99);
  const maxPages = deps.maxPages ?? 20;
  const grew: string[] = [];
  for (const attempt of attempts) {
    if (!active()) return grew;
    const row = deps.db.prepare(`SELECT commands, last_seq FROM agency_sandbox_escape WHERE attempt_id = ?`).get(attempt.attemptId) as
      | { commands: number; last_seq: string | null }
      | undefined;
    let afterSeq = row?.last_seq ?? undefined;
    let added = 0;
    let read = false;
    try {
      for (let page = 0; page < maxPages; page += 1) {
        const chunk = await deps.events.list({ threadId: attempt.threadId, ...(afterSeq ? { afterSeq } : {}), limit: pageSize });
        if (!active()) return grew;
        read = true;
        for (const event of chunk) if (outsideSandboxItemId(event)) added += 1;
        const last = chunk.at(-1);
        if (last?.seq !== undefined) afterSeq = String(last.seq);
        if (chunk.length < pageSize) break;
      }
    } catch (error) {
      if (!active()) return grew;
      deps.onReadError?.(attempt.threadId, error);
      if (!read) continue;
    }
    if (!read) continue;
    deps.db
      .prepare(
        `INSERT INTO agency_sandbox_escape (attempt_id, job_id, thread_id, commands, last_seq, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(attempt_id) DO UPDATE SET commands = commands + excluded.commands, last_seq = excluded.last_seq, updated_at = excluded.updated_at`,
      )
      .run(attempt.attemptId, attempt.jobId, attempt.threadId, added, afterSeq ?? null, deps.now());
    if (added > 0) grew.push(attempt.attemptId);
  }
  return grew;
}

/** Escaped commands by attempt; attempts without any are absent. */
export function sandboxEscapeCounts(db: SqlDatabase, attemptIds: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (!attemptIds.length) return counts;
  const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agency_sandbox_escape'`).get();
  if (!exists) return counts;
  const rows = db
    .prepare(`SELECT attempt_id, commands FROM agency_sandbox_escape WHERE commands > 0 AND attempt_id IN (${attemptIds.map(() => "?").join(", ")})`)
    .all(...attemptIds) as { attempt_id: string; commands: number }[];
  for (const row of rows) counts.set(row.attempt_id, row.commands);
  return counts;
}
