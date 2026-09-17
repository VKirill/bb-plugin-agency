import { z } from "zod";
import type { TokenUsageTotals } from "../../../shared/contracts/dashboard-usage.js";
import { normalizeModelId } from "../../../shared/model-id.js";

/**
 * Cost is an estimate at API list prices, USD per million tokens. A subscription
 * run costs nothing extra, so read it as "what this work would cost on the API".
 * Usage events carry uncached input, cache reads and output; cache writes are
 * not reported separately, so the estimate is a floor.
 */
export const MODEL_PRICES_CHECKED_AT = "2026-09-16";
export const MODEL_PRICES_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";

export const modelPriceSchema = z
  .object({
    input: z.number().nonnegative(),
    cachedInput: z.number().nonnegative(),
    output: z.number().nonnegative(),
  })
  .strict();

export type ModelPrice = z.infer<typeof modelPriceSchema>;
export type ModelPriceTable = Readonly<Record<string, ModelPrice>>;

const price = (input: number, cachedInput: number, output: number): ModelPrice => ({ input, cachedInput, output });

export const DEFAULT_MODEL_PRICES: ModelPriceTable = {
  "claude-fable-5-1": price(10, 0.25, 50),
  "claude-mythos-5-1": price(10, 0.25, 50),
  "claude-fable-5": price(10, 1, 50),
  "claude-mythos-5": price(10, 1, 50),
  "claude-opus-5": price(5, 0.5, 25),
  "claude-opus-4-8": price(5, 0.5, 25),
  "claude-opus-4-7": price(5, 0.5, 25),
  "claude-opus-4-6": price(5, 0.5, 25),
  "claude-opus-4-5": price(5, 0.5, 25),
  "claude-opus-4-1": price(15, 1.5, 75),
  "claude-sonnet-5": price(2, 0.2, 10),
  "claude-sonnet-4-6": price(3, 0.3, 15),
  "claude-sonnet-4-5": price(3, 0.3, 15),
  "claude-haiku-4-5": price(1, 0.1, 5),
};

export { normalizeModelId };

/** Settings JSON adds or overrides prices: `{"model-id": {"input": 1, "cachedInput": 0.1, "output": 5}}`. */
export function parseModelPriceOverrides(json: string | undefined): { table: ModelPriceTable; error: string | null } {
  const text = json?.trim();
  if (!text) return { table: DEFAULT_MODEL_PRICES, error: null };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { table: DEFAULT_MODEL_PRICES, error: "model prices JSON is not parseable" };
  }
  const parsed = z.record(z.string().min(1), modelPriceSchema).safeParse(raw);
  if (!parsed.success) return { table: DEFAULT_MODEL_PRICES, error: parsed.error.message };
  const overrides = Object.fromEntries(
    Object.entries(parsed.data).map(([model, value]) => [normalizeModelId(model), value]),
  );
  return { table: { ...DEFAULT_MODEL_PRICES, ...overrides }, error: null };
}

export function priceForModel(model: string | null, table: ModelPriceTable): ModelPrice | null {
  if (!model) return null;
  return table[normalizeModelId(model)] ?? null;
}

/** Cents, rounded to a hundredth of a cent. */
export function estimateCostUsdCents(units: TokenUsageTotals, modelPrice: ModelPrice): number {
  const usd =
    (units.inputTokens * modelPrice.input +
      units.cachedInputTokens * modelPrice.cachedInput +
      units.outputTokens * modelPrice.output) /
    1_000_000;
  return Math.round(usd * 100 * 100) / 100;
}

export type ModelPriceRow = ModelPrice & {
  model: string;
  /** The owner set this price: it is not a built-in one, or it differs from it. */
  custom: boolean;
};

function samePrice(left: ModelPrice, right: ModelPrice): boolean {
  return left.input === right.input && left.cachedInput === right.cachedInput && left.output === right.output;
}

/** The whole table as rows for the settings screen: built-in prices with the owner's changes on top. */
export function modelPriceRows(table: ModelPriceTable): ModelPriceRow[] {
  return Object.entries(table)
    .map(([model, value]) => {
      const builtin = DEFAULT_MODEL_PRICES[model];
      return { model, ...value, custom: !builtin || !samePrice(builtin, value) };
    })
    .sort((left, right) => left.model.localeCompare(right.model));
}

/**
 * What the settings field stores: only what differs from the built-in prices, so a later
 * correction of a built-in price still reaches an owner who never touched that row.
 */
export function modelPriceOverridesJson(rows: readonly (ModelPrice & { model: string })[]): string {
  const overrides: Record<string, ModelPrice> = {};
  for (const row of rows) {
    const model = normalizeModelId(row.model);
    if (!model) continue;
    const value = { input: row.input, cachedInput: row.cachedInput, output: row.output };
    const builtin = DEFAULT_MODEL_PRICES[model];
    if (builtin && samePrice(builtin, value)) continue;
    overrides[model] = value;
  }
  return Object.keys(overrides).length ? JSON.stringify(overrides, null, 2) : "";
}
