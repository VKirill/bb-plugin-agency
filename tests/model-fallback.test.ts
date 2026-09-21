import { describe, expect, it } from "vitest";
import { catalogReserves, mergedReserves, modelChoiceNote, modelFamily, resolveModelChoice, type CatalogModel } from "../src/server/runtime/model-fallback";

const claude: CatalogModel[] = [
  { providerId: "claude-code", model: "claude-opus-5", isDefault: true },
  { providerId: "claude-code", model: "claude-sonnet-5", isDefault: false },
  { providerId: "claude-code", model: "claude-haiku-4-5", isDefault: false },
];
const mixed: CatalogModel[] = [
  ...claude,
  { providerId: "codex", model: "gpt-5.6-sol", isDefault: true },
  { providerId: "codex", model: "gpt-5.6-luna", isDefault: false },
  { providerId: "acp-cursor", model: "grok-4.6", isDefault: true },
];

describe("model fallback", () => {
  it("keeps the model when the machine has it", () => {
    expect(resolveModelChoice({ providerId: "codex", model: "gpt-5.6-sol" }, mixed)).toEqual({
      status: "exact",
      providerId: "codex",
      model: "gpt-5.6-sol",
    });
  });

  it("treats a context-window variant as the same model", () => {
    expect(resolveModelChoice({ providerId: "claude-code", model: "claude-opus-5[1m]" }, claude)).toMatchObject({
      status: "substituted",
      model: "claude-opus-5",
      reason: "base_id",
    });
  });

  it("finds the same model under another CLI", () => {
    const choice = resolveModelChoice({ providerId: "acp-opencode", model: "gpt-5.6-sol" }, mixed);
    expect(choice).toMatchObject({ status: "substituted", providerId: "codex", model: "gpt-5.6-sol", reason: "cross_provider" });
  });

  it("swaps an absent model for one of the same class, Claude first", () => {
    // Grok is not connected here: a balanced model is what the coder gets.
    const choice = resolveModelChoice({ providerId: "acp-cursor", model: "grok-4.6" }, claude);
    expect(choice).toMatchObject({ status: "substituted", model: "claude-sonnet-5", reason: "same_class" });
    // A light model stays light instead of jumping to the strongest one.
    expect(resolveModelChoice({ providerId: "codex", model: "gpt-5.6-luna" }, claude)).toMatchObject({
      model: "claude-haiku-4-5",
      reason: "same_class",
    });
    // A strong model stays strong.
    expect(resolveModelChoice({ providerId: "codex", model: "gpt-5.6-sol" }, claude)).toMatchObject({
      model: "claude-opus-5",
      reason: "same_class",
    });
  });

  it("falls back to the CLI default for a model it does not know", () => {
    expect(resolveModelChoice({ providerId: "claude-code", model: "some-private-llm" }, claude)).toMatchObject({
      status: "substituted",
      model: "claude-opus-5",
      reason: "provider_default",
    });
  });

  it("says «no model» instead of inventing one", () => {
    expect(resolveModelChoice({ providerId: "claude-code", model: "claude-opus-5" }, [])).toEqual({
      status: "missing",
      wanted: { providerId: "claude-code", model: "claude-opus-5" },
    });
    expect(resolveModelChoice({ providerId: "claude-code", model: "" }, claude)).toMatchObject({ status: "missing" });
  });

  it("classifies the models of the usual vendors", () => {
    expect(modelFamily("claude-fable-5-1")).toEqual({ family: "claude", klass: "strong" });
    expect(modelFamily("gpt-5.6-luna")).toEqual({ family: "gpt", klass: "light" });
    expect(modelFamily("grok-4.6")).toEqual({ family: "grok", klass: "balanced" });
    expect(modelFamily("совсем-своя-модель")).toBeNull();
  });

  it("writes what happened in both languages", () => {
    const choice = resolveModelChoice({ providerId: "acp-cursor", model: "grok-4.6" }, claude);
    expect(modelChoiceNote(choice, false)).toContain("вместо неё");
    expect(modelChoiceNote(choice, true)).toContain("is used instead");
    expect(modelChoiceNote({ status: "exact", providerId: "claude-code", model: "claude-opus-5" }, false)).toBeNull();
    expect(modelChoiceNote({ status: "missing", wanted: { providerId: "x", model: "y" } }, false)).toContain("замены не нашлось");
  });

  it("fills Claude → GPT → Grok reserves of the same class and skips missing families", () => {
    const grokWriter = catalogReserves({ providerId: "acp-cursor", model: "grok-4.6" }, mixed);
    expect(grokWriter.map((row) => row.model)).toEqual(["claude-sonnet-5", "gpt-5.6-sol"]);

    expect(catalogReserves({ providerId: "acp-cursor", model: "grok-4.6" }, claude)).toEqual([]);
    expect(catalogReserves({ providerId: "claude-code", model: "claude-sonnet-5" }, claude)).toEqual([]);

    const claudeAndGpt: CatalogModel[] = [
      ...claude,
      { providerId: "codex", model: "gpt-5.6-sol", isDefault: true },
      { providerId: "codex", model: "gpt-5.6-luna", isDefault: false },
    ];
    // Grok is not connected: the writer is installed on Sonnet, so the reserve is GPT, not another Claude.
    expect(catalogReserves({ providerId: "acp-cursor", model: "grok-4.6" }, claudeAndGpt).map((row) => `${row.providerId}:${row.model}`)).toEqual([
      "codex:gpt-5.6-sol",
    ]);
  });

  it("keeps owner-set reserves that still exist and fills an empty list", () => {
    const owned = mergedReserves(
      { providerId: "claude-code", model: "claude-sonnet-5" },
      [{ providerId: "codex", model: "gpt-5.6-sol", reasoningEffort: "high" }],
      mixed,
    );
    expect(owned).toEqual([{ providerId: "codex", model: "gpt-5.6-sol", reasoningEffort: "high" }]);
    expect(mergedReserves({ providerId: "claude-code", model: "claude-sonnet-5" }, [], mixed).map((row) => row.model)).toEqual([
      "gpt-5.6-sol",
      "grok-4.6",
    ]);
  });
});
