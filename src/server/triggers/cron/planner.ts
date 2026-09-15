import { CronExpressionParser, type CronDate } from "cron-parser";
import {
  CRON_CATCH_UP_HARD_CAP,
  CRON_DUE_RANGE_CAP,
  CRON_PREVIEW_HARD_CAP,
  CronPlannerError,
  type CronRule,
  type CronSlot,
} from "./types.js";

const FIVE_FIELDS = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/;
const IANA = new Set([...Intl.supportedValuesOf("timeZone"), "UTC", "GMT", "Etc/UTC"]);

export type DuePlan = {
  emit: CronSlot[];
  skip: CronSlot[];
  lastDue: CronSlot | null;
  dueCount: number;
};

export function assertCronRule(rule: CronRule): void {
  if (!rule.ruleVersionId || !rule.topic) throw new CronPlannerError("cron_rule_identity_invalid");
  if (!FIVE_FIELDS.test(rule.expression) || /[Hh]/.test(rule.expression)) {
    throw new CronPlannerError("cron_expression_invalid");
  }
  if (!IANA.has(rule.timezone)) throw new CronPlannerError("cron_timezone_not_iana");
  if (rule.misfire !== "skip" && rule.misfire !== "last" && rule.misfire !== "catch_up") {
    throw new CronPlannerError("cron_misfire_invalid");
  }
  if (rule.misfire === "catch_up") {
    const limit = rule.catchUpLimit ?? 8;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CRON_CATCH_UP_HARD_CAP) {
      throw new CronPlannerError("cron_catch_up_limit_invalid");
    }
  }
  try {
    CronExpressionParser.parse(`0 ${rule.expression}`, {
      tz: rule.timezone,
      currentDate: "2026-01-01T00:00:00.000Z",
    }).next();
  } catch {
    throw new CronPlannerError("cron_expression_invalid");
  }
}

function slotFromDate(rule: CronRule, date: CronDate): CronSlot {
  const scheduledAtUtc = date.toISOString();
  if (!scheduledAtUtc) throw new CronPlannerError("cron_expression_invalid");
  return {
    scheduledAtUtc,
    timezone: rule.timezone,
    utcOffsetMinutes: date.getUTCOffset(),
    localHour: date.getHours(),
    localMinute: date.getMinutes(),
  };
}

function iterateAfter(rule: CronRule, afterUtcExclusive: string, limit: number): CronSlot[] {
  assertCronRule(rule);
  if (!Number.isFinite(Date.parse(afterUtcExclusive))) throw new CronPlannerError("cron_instant_invalid");
  const interval = CronExpressionParser.parse(`0 ${rule.expression}`, {
    tz: rule.timezone,
    currentDate: afterUtcExclusive,
  });
  const out: CronSlot[] = [];
  for (let i = 0; i < limit; i += 1) {
    try {
      out.push(slotFromDate(rule, interval.next()));
    } catch {
      break;
    }
  }
  return out;
}

export function previewOccurrences(
  rule: CronRule,
  input: { fromUtc: string; count: number; offset?: number },
): CronSlot[] {
  const count = input.count;
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(count) || count < 1 || count > CRON_PREVIEW_HARD_CAP) {
    throw new CronPlannerError("cron_preview_count_invalid");
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > CRON_PREVIEW_HARD_CAP) {
    throw new CronPlannerError("cron_preview_offset_invalid");
  }
  return iterateAfter(rule, input.fromUtc, offset + count).slice(offset);
}

/** Full due range until now. Partial prefix is never returned: overflow throws and last must stay put. */
export function planDueActions(
  rule: CronRule,
  input: { afterUtcExclusive: string; nowUtc: string },
): DuePlan {
  assertCronRule(rule);
  if (!Number.isFinite(Date.parse(input.afterUtcExclusive)) || !Number.isFinite(Date.parse(input.nowUtc))) {
    throw new CronPlannerError("cron_instant_invalid");
  }
  const nowMs = Date.parse(input.nowUtc);
  const interval = CronExpressionParser.parse(`0 ${rule.expression}`, {
    tz: rule.timezone,
    currentDate: input.afterUtcExclusive,
  });
  const due: CronSlot[] = [];
  for (;;) {
    let next: CronDate;
    try {
      next = interval.next();
    } catch {
      break;
    }
    const slot = slotFromDate(rule, next);
    if (Date.parse(slot.scheduledAtUtc) > nowMs) break;
    if (due.length >= CRON_DUE_RANGE_CAP) throw new CronPlannerError("cron_due_range_exceeded");
    due.push(slot);
  }
  return selectMisfireActions(rule, due);
}

export function selectMisfireActions(rule: CronRule, due: readonly CronSlot[]): DuePlan {
  const lastDue = due[due.length - 1] ?? null;
  if (due.length === 0) return { emit: [], skip: [], lastDue: null, dueCount: 0 };
  if (rule.misfire === "skip") {
    if (due.length === 1) return { emit: [due[0]!], skip: [], lastDue, dueCount: 1 };
    return { emit: [], skip: [...due], lastDue, dueCount: due.length };
  }
  if (rule.misfire === "last") {
    return { emit: [lastDue!], skip: due.slice(0, -1), lastDue, dueCount: due.length };
  }
  const limit = Math.min(rule.catchUpLimit ?? 8, CRON_CATCH_UP_HARD_CAP);
  return { emit: due.slice(0, limit), skip: due.slice(limit), lastDue, dueCount: due.length };
}
