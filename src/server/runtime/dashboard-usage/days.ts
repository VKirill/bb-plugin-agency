import type { DashboardUsageDay, TokenUsageTotals } from "../../../shared/contracts/dashboard-usage.js";
import { addTotals } from "./units.js";

export type AttributedDayDelta = TokenUsageTotals & {
  date: string;
  threadId: string;
  bbProjectId: string | null;
  departmentId: string | null;
  model: string | null;
  modelSource: "snapshot" | null;
};

function dayKey(row: AttributedDayDelta): string {
  return [row.date, row.threadId, row.bbProjectId ?? "", row.departmentId ?? "", row.model ?? ""].join("\0");
}

/** Merge only identical date+thread+assignment. Never a zero placeholder day. */
export function mergeAttributedDayDeltas(deltas: readonly AttributedDayDelta[]): DashboardUsageDay[] {
  const byKey = new Map<string, AttributedDayDelta>();
  const order: string[] = [];
  for (const row of deltas) {
    const key = dayKey(row);
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, { ...row });
      order.push(key);
      continue;
    }
    byKey.set(key, { ...previous, ...addTotals(previous, row) });
  }
  return order
    .map((key) => byKey.get(key)!)
    .sort((left, right) => {
      if (left.date !== right.date) return left.date < right.date ? -1 : 1;
      return left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0;
    });
}

export function filterDaysByPeriod(
  days: readonly DashboardUsageDay[],
  fromDate: string | undefined,
  toDate: string | undefined,
): DashboardUsageDay[] {
  return days.filter((day) => {
    if (fromDate && day.date < fromDate) return false;
    if (toDate && day.date > toDate) return false;
    return true;
  });
}
