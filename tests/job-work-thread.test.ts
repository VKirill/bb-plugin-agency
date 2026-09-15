import { describe, expect, it } from "vitest";
import { canOpenNativeThread, scopedAttemptThreadId } from "../src/app/data/job-work-thread";

describe("scopedAttemptThreadId", () => {
  it("keeps exact attempt thread when receipt matches or is absent", () => {
    expect(scopedAttemptThreadId({
      attempt: { threadId: "thr_run_exact01" },
      receipt: { threadId: "thr_run_exact01" },
    })).toBe("thr_run_exact01");
    expect(scopedAttemptThreadId({
      attempt: { threadId: "thr_run_exact01" },
      receipt: null,
    })).toBe("thr_run_exact01");
    expect(scopedAttemptThreadId({
      attempt: { threadId: null },
      receipt: { threadId: "thr_from_launch" },
    })).toBe("thr_from_launch");
  });

  it("does not mount when thread is missing", () => {
    expect(scopedAttemptThreadId(null)).toBeNull();
    expect(scopedAttemptThreadId({ attempt: { threadId: null }, receipt: { threadId: null } })).toBeNull();
    expect(scopedAttemptThreadId({ attempt: { threadId: "  " }, receipt: null })).toBeNull();
  });

  it("switches with the scoped attempt", () => {
    const first = scopedAttemptThreadId({ attempt: { threadId: "thr_attempt_one" } });
    const second = scopedAttemptThreadId({ attempt: { threadId: "thr_attempt_two" } });
    expect(first).toBe("thr_attempt_one");
    expect(second).toBe("thr_attempt_two");
    expect(first).not.toBe(second);
  });

  it("fails closed when attempt and receipt threadIds differ", () => {
    expect(scopedAttemptThreadId({
      attempt: { threadId: "thr_attempt_aaa" },
      receipt: { threadId: "thr_receipt_bbb" },
    })).toBeNull();
  });

  it("does not treat an agent id as a thread", () => {
    expect(scopedAttemptThreadId({
      attempt: { threadId: null },
      receipt: { threadId: null },
    })).toBeNull();
  });
});

describe("canOpenNativeThread", () => {
  it("requires navigate.toThread", () => {
    expect(canOpenNativeThread({})).toBe(false);
    expect(canOpenNativeThread({ toThread: () => undefined })).toBe(true);
  });
});
