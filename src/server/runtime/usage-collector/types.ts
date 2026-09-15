import type { TokenUsageTotals } from "../../../shared/contracts/dashboard-usage.js";

export type BoundThreadPort = {
  isBound(threadId: string): boolean;
};

export type CapturedUsageEvent = {
  threadId: string;
  eventId: string;
  seq: number;
  createdAt: string;
  providerThreadId: string | null;
  turnId: string | null;
  last: TokenUsageTotals;
  total: TokenUsageTotals;
  capturedAt: string;
};

export type IngestStatus = "inserted" | "duplicate";

export type CaptureCounts = {
  inserted: number;
  duplicate: number;
  conflict: number;
  malformed: number;
  unbound: number;
  liveUnavailable: number;
};
