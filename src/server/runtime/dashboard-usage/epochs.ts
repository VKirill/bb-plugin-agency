import type { DashboardDayHistoryReason, TokenUsageTotals } from "../../../shared/contracts/dashboard-usage.js";
import {
  addTotals,
  parseTokenUsageEvent,
  sortUsageEvents,
  subtractTotals,
  totalsEqual,
  type TokenUsageEvent,
} from "./units.js";

export type ThreadUsageFold =
  | {
      unknown: false;
      peaks: TokenUsageTotals;
      sessionLatestTotal: TokenUsageTotals;
      epochCount: number;
      days: Array<TokenUsageTotals & { date: string }>;
      reasons: DashboardDayHistoryReason[];
    }
  | {
      unknown: true;
      reason: "empty" | "malformed";
      epochCount: 0;
      days: [];
      reasons: DashboardDayHistoryReason[];
    };

function utcDate(createdAt: string): string {
  return createdAt.slice(0, 10);
}

function startsNewEpoch(previous: TokenUsageEvent | undefined, current: TokenUsageEvent): boolean {
  if (!previous) return true;
  if (current.total.totalTokens < previous.total.totalTokens) return true;
  if (current.last && current.last.totalTokens === current.total.totalTokens) return true;
  return false;
}

function peakOf(events: readonly TokenUsageEvent[]): TokenUsageTotals {
  let peak = events[0]!.total;
  for (const event of events) {
    if (event.total.totalTokens > peak.totalTokens) peak = event.total;
  }
  return peak;
}

function daysInsideEpoch(events: readonly TokenUsageEvent[]): Array<TokenUsageTotals & { date: string }> {
  const days: Array<TokenUsageTotals & { date: string }> = [];
  for (let index = 1; index < events.length; index += 1) {
    const earlier = events[index - 1]!;
    const later = events[index]!;
    if (!later.last) continue;
    const delta = subtractTotals(later.total, earlier.total);
    if (!delta || !totalsEqual(delta, later.last)) continue;
    days.push({ date: utcDate(later.createdAt), ...delta });
  }
  return days;
}

export function foldThreadUsage(rawEvents: readonly unknown[]): ThreadUsageFold {
  const events: TokenUsageEvent[] = [];
  let malformed = false;
  for (const raw of rawEvents) {
    const event = parseTokenUsageEvent(raw);
    if (!event) {
      malformed = true;
      continue;
    }
    events.push(event);
  }
  const ordered = sortUsageEvents(events);
  if (ordered.length === 0) {
    return {
      unknown: true,
      reason: malformed ? "malformed" : "empty",
      epochCount: 0,
      days: [],
      reasons: [malformed ? "malformed" : "empty"],
    };
  }

  const epochs: TokenUsageEvent[][] = [];
  for (const event of ordered) {
    const previous = epochs.at(-1)?.at(-1);
    if (startsNewEpoch(previous, event)) epochs.push([event]);
    else epochs.at(-1)!.push(event);
  }

  const reasons: DashboardDayHistoryReason[] = [];
  if (malformed) reasons.push("malformed");
  if (epochs.length === 1 && epochs[0]!.length === 1) reasons.push("single_snapshot");
  if (epochs.length > 1) reasons.push("epoch_reset");
  for (const epoch of epochs) {
    const first = epoch[0]!;
    if (first.last && first.last.totalTokens < first.total.totalTokens) reasons.push("prefix_pruned");
  }

  let peaks = peakOf(epochs[0]!);
  for (const epoch of epochs.slice(1)) peaks = addTotals(peaks, peakOf(epoch));

  const days: Array<TokenUsageTotals & { date: string }> = [];
  for (const epoch of epochs) days.push(...daysInsideEpoch(epoch));

  return {
    unknown: false,
    peaks,
    sessionLatestTotal: ordered[ordered.length - 1]!.total,
    epochCount: epochs.length,
    days,
    reasons: [...new Set(reasons)],
  };
}
