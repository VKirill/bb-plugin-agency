import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_PRICES,
  estimateCostUsdCents,
  normalizeModelId,
  parseModelPriceOverrides,
  priceForModel,
} from "../src/server/runtime/dashboard-usage/pricing";
import { costForRows, costHeadline, formatCostUsd } from "../src/app/data/usage-dashboard";
import { intakeLabel, latestIntake } from "../src/app/data/intake";
import { createJobCommentRpcSchema, intakeReferencesComplete } from "../src/shared/contracts";

const units = { inputTokens: 1_000, cachedInputTokens: 2_000_000, outputTokens: 40_000, reasoningOutputTokens: 0, totalTokens: 2_041_000 };

describe("cost estimate", () => {
  it("prices claude models by their base id", () => {
    expect(normalizeModelId("claude-opus-5[1m]")).toBe("claude-opus-5");
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(priceForModel("claude-opus-5[1m]", DEFAULT_MODEL_PRICES)).toEqual({ input: 5, cachedInput: 0.5, output: 25 });
    expect(priceForModel("claude-opus-4-9", DEFAULT_MODEL_PRICES)).toBeNull();
    expect(priceForModel("gpt-5.6-sol", DEFAULT_MODEL_PRICES)).toBeNull();
    // 1k × $5 + 2M × $0.5 + 40k × $25 per MTok = $0.005 + $1 + $1 = $2.005
    expect(estimateCostUsdCents(units, DEFAULT_MODEL_PRICES["claude-opus-5"]!)).toBe(200.5);
  });

  it("merges price overrides from settings and ignores broken JSON", () => {
    const merged = parseModelPriceOverrides('{"GPT-5.6-sol": {"input": 1.25, "cachedInput": 0.125, "output": 10}}');
    expect(merged.error).toBeNull();
    expect(priceForModel("gpt-5.6-sol", merged.table)).toEqual({ input: 1.25, cachedInput: 0.125, output: 10 });
    expect(priceForModel("claude-sonnet-5", merged.table)).toEqual({ input: 2, cachedInput: 0.2, output: 10 });
    const broken = parseModelPriceOverrides("{nope");
    expect(broken.error).not.toBeNull();
    expect(broken.table).toBe(DEFAULT_MODEL_PRICES);
  });

  it("formats and sums visible rows once per thread", () => {
    expect(formatCostUsd(200.5)).toBe("≈ $2.01");
    expect(formatCostUsd(0.4)).toBe("≈ <$0.01");
    expect(formatCostUsd(null)).toBeNull();
    const row = (threadId: string, costUsdCents: number | null) =>
      ({ threadId, attemptId: `a-${threadId}-${costUsdCents}`, unknown: false, costUsdCents }) as never;
    expect(costForRows([row("t1", 100), row("t1", 100), row("t2", 50)])).toEqual({ cents: 150, partial: false });
    const partial = costForRows([row("t1", 100), row("t3", null)]);
    expect(partial).toEqual({ cents: 100, partial: true });
    expect(costHeadline(partial)).toBe("≈ $1.00, не все модели с ценой");
    expect(costHeadline({ cents: null, partial: false })).toBe("Нет цены");
  });
});

describe("intake assessment", () => {
  const base = { requestId: "7a3f0c52-8d1e-4d8e-9a55-0f4a3a6b1c11", jobId: "job_aaaaaaaaaaaa", comment: "Оценка на входе." };

  it("accepts only known intake values", () => {
    expect(
      createJobCommentRpcSchema.safeParse({
        ...base,
        references: [
          { type: "intake_size", id: "M" },
          { type: "intake_risk", id: "medium" },
          { type: "intake_decision", id: "split" },
        ],
      }).success,
    ).toBe(true);
    expect(
      createJobCommentRpcSchema.safeParse({ ...base, references: [{ type: "intake_size", id: "XL" }] }).success,
    ).toBe(false);
  });

  it("requires size, risk and decision together", () => {
    expect(intakeReferencesComplete([{ type: "artifact" }])).toBe(true);
    expect(intakeReferencesComplete([{ type: "intake_size" }, { type: "intake_risk" }])).toBe(false);
    expect(
      intakeReferencesComplete([{ type: "intake_size" }, { type: "intake_risk" }, { type: "intake_decision" }, { type: "intake_risk" }]),
    ).toBe(false);
  });

  it("reads the latest assessment from job history", () => {
    const intake = latestIntake([
      { id: "1", kind: "comment", text: "old", at: "2026-09-16T10:00:00Z", references: [{ type: "intake_size", id: "S" }, { type: "intake_risk", id: "low" }, { type: "intake_decision", id: "accept" }] },
      { id: "2", kind: "comment", text: "plain", at: "2026-09-16T10:01:00Z" },
      { id: "3", kind: "comment", text: "new", author: "Руководитель", at: "2026-09-16T10:02:00Z", references: [{ type: "intake_size", id: "L" }, { type: "intake_risk", id: "high" }, { type: "intake_decision", id: "split" }] },
    ]);
    expect(intake).toMatchObject({ size: "L", risk: "high", decision: "split", author: "Руководитель" });
    expect(intakeLabel(intake!)).toBe("размер L · риск высокий · разбить на подзадачи");
    expect(latestIntake([])).toBeNull();
  });
});
