import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  CRON_DUE_RANGE_CAP,
  CRON_OCCURRENCE_MIGRATION,
  CronPlannerError,
  createCronOccurrenceStore,
  cronEventId,
  previewOccurrences,
  type CronInboxDraft,
  type CronInboxPort,
  type CronRule,
} from "../src/server/triggers/cron";

const dirs: string[] = [];
const handles: Database.Database[] = [];

afterEach(() => {
  for (const db of handles.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function memoryInbox(): CronInboxPort & { drafts: CronInboxDraft[] } {
  const ids = new Map<string, string>();
  const drafts: CronInboxDraft[] = [];
  return {
    drafts,
    persistAccepted(draft) {
      const existing = ids.get(draft.eventId);
      if (existing) return { inboxId: existing, duplicate: true };
      const inboxId = `inbox_${ids.size + 1}`;
      ids.set(draft.eventId, inboxId);
      drafts.push(draft);
      return { inboxId, duplicate: false };
    },
  };
}

function openStore(inbox: CronInboxPort = memoryInbox()) {
  const dir = mkdtempSync(join(tmpdir(), "agy-cron-"));
  dirs.push(dir);
  const path = join(dir, "agency.sqlite");
  const db = new Database(path);
  handles.push(db);
  db.pragma("journal_mode=WAL");
  db.exec(CRON_OCCURRENCE_MIGRATION);
  return { path, db, inbox, store: createCronOccurrenceStore(db, inbox) };
}

function hourlyUtc(misfire: CronRule["misfire"], catchUpLimit?: number): CronRule {
  return {
    ruleVersionId: "rv_hourly",
    expression: "0 * * * *",
    timezone: "UTC",
    topic: "cron.occurred",
    misfire,
    ...(catchUpLimit !== undefined ? { catchUpLimit } : {}),
  };
}

describe("cron occurrences", () => {
  it("uses measured Europe/Madrid spring gap and fall first-offset; hourly overlap is two UTC", () => {
    const daily: CronRule = {
      ruleVersionId: "rv_daily",
      expression: "0 2 * * *",
      timezone: "Europe/Madrid",
      topic: "cron.occurred",
      misfire: "last",
    };
    const spring = previewOccurrences(daily, { fromUtc: "2026-03-27T00:00:00.000Z", count: 3 });
    expect(spring).toEqual([
      { scheduledAtUtc: "2026-03-27T01:00:00.000Z", timezone: "Europe/Madrid", utcOffsetMinutes: 60, localHour: 2, localMinute: 0 },
      { scheduledAtUtc: "2026-03-28T01:00:00.000Z", timezone: "Europe/Madrid", utcOffsetMinutes: 60, localHour: 2, localMinute: 0 },
      { scheduledAtUtc: "2026-03-29T01:00:00.000Z", timezone: "Europe/Madrid", utcOffsetMinutes: 120, localHour: 3, localMinute: 0 },
    ]);
    const fall = previewOccurrences(daily, { fromUtc: "2026-10-24T12:00:00.000Z", count: 2 });
    expect(fall.map((slot) => [slot.scheduledAtUtc, slot.utcOffsetMinutes, slot.localHour])).toEqual([
      ["2026-10-25T00:00:00.000Z", 120, 2],
      ["2026-10-26T01:00:00.000Z", 60, 2],
    ]);
    const hourly: CronRule = { ...daily, expression: "0 * * * *" };
    const overlap = previewOccurrences(hourly, { fromUtc: "2026-10-24T23:30:00.000Z", count: 3 });
    expect(overlap.map((slot) => [slot.scheduledAtUtc, slot.utcOffsetMinutes, slot.localHour])).toEqual([
      ["2026-10-25T00:00:00.000Z", 120, 2],
      ["2026-10-25T01:00:00.000Z", 60, 2],
      ["2026-10-25T02:00:00.000Z", 60, 3],
    ]);
  });

  it("pages preview by offset and rejects H, non-IANA, and six fields", () => {
    const monday: CronRule = {
      ruleVersionId: "rv_mon",
      expression: "0 10 * * 1",
      timezone: "Europe/Madrid",
      topic: "cron.occurred",
      misfire: "last",
    };
    const first = previewOccurrences(monday, { fromUtc: "2026-09-07T00:00:00.000Z", count: 1 });
    const paged = previewOccurrences(monday, { fromUtc: "2026-09-07T00:00:00.000Z", count: 1, offset: 1 });
    expect(first[0]?.scheduledAtUtc).toBe("2026-09-07T08:00:00.000Z");
    expect(paged[0]?.scheduledAtUtc).toBe("2026-09-14T08:00:00.000Z");
    expect(paged[0]?.utcOffsetMinutes).toBe(120);
    expect(() => previewOccurrences({ ...monday, expression: "H 10 * * 1" }, { fromUtc: "2026-09-07T00:00:00.000Z", count: 1 })).toThrow(
      CronPlannerError,
    );
    expect(() => previewOccurrences({ ...monday, timezone: "UTC+2" }, { fromUtc: "2026-09-07T00:00:00.000Z", count: 1 })).toThrow(
      "cron_timezone_not_iana",
    );
    expect(() => previewOccurrences({ ...monday, expression: "0 0 10 * * 1" }, { fromUtc: "2026-09-07T00:00:00.000Z", count: 1 })).toThrow(
      "cron_expression_invalid",
    );
  });

  it("skip / last / bounded catch-up persist unique rows without a launcher", () => {
    const skipInbox = memoryInbox();
    const skip = openStore(skipInbox);
    expect(skip.store.tick([hourlyUtc("skip")], "2026-09-14T10:00:00.000Z")).toEqual([]);
    const skipped = skip.store.tick([hourlyUtc("skip")], "2026-09-14T13:05:00.000Z");
    expect(skipped.map((item) => [item.scheduledAtUtc, item.state, item.inboxId])).toEqual([
      ["2026-09-14T11:00:00.000Z", "skipped", null],
      ["2026-09-14T12:00:00.000Z", "skipped", null],
      ["2026-09-14T13:00:00.000Z", "skipped", null],
    ]);
    expect(skipInbox.drafts).toHaveLength(0);
    const timelyInbox = memoryInbox();
    const timely = openStore(timelyInbox);
    expect(timely.store.tick([hourlyUtc("skip")], "2026-09-14T10:00:00.000Z")).toEqual([]);
    const onTime = timely.store.tick([hourlyUtc("skip")], "2026-09-14T11:00:00.000Z");
    expect(onTime).toMatchObject([{ scheduledAtUtc: "2026-09-14T11:00:00.000Z", state: "emitted", duplicate: false }]);
    expect(timelyInbox.drafts).toHaveLength(1);

    const lastInbox = memoryInbox();
    const last = openStore(lastInbox);
    last.store.tick([hourlyUtc("last")], "2026-09-14T10:00:00.000Z");
    const lasted = last.store.tick([hourlyUtc("last")], "2026-09-14T13:05:00.000Z");
    expect(lasted.filter((item) => item.state === "emitted").map((item) => item.scheduledAtUtc)).toEqual([
      "2026-09-14T13:00:00.000Z",
    ]);
    expect(lasted.filter((item) => item.state === "skipped")).toHaveLength(2);
    expect(lastInbox.drafts).toHaveLength(1);

    const catchInbox = memoryInbox();
    const catchUp = openStore(catchInbox);
    catchUp.store.tick([hourlyUtc("catch_up", 2)], "2026-09-14T10:00:00.000Z");
    const caught = catchUp.store.tick([hourlyUtc("catch_up", 2)], "2026-09-14T13:05:00.000Z");
    expect(caught.filter((item) => item.state === "emitted").map((item) => item.scheduledAtUtc)).toEqual([
      "2026-09-14T11:00:00.000Z",
      "2026-09-14T12:00:00.000Z",
    ]);
    expect(caught.filter((item) => item.state === "skipped").map((item) => item.scheduledAtUtc)).toEqual([
      "2026-09-14T13:00:00.000Z",
    ]);
    expect(catchInbox.drafts.map((draft) => draft.eventId)).toEqual([
      cronEventId("rv_hourly", "2026-09-14T11:00:00.000Z"),
      cronEventId("rv_hourly", "2026-09-14T12:00:00.000Z"),
    ]);
  });

  it("reopen and a second connection do not emit a second inbox row; timezone change keeps history", () => {
    const inbox = memoryInbox();
    const first = openStore(inbox);
    const madrid: CronRule = {
      ruleVersionId: "rv_tz",
      expression: "0 10 * * 1",
      timezone: "Europe/Madrid",
      topic: "cron.occurred",
      misfire: "last",
    };
    first.store.tick([madrid], "2026-09-06T00:00:00.000Z");
    const emitted = first.store.tick([madrid], "2026-09-07T08:00:00.000Z");
    expect(emitted).toMatchObject([{ scheduledAtUtc: "2026-09-07T08:00:00.000Z", state: "emitted", duplicate: false }]);
    first.db.close();
    const db = new Database(first.path);
    handles.push(db);
    const reopened = createCronOccurrenceStore(db, inbox);
    expect(reopened.tick([madrid], "2026-09-07T09:00:00.000Z")).toEqual([]);
    expect(inbox.drafts).toHaveLength(1);
    const utcRule: CronRule = { ...madrid, timezone: "UTC" };
    const afterTz = reopened.tick([utcRule], "2026-09-07T12:00:00.000Z");
    expect(afterTz).toMatchObject([{ scheduledAtUtc: "2026-09-07T10:00:00.000Z", state: "emitted" }]);
    expect(reopened.readOccurrence("rv_tz", "2026-09-07T08:00:00.000Z")).toMatchObject({ state: "emitted" });
    expect(previewOccurrences(utcRule, { fromUtc: "2026-09-07T10:00:00.000Z", count: 1 })[0]?.scheduledAtUtc).toBe(
      "2026-09-14T10:00:00.000Z",
    );

    const raced = openStore(inbox);
    const rule = hourlyUtc("last");
    raced.store.tick([rule], "2026-09-14T10:00:00.000Z");
    const other = new Database(raced.path);
    handles.push(other);
    const second = createCronOccurrenceStore(other, inbox);
    raced.store.tick([rule], "2026-09-14T11:00:00.000Z");
    const again = second.tick([rule], "2026-09-14T11:00:00.000Z");
    expect(again.every((item) => item.duplicate || item.state === "skipped")).toBe(true);
    expect(inbox.drafts.filter((draft) => draft.ruleVersionId === "rv_hourly")).toHaveLength(1);
  });

  it("walks a 100-hour gap as one misfire window, not a 64-slot prefix", () => {
    const stale = "2026-09-17T02:00:00.000Z";
    const newest = "2026-09-18T14:00:00.000Z";
    const afterGap = "2026-09-18T14:05:00.000Z";
    const lastInbox = memoryInbox();
    const last = openStore(lastInbox);
    last.store.tick([hourlyUtc("last")], "2026-09-14T10:00:00.000Z");
    const lasted = last.store.tick([hourlyUtc("last")], afterGap);
    expect(lasted.filter((item) => item.state === "emitted").map((item) => item.scheduledAtUtc)).toEqual([newest]);
    expect(lasted.some((item) => item.scheduledAtUtc === stale && item.state === "emitted")).toBe(false);
    expect(lasted.filter((item) => item.state === "skipped")).toHaveLength(99);
    expect(last.store.readCursor("rv_hourly")?.last_scheduled_at_utc).toBe(newest);
    expect(last.store.tick([hourlyUtc("last")], "2026-09-18T15:05:00.000Z")).toMatchObject([
      { scheduledAtUtc: "2026-09-18T15:00:00.000Z", state: "emitted" },
    ]);
    expect(lastInbox.drafts.map((draft) => draft.scheduledAtUtc)).toEqual([newest, "2026-09-18T15:00:00.000Z"]);

    const skipInbox = memoryInbox();
    const skip = openStore(skipInbox);
    skip.store.tick([{ ...hourlyUtc("skip"), ruleVersionId: "rv_skip" }], "2026-09-14T10:00:00.000Z");
    const skipped = skip.store.tick([{ ...hourlyUtc("skip"), ruleVersionId: "rv_skip" }], afterGap);
    expect(skipped.every((item) => item.state === "skipped")).toBe(true);
    expect(skipped).toHaveLength(100);
    expect(skipInbox.drafts).toHaveLength(0);
    expect(skip.store.readCursor("rv_skip")?.last_scheduled_at_utc).toBe(newest);
    expect(skip.store.tick([{ ...hourlyUtc("skip"), ruleVersionId: "rv_skip" }], "2026-09-18T15:00:00.000Z")).toMatchObject([
      { scheduledAtUtc: "2026-09-18T15:00:00.000Z", state: "emitted" },
    ]);

    const catchInbox = memoryInbox();
    const catchUp = openStore(catchInbox);
    const catchRule = { ...hourlyUtc("catch_up", 2), ruleVersionId: "rv_catch" };
    catchUp.store.tick([catchRule], "2026-09-14T10:00:00.000Z");
    const caught = catchUp.store.tick([catchRule], afterGap);
    expect(caught.filter((item) => item.state === "emitted").map((item) => item.scheduledAtUtc)).toEqual([
      "2026-09-14T11:00:00.000Z",
      "2026-09-14T12:00:00.000Z",
    ]);
    expect(caught.filter((item) => item.state === "skipped")).toHaveLength(98);
    expect(catchUp.store.readCursor("rv_catch")?.last_scheduled_at_utc).toBe(newest);
    expect(catchUp.store.tick([catchRule], "2026-09-18T15:05:00.000Z")).toMatchObject([
      { scheduledAtUtc: "2026-09-18T15:00:00.000Z", state: "emitted" },
    ]);
    expect(catchInbox.drafts).toHaveLength(3);
  });

  it("refuses a due range past the memory cap and leaves last unchanged", () => {
    const inbox = memoryInbox();
    const opened = openStore(inbox);
    const rule: CronRule = {
      ruleVersionId: "rv_overflow",
      expression: "* * * * *",
      timezone: "UTC",
      topic: "cron.occurred",
      misfire: "last",
    };
    expect(opened.store.tick([rule], "2026-09-14T10:00:00.000Z")).toEqual([]);
    expect(opened.store.readCursor("rv_overflow")?.last_scheduled_at_utc).toBe("2026-09-14T10:00:00.000Z");
    const later = new Date(Date.parse("2026-09-14T10:00:00.000Z") + (CRON_DUE_RANGE_CAP + 1) * 60_000).toISOString();
    expect(() => opened.store.tick([rule], later)).toThrow("cron_due_range_exceeded");
    expect(opened.store.readCursor("rv_overflow")?.last_scheduled_at_utc).toBe("2026-09-14T10:00:00.000Z");
    expect(inbox.drafts).toHaveLength(0);
  });
});
