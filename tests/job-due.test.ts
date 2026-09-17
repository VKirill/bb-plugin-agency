import { describe, expect, it } from "vitest";
import { dueStatus } from "../src/app/data/job-due";
import { dueAtFromDate, dueDate } from "../src/app/data/view-models";

const now = Date.parse("2026-09-17T12:00:00.000Z");

describe("due status on the board", () => {
  it("reads overdue, due soon inside the department window, or just set", () => {
    expect(dueStatus({ state: "running", dueAt: "2026-09-15T12:00:00.000Z" }, now)).toMatchObject({ tone: "overdue", label: "просрочена 2 дн" });
    expect(dueStatus({ state: "running", dueAt: "2026-09-17T07:00:00.000Z" }, now)).toMatchObject({ tone: "overdue", label: "просрочена 5 ч" });
    expect(dueStatus({ state: "queued", dueAt: "2026-09-17T18:00:00.000Z", dueWindowHours: 24 }, now)).toMatchObject({ tone: "soon", label: "срок через 6 ч" });
    expect(dueStatus({ state: "queued", dueAt: "2026-09-17T18:00:00.000Z", dueWindowHours: 2 }, now)).toMatchObject({ tone: "set", label: expect.stringMatching(/^до 17 сен/) });
    expect(dueStatus({ state: "queued", dueAt: "2026-09-17T18:00:00.000Z", dueWindowHours: 0 }, now)?.tone).toBe("set");
    expect(dueStatus({ state: "done", dueAt: "2026-09-15T12:00:00.000Z" }, now)).toBe(null);
    expect(dueStatus({ state: "backlog", dueAt: null }, now)).toBe(null);
  });

  it("keeps a picked day as the same local day and makes it due at its end", () => {
    const instant = dueAtFromDate("2026-09-20")!;
    expect(dueDate(instant)).toBe("2026-09-20");
    expect(new Date(instant).getHours()).toBe(23);
    expect(dueAtFromDate("20.09.2026")).toBe(null);
  });
});
