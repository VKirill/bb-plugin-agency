import type { SqlDatabase } from "../../db/sql";
import { assertCronRule, planDueActions } from "./planner.js";
import {
  cronEventId,
  CronPlannerError,
  type CronInboxPort,
  type CronRule,
  type CronSlot,
  type OccurrenceState,
  type TickItem,
} from "./types.js";

type CursorRow = {
  rule_version_id: string;
  timezone: string;
  last_scheduled_at_utc: string | null;
  updated_at: string;
};

type OccurrenceRow = {
  rule_version_id: string;
  scheduled_at_utc: string;
  state: OccurrenceState;
  inbox_id: string | null;
};

export function createCronOccurrenceStore(db: SqlDatabase, inbox: CronInboxPort) {
  const readCursor = (ruleVersionId: string) =>
    db.prepare(`SELECT * FROM agency_schedule_cursor WHERE rule_version_id = ?`).get(ruleVersionId) as
      | CursorRow
      | undefined;
  const readOccurrence = (ruleVersionId: string, scheduledAtUtc: string) =>
    db.prepare(
      `SELECT rule_version_id, scheduled_at_utc, state, inbox_id FROM agency_schedule_occurrence
       WHERE rule_version_id = ? AND scheduled_at_utc = ?`,
    ).get(ruleVersionId, scheduledAtUtc) as OccurrenceRow | undefined;

  const writeCursor = (rule: CronRule, lastScheduledAtUtc: string | null, nowUtc: string) => {
    db.prepare(
      `INSERT INTO agency_schedule_cursor (rule_version_id, timezone, last_scheduled_at_utc, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(rule_version_id) DO UPDATE SET
         timezone = excluded.timezone,
         last_scheduled_at_utc = excluded.last_scheduled_at_utc,
         updated_at = excluded.updated_at`,
    ).run(rule.ruleVersionId, rule.timezone, lastScheduledAtUtc, nowUtc);
  };

  const persistSlot = db.transaction((rule: CronRule, slot: CronSlot, state: "emitted" | "skipped", nowUtc: string) => {
    const existing = readOccurrence(rule.ruleVersionId, slot.scheduledAtUtc);
    if (existing && existing.state !== "planned") {
      return {
        ruleVersionId: rule.ruleVersionId,
        scheduledAtUtc: slot.scheduledAtUtc,
        state: existing.state,
        inboxId: existing.inbox_id,
        duplicate: true,
      } satisfies TickItem;
    }
    if (!existing) {
      db.prepare(
        `INSERT OR IGNORE INTO agency_schedule_occurrence (
          rule_version_id, scheduled_at_utc, timezone, utc_offset_minutes, misfire, state, inbox_id, created_at
        ) VALUES (?, ?, ?, ?, ?, 'planned', NULL, ?)`,
      ).run(rule.ruleVersionId, slot.scheduledAtUtc, slot.timezone, slot.utcOffsetMinutes, rule.misfire, nowUtc);
      const raced = readOccurrence(rule.ruleVersionId, slot.scheduledAtUtc);
      if (raced && raced.state !== "planned") {
        return {
          ruleVersionId: rule.ruleVersionId,
          scheduledAtUtc: slot.scheduledAtUtc,
          state: raced.state,
          inboxId: raced.inbox_id,
          duplicate: true,
        } satisfies TickItem;
      }
    }
    let inboxId: string | null = null;
    let duplicate = false;
    if (state === "emitted") {
      const receipt = inbox.persistAccepted({
        eventId: cronEventId(rule.ruleVersionId, slot.scheduledAtUtc),
        topic: rule.topic,
        occurredAt: slot.scheduledAtUtc,
        ruleVersionId: rule.ruleVersionId,
        scheduledAtUtc: slot.scheduledAtUtc,
        timezone: slot.timezone,
        utcOffsetMinutes: slot.utcOffsetMinutes,
      });
      inboxId = receipt.inboxId;
      duplicate = receipt.duplicate;
    }
    db.prepare(
      `UPDATE agency_schedule_occurrence SET state = ?, inbox_id = ? WHERE rule_version_id = ? AND scheduled_at_utc = ?`,
    ).run(state, inboxId, rule.ruleVersionId, slot.scheduledAtUtc);
    return {
      ruleVersionId: rule.ruleVersionId,
      scheduledAtUtc: slot.scheduledAtUtc,
      state,
      inboxId,
      duplicate,
    } satisfies TickItem;
  });

  function tick(rules: readonly CronRule[], nowUtc: string): TickItem[] {
    if (!Number.isFinite(Date.parse(nowUtc))) throw new CronPlannerError("cron_instant_invalid");
    const processed: TickItem[] = [];
    for (const rule of rules) {
      assertCronRule(rule);
      const cursor = readCursor(rule.ruleVersionId);
      const afterUtcExclusive = cursor?.last_scheduled_at_utc ?? nowUtc;
      const actions = planDueActions(rule, { afterUtcExclusive, nowUtc });
      for (const slot of actions.skip) processed.push(persistSlot.immediate(rule, slot, "skipped", nowUtc));
      for (const slot of actions.emit) processed.push(persistSlot.immediate(rule, slot, "emitted", nowUtc));
      writeCursor(rule, actions.lastDue?.scheduledAtUtc ?? afterUtcExclusive, nowUtc);
    }
    return processed;
  }

  return {
    tick,
    readOccurrence,
    readCursor,
  };
}
