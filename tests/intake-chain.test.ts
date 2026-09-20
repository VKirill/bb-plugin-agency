import { describe, expect, it } from "vitest";
import { resolveWorkChain } from "../src/server/runtime/intake";

describe("lead work chain from intake size and risk", () => {
  it("sends a tiny low-risk change to an assistant without extra review", () => {
    expect(resolveWorkChain("S", "low")).toEqual({
      assigneeType: "assistant",
      extraReview: false,
      reasoningLevel: "low",
      summary: "Tiny change: assistant, low reasoning, no extra review.",
    });
  });

  it("sends a large or high-risk job to an executor with independent review", () => {
    expect(resolveWorkChain("L", "medium").assigneeType).toBe("executor");
    expect(resolveWorkChain("L", "medium").extraReview).toBe(true);
    expect(resolveWorkChain("L", "medium").reasoningLevel).toBe("high");
    expect(resolveWorkChain("S", "high").extraReview).toBe(true);
    expect(resolveWorkChain("M", "high").reasoningLevel).toBe("high");
  });

  it("keeps a normal job on an executor and adds review once it is no longer small", () => {
    expect(resolveWorkChain("S", "medium")).toMatchObject({
      assigneeType: "executor",
      extraReview: false,
      reasoningLevel: "medium",
    });
    expect(resolveWorkChain("M", "low")).toMatchObject({
      assigneeType: "executor",
      extraReview: true,
      reasoningLevel: "medium",
    });
  });
});
