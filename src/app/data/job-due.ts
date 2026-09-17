import { tr, uiLocale } from "../i18n";
import type { State } from "../prototype/data";

export type DueTone = "overdue" | "soon" | "set";

export type DueStatus = { tone: DueTone; label: string; hint: string };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Without department rules the board uses the agency default window. */
const DEFAULT_WINDOW_HOURS = 24;

function dayMonth(at: Date): string {
  return at.toLocaleDateString(uiLocale(), { day: "numeric", month: "short" }).replace(".", "");
}

/**
 * How a due date reads on the board: overdue, due soon (inside the
 * department's reminder window) or just set. Closed jobs have no due status.
 */
export function dueStatus(job: { state: State; due?: string; dueAt?: string | null; dueWindowHours?: number }, now: number): DueStatus | null {
  if (job.state === "done" || job.state === "canceled") return null;
  const instant = job.dueAt ?? (job.due ? `${job.due}T23:59:00` : null);
  if (!instant) return null;
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return null;
  const left = at.getTime() - now;
  const date = dayMonth(at);
  if (left <= 0) {
    const late = -left;
    const age = late < DAY ? tr("{n} ч", { n: Math.max(1, Math.floor(late / HOUR)) }) : tr("{n} дн", { n: Math.floor(late / DAY) });
    return { tone: "overdue", label: tr("просрочена {age}", { age }), hint: tr("Срок {date} прошёл {age} назад", { date, age }) };
  }
  const window = (job.dueWindowHours ?? DEFAULT_WINDOW_HOURS) * HOUR;
  if (window > 0 && left <= window) {
    const rest = left < DAY ? tr("{n} ч", { n: Math.max(1, Math.ceil(left / HOUR)) }) : tr("{n} дн", { n: Math.ceil(left / DAY) });
    return { tone: "soon", label: tr("срок через {rest}", { rest }), hint: tr("Срок {date}: осталось {rest}", { date, rest }) };
  }
  return { tone: "set", label: tr("до {date}", { date }), hint: tr("Срок {date}", { date }) };
}

export const DUE_TONE_CLASS: Record<DueTone, string> = {
  overdue: "text-red-600 dark:text-red-400 font-medium",
  soon: "text-amber-600 dark:text-amber-500 font-medium",
  set: "text-muted-foreground",
};
