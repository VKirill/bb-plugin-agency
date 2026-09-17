import type { ModelPriceRowView, ModelPricesView } from "../../shared/rpc-contract";
import { normalizeModelId } from "../../shared/model-id";
import { tr } from "../i18n";

/**
 * The price table as the settings screen edits it: text in the inputs, numbers on save.
 * Prices are USD per million tokens; the dashboard turns tokens into money with them.
 */

export type PriceDraft = {
  model: string;
  input: string;
  cachedInput: string;
  output: string;
  /** The owner's own row: it can be removed, a built-in one can only be changed back. */
  custom: boolean;
};

export type PriceIssue = { model: string; text: string };

function toText(value: number): string {
  return String(value);
}

export function draftsFromRows(rows: readonly ModelPriceRowView[]): PriceDraft[] {
  return rows.map((row) => ({
    model: row.model,
    input: toText(row.input),
    cachedInput: toText(row.cachedInput),
    output: toText(row.output),
    custom: row.custom,
  }));
}

/** "1,25" and "1.25" are the same price; an empty field is zero, not an error. */
export function parsePriceValue(text: string): number | null {
  const cleaned = text.trim().replace(",", ".");
  if (!cleaned) return 0;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0 || value > 100_000) return null;
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function draftIssues(drafts: readonly PriceDraft[]): PriceIssue[] {
  const issues: PriceIssue[] = [];
  const seen = new Set<string>();
  for (const draft of drafts) {
    const model = normalizeModelId(draft.model);
    if (!model) {
      issues.push({ model: draft.model, text: tr("Укажите название модели.") });
      continue;
    }
    if (seen.has(model)) issues.push({ model, text: tr("Модель уже есть в таблице.") });
    seen.add(model);
    for (const field of ["input", "cachedInput", "output"] as const) {
      if (parsePriceValue(draft[field]) === null) {
        issues.push({ model, text: tr("Цена должна быть числом от 0.") });
        break;
      }
    }
  }
  return issues;
}

/** Rows for the save call; null when a draft is not ready, so the caller shows the issues instead. */
export function rowsFromDrafts(drafts: readonly PriceDraft[]): { model: string; input: number; cachedInput: number; output: number }[] | null {
  if (draftIssues(drafts).length) return null;
  return drafts.map((draft) => ({
    model: normalizeModelId(draft.model),
    input: parsePriceValue(draft.input) ?? 0,
    cachedInput: parsePriceValue(draft.cachedInput) ?? 0,
    output: parsePriceValue(draft.output) ?? 0,
  }));
}

/** Models the employees run that the table has no price for: one click adds a row for each. */
export function modelsToPrice(view: ModelPricesView | null, drafts: readonly PriceDraft[]): string[] {
  if (!view) return [];
  const known = new Set(drafts.map((draft) => normalizeModelId(draft.model)));
  return [...new Set(view.usedModels.map((model) => normalizeModelId(model)))]
    .filter((model) => model && !known.has(model))
    .sort();
}

export function pricesDirty(drafts: readonly PriceDraft[], rows: readonly ModelPriceRowView[]): boolean {
  if (drafts.length !== rows.length) return true;
  // Rows are compared by model, not by place: the table is sorted for reading, not for saving.
  const before = new Map(rows.map((row) => [normalizeModelId(row.model), row]));
  return drafts.some((draft) => {
    const was = before.get(normalizeModelId(draft.model));
    if (!was) return true;
    return (
      parsePriceValue(draft.input) !== was.input ||
      parsePriceValue(draft.cachedInput) !== was.cachedInput ||
      parsePriceValue(draft.output) !== was.output
    );
  });
}

/** Sorted so the models in use stand first; inside a group, alphabetical. */
export function sortDrafts(drafts: readonly PriceDraft[], usedModels: readonly string[]): PriceDraft[] {
  const used = new Set(usedModels.map((model) => normalizeModelId(model)));
  return [...drafts].sort((left, right) => {
    const leftUsed = used.has(normalizeModelId(left.model)) ? 0 : 1;
    const rightUsed = used.has(normalizeModelId(right.model)) ? 0 : 1;
    return leftUsed - rightUsed || left.model.localeCompare(right.model);
  });
}
