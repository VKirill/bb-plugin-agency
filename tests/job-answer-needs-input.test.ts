import { describe, expect, it } from "vitest";
import { ANSWER_UNKNOWN_NOTICE, answerSendIsActive, shouldClearNeedsInputAfterAnswer } from "../src/app/data/needs-input";

describe("answerNeedsInput UI hold (pre-freeze)", () => {
  it("treats unknown as reconcile-only and queued as not active", () => {
    expect(ANSWER_UNKNOWN_NOTICE).toMatch(/сверк/i);
    expect(ANSWER_UNKNOWN_NOTICE).not.toMatch(/Повторите ту же команду/);
    expect(answerSendIsActive("unknown")).toBe(false);
    expect(answerSendIsActive("needs_reconciliation")).toBe(false);
    expect(answerSendIsActive("queued")).toBe(false);
    expect(answerSendIsActive("queued", true)).toBe(false);
    expect(answerSendIsActive("pending")).toBe(true);
    expect(answerSendIsActive("pending", false)).toBe(false);
    expect(shouldClearNeedsInputAfterAnswer("unknown")).toBe(false);
    expect(shouldClearNeedsInputAfterAnswer("queued")).toBe(false);
    expect(shouldClearNeedsInputAfterAnswer("confirmed")).toBe(true);
  });
});
