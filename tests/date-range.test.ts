import { describe, expect, it } from "vitest";
import {
  formatRange,
  inRange,
  monthGrid,
  monthOf,
  pickDay,
  sameMonth,
  shiftMonth,
} from "../src/app/data/date-range";

describe("one calendar for both ends", () => {
  it("opens a range, closes it, then starts over", () => {
    const empty = { fromDate: "", toDate: "" };
    const started = pickDay(empty, "2026-09-10");
    expect(started).toEqual({ fromDate: "2026-09-10", toDate: "" });
    expect(pickDay(started, "2026-09-17")).toEqual({ fromDate: "2026-09-10", toDate: "2026-09-17" });
    // A finished range: the next click is a new start, not an edit of the old end.
    expect(pickDay({ fromDate: "2026-09-10", toDate: "2026-09-17" }, "2026-09-01")).toEqual({ fromDate: "2026-09-01", toDate: "" });
  });

  it("accepts the ends in either order", () => {
    expect(pickDay({ fromDate: "2026-09-17", toDate: "" }, "2026-09-10")).toEqual({ fromDate: "2026-09-10", toDate: "2026-09-17" });
  });

  it("says what is inside the range", () => {
    const range = { fromDate: "2026-09-10", toDate: "2026-09-17" };
    expect(inRange("2026-09-11", range)).toBe(true);
    expect(inRange("2026-09-18", range)).toBe(false);
    // A half-chosen range highlights nothing yet.
    expect(inRange("2026-09-11", { fromDate: "2026-09-10", toDate: "" })).toBe(false);
  });

  it("builds Monday-first weeks with the days that fill the grid", () => {
    const weeks = monthGrid(2026, 8); // September 2026
    expect(weeks[0]).toHaveLength(7);
    expect(weeks[0]![0]).toBe("2026-08-31");
    expect(weeks.flat()).toContain("2026-09-30");
    expect(sameMonth("2026-08-31", { year: 2026, month: 8 })).toBe(false);
    expect(sameMonth("2026-09-01", { year: 2026, month: 8 })).toBe(true);
  });

  it("walks months across a year end", () => {
    expect(shiftMonth({ year: 2026, month: 11 }, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 });
    expect(monthOf("2026-09-17")).toEqual({ year: 2026, month: 8 });
    expect(monthOf("", new Date("2026-03-04T00:00:00Z"))).toEqual({ year: 2026, month: 2 });
  });

  it("writes the range the way the trigger shows it", () => {
    expect(formatRange({ fromDate: "", toDate: "" }, "Весь период")).toBe("Весь период");
    expect(formatRange({ fromDate: "2026-09-10", toDate: "" }, "Весь период")).toMatch(/— …$/);
    expect(formatRange({ fromDate: "2026-09-10", toDate: "2026-09-17" }, "Весь период")).toMatch(/ — /);
  });
});
