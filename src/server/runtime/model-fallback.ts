import { normalizeModelId } from "../../shared/model-id.js";
import { fallbackModelKey, type AgentFallbackModel, type ReasoningEffort } from "../../shared/contracts/versions.js";

/**
 * The same Agency on another BB: the employees were set up on models that machine may not have.
 * This picks the closest model that is actually connected there — first the same model under
 * another CLI, then the same class from a family the owner is likely to have, then the CLI's own
 * default. When nothing fits, the employee is left without a model and the launch says so instead
 * of quietly running on something else.
 */

export type CatalogModel = {
  providerId: string;
  model: string;
  isDefault: boolean;
  displayName?: string;
  supportedReasoningEfforts?: readonly { reasoningEffort: string }[];
};

export type ModelWish = { providerId: string; model: string };

export type ModelChoiceReason = "base_id" | "cross_provider" | "same_class" | "provider_default";

export type ModelChoice =
  | { status: "exact"; providerId: string; model: string }
  | { status: "substituted"; providerId: string; model: string; reason: ModelChoiceReason; wanted: ModelWish }
  | { status: "missing"; wanted: ModelWish };

type ModelClass = "strong" | "balanced" | "light";

/** Families in the order a substitute is picked: what most BB users have connected. */
const FAMILY_ORDER = ["claude", "gpt", "grok", "gemini"] as const;
/** Usage-limit reserves: Claude first, then GPT, then Grok. Gemini is a substitute family, not a default reserve. */
const RESERVE_FAMILIES = ["claude", "gpt", "grok"] as const;
const CLASS_RANK: Record<ModelClass, number> = { light: 0, balanced: 1, strong: 2 };
const EFFORT_FOR_CLASS: Record<ModelClass, Extract<ReasoningEffort, "low" | "medium" | "high">> = {
  light: "low",
  balanced: "medium",
  strong: "high",
};

const KNOWN: { match: RegExp; family: string; klass: ModelClass }[] = [
  { match: /^claude-(fable|mythos)/, family: "claude", klass: "strong" },
  { match: /^claude-opus/, family: "claude", klass: "strong" },
  { match: /^claude-sonnet/, family: "claude", klass: "balanced" },
  { match: /^claude-haiku/, family: "claude", klass: "light" },
  { match: /^gpt-.*-(sol|apex|pro)/, family: "gpt", klass: "strong" },
  { match: /^gpt-.*-(luna|terra|mini|nano)/, family: "gpt", klass: "light" },
  { match: /^(gpt|o\d)/, family: "gpt", klass: "balanced" },
  { match: /^grok-.*(heavy|max)/, family: "grok", klass: "strong" },
  { match: /^grok/, family: "grok", klass: "balanced" },
  { match: /^gemini-.*(pro|ultra)/, family: "gemini", klass: "strong" },
  { match: /^gemini/, family: "gemini", klass: "light" },
];

export function modelFamily(model: string): { family: string; klass: ModelClass } | null {
  const id = normalizeModelId(model);
  const found = KNOWN.find((entry) => entry.match.test(id));
  return found ? { family: found.family, klass: found.klass } : null;
}

function sameModel(entry: CatalogModel, model: string): boolean {
  return normalizeModelId(entry.model) === normalizeModelId(model);
}

/** Family preference for a substitute: the wish's own family first, then the usual suspects. */
function familyRank(family: string, wanted: string | null): number {
  if (wanted && family === wanted) return -1;
  const index = FAMILY_ORDER.indexOf(family as (typeof FAMILY_ORDER)[number]);
  return index === -1 ? FAMILY_ORDER.length : index;
}

