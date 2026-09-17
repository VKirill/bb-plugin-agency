import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_PRICES,
  modelPriceOverridesJson,
  modelPriceRows,
  parseModelPriceOverrides,
} from "../src/server/runtime/dashboard-usage/pricing";
import {
  draftIssues,
  draftsFromRows,
  modelsToPrice,
  parsePriceValue,
  pricesDirty,
  rowsFromDrafts,
  sortDrafts,
} from "../src/app/data/model-prices";
import type { ModelPricesView } from "../src/shared/rpc-contract";

describe("price table on the server", () => {
  it("marks the owner's rows and leaves the built-in ones alone", () => {
    const table = parseModelPriceOverrides('{"grok-4.6": {"input": 3, "cachedInput": 0.3, "output": 15}}').table;
    const rows = modelPriceRows(table);
    const grok = rows.find((row) => row.model === "grok-4.6");
    const sonnet = rows.find((row) => row.model === "claude-sonnet-5");
    expect(grok).toMatchObject({ input: 3, cachedInput: 0.3, output: 15, custom: true });
    expect(sonnet?.custom).toBe(false);
  });

  it("stores only what differs from the built-in prices", () => {
    const rows = [
      { model: "claude-sonnet-5", ...DEFAULT_MODEL_PRICES["claude-sonnet-5"]! },
      { model: "claude-opus-5[1m]", input: 7, cachedInput: 0.7, output: 35 },
      { model: "grok-4.6", input: 3, cachedInput: 0.3, output: 15 },
    ];
    const json = JSON.parse(modelPriceOverridesJson(rows));
    // The untouched built-in row is not frozen into the settings.
    expect(json["claude-sonnet-5"]).toBeUndefined();
    // A changed built-in row is stored under its base id.
    expect(json["claude-opus-5"]).toEqual({ input: 7, cachedInput: 0.7, output: 35 });
    expect(json["grok-4.6"]).toEqual({ input: 3, cachedInput: 0.3, output: 15 });
  });

  it("writes an empty value when nothing differs, so built-in updates still reach the owner", () => {
    expect(modelPriceOverridesJson([{ model: "claude-haiku-4-5", ...DEFAULT_MODEL_PRICES["claude-haiku-4-5"]! }])).toBe("");
  });

  it("round-trips through the settings field", () => {
    const saved = modelPriceOverridesJson([{ model: "gpt-5.6-sol", input: 1.25, cachedInput: 0.125, output: 10 }]);
    const table = parseModelPriceOverrides(saved).table;
    expect(table["gpt-5.6-sol"]).toEqual({ input: 1.25, cachedInput: 0.125, output: 10 });
  });
});

describe("price table in the app", () => {
  const view: ModelPricesView = {
    rows: [
      { model: "claude-sonnet-5", input: 2, cachedInput: 0.2, output: 10, custom: false },
      { model: "grok-4.6", input: 3, cachedInput: 0.3, output: 15, custom: true },
    ],
    usedModels: ["grok-4.6", "gpt-5.6-luna", "claude-sonnet-5"],
    checkedAt: "2026-09-16",
    source: "https://example.test/pricing",
    error: null,
  };

  it("reads prices written either way", () => {
    expect(parsePriceValue("1,25")).toBe(1.25);
    expect(parsePriceValue(" 1.25 ")).toBe(1.25);
    expect(parsePriceValue("")).toBe(0);
    expect(parsePriceValue("-1")).toBeNull();
    expect(parsePriceValue("много")).toBeNull();
  });

  it("names the models employees run that have no price", () => {
    expect(modelsToPrice(view, draftsFromRows(view.rows))).toEqual(["gpt-5.6-luna"]);
  });

  it("puts the models in use first", () => {
    const sorted = sortDrafts(draftsFromRows(view.rows), ["grok-4.6"]);
    expect(sorted.map((draft) => draft.model)).toEqual(["grok-4.6", "claude-sonnet-5"]);
  });

  it("refuses a duplicate, an empty name and a price that is not a number", () => {
    const drafts = draftsFromRows(view.rows);
    expect(draftIssues(drafts)).toEqual([]);
    expect(draftIssues([...drafts, { model: "GROK-4.6", input: "1", cachedInput: "0", output: "2", custom: true }])).toHaveLength(1);
    expect(draftIssues([{ model: "  ", input: "1", cachedInput: "0", output: "2", custom: true }])).toHaveLength(1);
    expect(draftIssues([{ model: "x", input: "нет", cachedInput: "0", output: "2", custom: true }])).toHaveLength(1);
    expect(rowsFromDrafts([{ model: "x", input: "нет", cachedInput: "0", output: "2", custom: true }])).toBeNull();
  });

  it("sees a changed price as unsaved work", () => {
    const drafts = draftsFromRows(view.rows);
    expect(pricesDirty(drafts, view.rows)).toBe(false);
    expect(pricesDirty(drafts.map((draft, index) => (index ? draft : { ...draft, input: "4" })), view.rows)).toBe(true);
    expect(pricesDirty(drafts.slice(1), view.rows)).toBe(true);
    // The same number written differently is not a change.
    expect(pricesDirty(drafts.map((draft, index) => (index ? draft : { ...draft, input: "2,0" })), view.rows)).toBe(false);
  });

  it("saves normalized ids", () => {
    const rows = rowsFromDrafts([{ model: " GPT-5.6-Sol ", input: "1,25", cachedInput: "", output: "10", custom: true }]);
    expect(rows).toEqual([{ model: "gpt-5.6-sol", input: 1.25, cachedInput: 0, output: 10 }]);
  });
});
