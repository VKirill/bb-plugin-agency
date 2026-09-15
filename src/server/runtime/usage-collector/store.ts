import { fail, ok, type DomainResult } from "../../../domain/result.js";
import { toJson, type SqlDatabase } from "../../db/sql.js";
import { totalsEqual } from "../dashboard-usage/units.js";
import { toLiveEnvelope, totalsFromJson } from "./envelope.js";
import type { CapturedUsageEvent, IngestStatus } from "./types.js";

type StoredRow = {
  thread_id: string;
  event_id: string;
  seq: number;
  created_at: string;
  provider_thread_id: string | null;
  turn_id: string | null;
  last_json: string;
  total_json: string;
  captured_at: string;
};

function isConstraintError(error: unknown): boolean {
  const code = String((error as { code?: unknown }).code);
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT";
}

function sameNullable(left: string | null, right: string | null): boolean {
  return left === right;
}

function capturedFromRow(row: StoredRow): CapturedUsageEvent | null {
  const last = totalsFromJson(row.last_json);
  const total = totalsFromJson(row.total_json);
  if (!last || !total) return null;
  return {
    threadId: row.thread_id,
    eventId: row.event_id,
    seq: row.seq,
    createdAt: row.created_at,
    providerThreadId: row.provider_thread_id,
    turnId: row.turn_id,
    last,
    total,
    capturedAt: row.captured_at,
  };
}

function payloadMatches(existing: CapturedUsageEvent, next: Omit<CapturedUsageEvent, "capturedAt">): boolean {
  return (
    existing.seq === next.seq &&
    existing.createdAt === next.createdAt &&
    sameNullable(existing.providerThreadId, next.providerThreadId) &&
    sameNullable(existing.turnId, next.turnId) &&
    totalsEqual(existing.last, next.last) &&
    totalsEqual(existing.total, next.total)
  );
}

export function createUsageEventStore(db: SqlDatabase) {
  const readById = db.prepare(
    `SELECT thread_id, event_id, seq, created_at, provider_thread_id, turn_id, last_json, total_json, captured_at
     FROM agency_usage_event WHERE thread_id = ? AND event_id = ?`,
  );
  const readBySeq = db.prepare(
    `SELECT thread_id, event_id, seq, created_at, provider_thread_id, turn_id, last_json, total_json, captured_at
     FROM agency_usage_event WHERE thread_id = ? AND seq = ?`,
  );
  const readThread = db.prepare(
    `SELECT thread_id, event_id, seq, created_at, provider_thread_id, turn_id, last_json, total_json, captured_at
     FROM agency_usage_event WHERE thread_id = ? ORDER BY seq ASC, event_id ASC`,
  );
  const insertRow = db.prepare(
    `INSERT INTO agency_usage_event (
      thread_id, event_id, seq, created_at, provider_thread_id, turn_id, last_json, total_json, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  function readCaptured(row: StoredRow | undefined): CapturedUsageEvent | null {
    return row ? capturedFromRow(row) : null;
  }

  const write = db.transaction((input: Omit<CapturedUsageEvent, "capturedAt">): DomainResult<IngestStatus> => {
    const existing = readCaptured(readById.get(input.threadId, input.eventId) as StoredRow | undefined);
    if (existing) {
      if (payloadMatches(existing, input)) return ok("duplicate");
      return fail("request_conflict", `usage event ${input.eventId} already stored on ${input.threadId} with a different payload`);
    }
    const seqOwner = readCaptured(readBySeq.get(input.threadId, input.seq) as StoredRow | undefined);
    if (seqOwner && seqOwner.eventId !== input.eventId) {
      return fail(
        "request_conflict",
        `seq ${input.seq} already stored on ${input.threadId} as ${seqOwner.eventId}`,
      );
    }
    const capturedAt = new Date().toISOString();
    try {
      insertRow.run(
        input.threadId,
        input.eventId,
        input.seq,
        input.createdAt,
        input.providerThreadId,
        input.turnId,
        toJson(input.last),
        toJson(input.total),
        capturedAt,
      );
    } catch (error) {
      if (isConstraintError(error)) {
        return fail("request_conflict", `usage event ${input.eventId} conflicted on ${input.threadId}`);
      }
      throw error;
    }
    return ok("inserted");
  });

  function listCaptured(threadId: string): CapturedUsageEvent[] {
    const rows = readThread.all(threadId) as StoredRow[];
    const out: CapturedUsageEvent[] = [];
    for (const row of rows) {
      const captured = capturedFromRow(row);
      if (captured) out.push(captured);
    }
    return out;
  }

  return {
    ingest(input: Omit<CapturedUsageEvent, "capturedAt">): DomainResult<IngestStatus> {
      return write(input);
    },
    listCaptured,
    listEnvelopes(threadId: string): unknown[] {
      return listCaptured(threadId).map(toLiveEnvelope);
    },
    count(threadId?: string): number {
      if (threadId) {
        return (db.prepare(`SELECT count(*) AS n FROM agency_usage_event WHERE thread_id = ?`).get(threadId) as { n: number }).n;
      }
      return (db.prepare(`SELECT count(*) AS n FROM agency_usage_event`).get() as { n: number }).n;
    },
  };
}

export type UsageEventStore = ReturnType<typeof createUsageEventStore>;