export function resolveModelChoice(wish: ModelWish, catalog: readonly CatalogModel[]): ModelChoice {
  if (!wish.model.trim() || !catalog.length) return { status: "missing", wanted: wish };

  const exact = catalog.find((entry) => entry.providerId === wish.providerId && entry.model === wish.model);
  if (exact) return { status: "exact", providerId: exact.providerId, model: exact.model };

  // `claude-opus-5[1m]` and `claude-opus-5` are the same model with another context window.
  const sameProvider = catalog.find((entry) => entry.providerId === wish.providerId && sameModel(entry, wish.model));
  if (sameProvider) {
    return { status: "substituted", providerId: sameProvider.providerId, model: sameProvider.model, reason: "base_id", wanted: wish };
  }

  const elsewhere = catalog.find((entry) => sameModel(entry, wish.model));
  if (elsewhere) {
    return { status: "substituted", providerId: elsewhere.providerId, model: elsewhere.model, reason: "cross_provider", wanted: wish };
  }

  const wanted = modelFamily(wish.model);
  if (wanted) {
    const sameClass = [...catalog]
      .filter((entry) => modelFamily(entry.model)?.klass === wanted.klass)
      .sort((left, right) => {
        const leftFamily = modelFamily(left.model)!.family;
        const rightFamily = modelFamily(right.model)!.family;
        return (
          familyRank(leftFamily, wanted.family) - familyRank(rightFamily, wanted.family) ||
          Number(right.isDefault) - Number(left.isDefault) ||
          left.model.localeCompare(right.model)
        );
      })[0];
    if (sameClass) {
      return { status: "substituted", providerId: sameClass.providerId, model: sameClass.model, reason: "same_class", wanted: wish };
    }
  }

  // Nothing of the same class: the CLI's own default is still a working model.
  const providerDefault =
    catalog.find((entry) => entry.providerId === wish.providerId && entry.isDefault) ??
    catalog.find((entry) => entry.isDefault);
  if (providerDefault) {
    return { status: "substituted", providerId: providerDefault.providerId, model: providerDefault.model, reason: "provider_default", wanted: wish };
  }
  return { status: "missing", wanted: wish };
}

/** Wording for the job history, the owner message and the employee card. */
export function modelChoiceNote(choice: ModelChoice, english: boolean): string | null {
  if (choice.status === "exact") return null;
  if (choice.status === "missing") {
    return english
      ? `Model ${choice.wanted.model} (${choice.wanted.providerId}) is not connected in this BB, and no substitute was found. Pick a model in the employee profile.`
      : `Модель ${choice.wanted.model} (${choice.wanted.providerId}) не подключена в этом BB, замены не нашлось. Выберите модель в профиле сотрудника.`;
  }
  return english
    ? `Model ${choice.wanted.model} (${choice.wanted.providerId}) is not connected here; ${choice.model} (${choice.providerId}) is used instead.`
    : `Модель ${choice.wanted.model} (${choice.wanted.providerId}) здесь не подключена, вместо неё — ${choice.model} (${choice.providerId}).`;
}

function closestInFamily(family: string, wantKlass: ModelClass, catalog: readonly CatalogModel[]): CatalogModel | null {
  const rows = catalog.filter((entry) => modelFamily(entry.model)?.family === family);
  if (!rows.length) return null;
  const want = CLASS_RANK[wantKlass];
  return [...rows].sort((left, right) => {
    const leftKlass = modelFamily(left.model)!.klass;
    const rightKlass = modelFamily(right.model)!.klass;
    const byClass = Math.abs(CLASS_RANK[leftKlass] - want) - Math.abs(CLASS_RANK[rightKlass] - want);
    if (byClass) return byClass;
    return Number(right.isDefault) - Number(left.isDefault) || left.model.localeCompare(right.model);
  })[0] ?? null;
}

/**
 * Other connected families of the same class, Claude → GPT → Grok. A Claude-only
 * catalog yields an empty list: there is nothing else to name as a reserve.
 */
export function catalogReserves(primary: ModelWish, catalog: readonly CatalogModel[]): AgentFallbackModel[] {
  if (!catalog.length) return [];
  const chosen = resolveModelChoice(primary, catalog);
  const actual = chosen.status === "missing" ? primary : { providerId: chosen.providerId, model: chosen.model };
  const wanted = modelFamily(actual.model);
  const seen = new Set([fallbackModelKey(actual)]);
  const list: AgentFallbackModel[] = [];
  for (const family of RESERVE_FAMILIES) {
    if (wanted?.family === family) continue;
    const hit = closestInFamily(family, wanted?.klass ?? "balanced", catalog);
    if (!hit) continue;
    const key = fallbackModelKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    const klass = modelFamily(hit.model)?.klass ?? "balanced";
    list.push({ providerId: hit.providerId, model: hit.model, reasoningEffort: EFFORT_FOR_CLASS[klass] });
    if (list.length >= 4) break;
  }
  return list;
}

/**
 * Owner-set reserves stay if they still exist in the catalog. An empty list is
 * filled from the connected families so a smaller subscription still has a chain.
 */
export function mergedReserves(
  primary: ModelWish,
  existing: readonly AgentFallbackModel[] | undefined,
  catalog: readonly CatalogModel[],
): AgentFallbackModel[] {
  if (existing?.length) {
    const kept = existing.filter((pick) => resolveModelChoice(pick, catalog).status === "exact");
    if (kept.length) return kept.map((pick) => ({ ...pick }));
  }
  return catalogReserves(primary, catalog);
}
