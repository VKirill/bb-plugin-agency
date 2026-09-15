import type { TokenUsageTotals } from "../../../shared/contracts/dashboard-usage.js";

export const ZERO_TOTALS: TokenUsageTotals = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

export function emptyTotals(): TokenUsageTotals {
  return { ...ZERO_TOTALS };
}

export function addTotals(left: TokenUsageTotals, right: TokenUsageTotals): TokenUsageTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

export function subtractTotals(later: TokenUsageTotals, earlier: TokenUsageTotals): TokenUsageTotals | null {
  const delta: TokenUsageTotals = {
    inputTokens: later.inputTokens - earlier.inputTokens,
    cachedInputTokens: later.cachedInputTokens - earlier.cachedInputTokens,
    outputTokens: later.outputTokens - earlier.outputTokens,
    reasoningOutputTokens: later.reasoningOutputTokens - earlier.reasoningOutputTokens,
    totalTokens: later.totalTokens - earlier.totalTokens,
  };
  if (
    delta.inputTokens < 0 ||
    delta.cachedInputTokens < 0 ||
    delta.outputTokens < 0 ||
    delta.reasoningOutputTokens < 0 ||
    delta.totalTokens < 0
  ) {
    return null;
  }
  return delta;
}

export function totalsEqual(left: TokenUsageTotals, right: TokenUsageTotals): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.reasoningOutputTokens === right.reasoningOutputTokens &&
    left.totalTokens === right.totalTokens
  );
}

function asNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function parseTokenUsageTotals(raw: unknown): TokenUsageTotals | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const inputTokens = asNonNegativeInt(row.inputTokens);
  const cachedInputTokens = asNonNegativeInt(row.cachedInputTokens);
  const outputTokens = asNonNegativeInt(row.outputTokens);
  const reasoningOutputTokens = asNonNegativeInt(row.reasoningOutputTokens);
  const totalTokens = asNonNegativeInt(row.totalTokens);
  if (
    inputTokens === null ||
    cachedInputTokens === null ||
    outputTokens === null ||
    reasoningOutputTokens === null ||
    totalTokens === null
  ) {
    return null;
  }
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens };
}

export type TokenUsageEvent = {
  id: string;
  seq: number | null;
  createdAt: string;
  turnId: string | null;
  total: TokenUsageTotals;
  last: TokenUsageTotals | null;
};

function instantFromUnknown(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) return new Date(asNumber).toISOString();
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  return null;
}

export function parseTokenUsageEvent(raw: unknown): TokenUsageEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" && row.id.length > 0 ? row.id : null;
  const createdAt = instantFromUnknown(row.createdAt);
  const seq = typeof row.seq === "number" && Number.isInteger(row.seq) ? row.seq : null;
  const scope = row.scope && typeof row.scope === "object" ? (row.scope as Record<string, unknown>) : null;
  const turnId = scope && typeof scope.turnId === "string" ? scope.turnId : null;
  const data = row.data && typeof row.data === "object" ? (row.data as Record<string, unknown>) : null;
  const payload = row.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>) : null;
  const tokenUsageRaw = data?.tokenUsage ?? payload?.tokenUsage ?? row.tokenUsage;
  const tokenUsage = tokenUsageRaw && typeof tokenUsageRaw === "object" ? (tokenUsageRaw as Record<string, unknown>) : null;
  const total = parseTokenUsageTotals(tokenUsage?.total ?? tokenUsage);
  const last = parseTokenUsageTotals(tokenUsage?.last);
  if (!id || !createdAt || !total) return null;
  return { id, seq, createdAt, turnId, total, last };
}

export function sortUsageEvents(events: readonly TokenUsageEvent[]): TokenUsageEvent[] {
  return [...events].sort((a, b) => {
    if (a.seq !== null && b.seq !== null && a.seq !== b.seq) return a.seq - b.seq;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export const PROVEN_USAGE_PROVIDER_IDS = ["claude-code"] as const;

export function hasProvenUsageSemantics(providerId: string | null): boolean {
  return providerId === "claude-code";
}
