import { describe, expect, it } from "vitest";
import { HUMAN_BLOCKING_STATES, OVERDUE_AFTER_MS, jobAttention, relativeAge } from "../src/app/data/job-attention";

const now = Date.parse("2026-09-14T18:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

describe("relative age", () => {
  it("counts in the largest unit that still reads at a glance", () => {
    expect(relativeAge(ago(30 * 1000), now)).toBe("только что");
    expect(relativeAge(ago(12 * 60 * 1000), now)).toBe("12 мин");
    expect(relativeAge(ago(3 * 60 * 60 * 1000), now)).toBe("3 ч");
    expect(relativeAge(ago(5 * 24 * 60 * 60 * 1000), now)).toBe("5 дн");
    expect(relativeAge(ago(21 * 24 * 60 * 60 * 1000), now)).toBe("3 нед");
  });

  it("says nothing when there is no usable timestamp", () => {
    expect(relativeAge(undefined, now)).toBeNull();
    expect(relativeAge("", now)).toBeNull();
    expect(relativeAge("не дата", now)).toBeNull();
  });

  it("refuses to report an age from the future", () => {
    expect(relativeAge(new Date(now + 60_000).toISOString(), now)).toBeNull();
  });
});

describe("job attention", () => {
  it("marks every state where the agency waits on a person", () => {
    for (const state of HUMAN_BLOCKING_STATES) {
      expect(jobAttention({ state, updatedAt: ago(60 * 60 * 1000) }, now).tone).toBe("waiting");
    }
  });

  it("escalates a decision the person has been holding for a day", () => {
    expect(jobAttention({ state: "review", updatedAt: ago(OVERDUE_AFTER_MS) }, now).tone).toBe("overdue");
    expect(jobAttention({ state: "review", updatedAt: ago(OVERDUE_AFTER_MS - 1000) }, now).tone).toBe("waiting");
  });

  it("keeps agency-side work quiet but still timed", () => {
    const running = jobAttention({ state: "running", updatedAt: ago(6 * 60 * 60 * 1000) }, now);
    expect(running.tone).toBe("quiet");
    expect(running.age).toBe("6 ч");
    expect(jobAttention({ state: "queued", updatedAt: ago(1000 * 60) }, now).tone).toBe("quiet");
    expect(jobAttention({ state: "backlog", updatedAt: ago(1000 * 60) }, now).tone).toBe("quiet");
  });

  it("shows nothing for finished and cancelled jobs", () => {
    for (const state of ["done", "canceled"] as const) {
      const view = jobAttention({ state, updatedAt: ago(60 * 60 * 1000) }, now);
      expect(view.tone).toBe("none");
      expect(view.age).toBeNull();
    }
  });

  it("explains the wait in words, not just colour", () => {
    expect(jobAttention({ state: "review", updatedAt: ago(2 * 60 * 60 * 1000) }, now).hint)
      .toBe("Ждёт вашего решения. Без изменений 2 ч");
    expect(jobAttention({ state: "waiting_input", updatedAt: ago(2 * 60 * 60 * 1000) }, now).hint)
      .toContain("Ждёт вашего ответа");
    expect(jobAttention({ state: "blocked" }, now).hint).toBe("Ждёт уточнения вводных");
  });

  it("never claims an age the job does not carry", () => {
    const view = jobAttention({ state: "review" }, now);
    expect(view.age).toBeNull();
    expect(view.tone).toBe("waiting");
  });
});
