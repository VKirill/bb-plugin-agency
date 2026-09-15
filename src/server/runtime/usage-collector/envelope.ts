import {
  parseTokenUsageEvent,
  parseTokenUsageTotals,
} from "../dashboard-usage/units.js";
import type { CapturedUsageEvent } from "./types.js";

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function envelopeRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

function nestedObject(row: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = row[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function rawThreadId(raw: unknown): string | null {
  const row = envelopeRecord(raw);
  return row ? optionalString(row.threadId) : null;
}

export function rawProviderThreadId(raw: unknown): string | null {
  const row = envelopeRecord(raw);
  if (!row) return null;
  const data = nestedObject(row, "data");
  const payload = nestedObject(row, "payload");
  return (
    optionalString(data?.providerThreadId) ??
    optionalString(payload?.providerThreadId) ??
    optionalString(row.providerThreadId)
  );
}

export function typedUsageEvent(threadId: string, raw: unknown): Omit<CapturedUsageEvent, "capturedAt"> | null {
  const parsed = parseTokenUsageEvent(raw);
  if (!parsed || parsed.seq === null || !parsed.last) return null;
  const envelopeThreadId = rawThreadId(raw);
  if (envelopeThreadId && envelopeThreadId !== threadId) return null;
  return {
    threadId,
    eventId: parsed.id,
    seq: parsed.seq,
    createdAt: parsed.createdAt,
    providerThreadId: rawProviderThreadId(raw),
    turnId: parsed.turnId,
    last: parsed.last,
    total: parsed.total,
  };
}

export function toLiveEnvelope(row: CapturedUsageEvent): unknown {
  return {
    id: row.eventId,
    threadId: row.threadId,
    seq: row.seq,
    createdAt: row.createdAt,
    type: "thread/tokenUsage/updated",
    scope: row.turnId ? { kind: "turn", turnId: row.turnId } : { kind: "turn" },
    data: {
      ...(row.providerThreadId ? { providerThreadId: row.providerThreadId } : {}),
      tokenUsage: { last: row.last, total: row.total },
    },
  };
}

export function totalsFromJson(raw: string) {
  return parseTokenUsageTotals(JSON.parse(raw) as unknown);
}
