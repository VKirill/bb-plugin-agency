import { normalizeModelId } from "../../shared/model-id.js";

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
