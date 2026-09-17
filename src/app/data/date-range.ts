import { uiLocale } from "../i18n";

/**
 * One calendar for both ends of a period: the first click sets the start, the second the end,
 * the third starts over. Dates are ISO days (YYYY-MM-DD) — the same strings the filter stores.
 */

export type DateRange = { fromDate: string; toDate: string };

export const EMPTY_RANGE: DateRange = { fromDate: "", toDate: "" };

export function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Monday-first weeks covering the month, with the neighbouring days that fill the grid. */
export function monthGrid(year: number, month: number): string[][] {
  const first = new Date(Date.UTC(year, month, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const start = new Date(first.getTime());
  start.setUTCDate(start.getUTCDate() - lead);
  const weeks: string[][] = [];
  const cursor = new Date(start.getTime());
  for (let week = 0; week < 6; week += 1) {
    const days: string[] = [];
    for (let day = 0; day < 7; day += 1) {
      days.push(isoDay(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    weeks.push(days);
    // Six rows only when the month needs them.
    if (week >= 3 && new Date(`${days[6]}T00:00:00Z`).getUTCMonth() !== month) break;
  }
  return weeks;
}

export function monthOf(value: string, fallback = new Date()): { year: number; month: number } {
  const parsed = parseDay(value) ?? fallback;
  return { year: parsed.getUTCFullYear(), month: parsed.getUTCMonth() };
}

export function shiftMonth(view: { year: number; month: number }, by: number): { year: number; month: number } {
  const moved = new Date(Date.UTC(view.year, view.month + by, 1));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() };
}

/** What a click on `day` does to the range: open a new one, close it, or start over. */
export function pickDay(range: DateRange, day: string): DateRange {
  if (!range.fromDate || (range.fromDate && range.toDate)) return { fromDate: day, toDate: "" };
  // The second click can land before the first: the earlier day is the start.
  return day < range.fromDate ? { fromDate: day, toDate: range.fromDate } : { fromDate: range.fromDate, toDate: day };
}

export function inRange(day: string, range: DateRange): boolean {
  if (!range.fromDate || !range.toDate) return false;
  return day >= range.fromDate && day <= range.toDate;
}

export function sameMonth(day: string, view: { year: number; month: number }): boolean {
  const parsed = parseDay(day);
  return Boolean(parsed && parsed.getUTCFullYear() === view.year && parsed.getUTCMonth() === view.month);
}

export function formatDay(day: string): string {
  const parsed = parseDay(day);
  return parsed
    ? parsed.toLocaleDateString(uiLocale(), { day: "2-digit", month: "short", timeZone: "UTC" })
    : day;
}

export function formatMonth(view: { year: number; month: number }): string {
  return new Date(Date.UTC(view.year, view.month, 1)).toLocaleDateString(uiLocale(), {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** What the trigger says: «11 сент. — 17 сент.», one date with an open end, or nothing chosen. */
export function formatRange(range: DateRange, whole: string): string {
  if (!range.fromDate && !range.toDate) return whole;
  if (range.fromDate && !range.toDate) return `${formatDay(range.fromDate)} — …`;
  if (!range.fromDate && range.toDate) return `… — ${formatDay(range.toDate)}`;
  return `${formatDay(range.fromDate)} — ${formatDay(range.toDate)}`;
}
