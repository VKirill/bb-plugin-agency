/**
 * Lead intake → station chain. Size/risk today come from the lead's intake
 * comment; Jev (TypeSafe Choice/Score) can fill the same fields later without
 * changing the chain.
 */

export const INTAKE_SIZES = ["S", "M", "L"] as const;
export const INTAKE_RISKS = ["low", "medium", "high"] as const;
export const INTAKE_DECISIONS = ["accept", "split", "clarify", "return"] as const;

export type IntakeSize = (typeof INTAKE_SIZES)[number];
export type IntakeRisk = (typeof INTAKE_RISKS)[number];
export type IntakeDecision = (typeof INTAKE_DECISIONS)[number];

export type WorkChain = {
  assigneeType: "assistant" | "executor";
  extraReview: boolean;
  reasoningLevel: "low" | "medium" | "high";
  summary: string;
};

/** Tiny UI tweak → cheap assistant. Large or irreversible → executor + review. */
export function resolveWorkChain(size: IntakeSize, risk: IntakeRisk): WorkChain {
  if (size === "S" && risk === "low") {
    return {
      assigneeType: "assistant",
      extraReview: false,
      reasoningLevel: "low",
      summary: "Tiny change: assistant, low reasoning, no extra review.",
    };
  }
  if (size === "L" || risk === "high") {
    return {
      assigneeType: "executor",
      extraReview: true,
      reasoningLevel: "high",
      summary: "Large or high-risk: executor plus independent review.",
    };
  }
  return {
    assigneeType: "executor",
    extraReview: size !== "S",
    reasoningLevel: "medium",
    summary: "Normal work: executor; extra review unless the job is still small.",
  };
}
