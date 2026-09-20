import type { ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk";
import { AGENT_FALLBACK_LIMIT, fallbackModelKey, type AgentFallbackModel } from "../../shared/contracts";

/**
 * The reserve list of the employee draft: picker values in priority order. Pure helpers, so
 * the card only renders them and a failed save leaves the list exactly as the owner built it.
 */
export type FallbackPick = ExperimentalProviderModelPickerValue;

export { AGENT_FALLBACK_LIMIT };

export function canAddFallback(list: readonly FallbackPick[]): boolean {
  return list.length < AGENT_FALLBACK_LIMIT;
}

/** A new row starts from the primary pick: the owner changes it in the picker right away. */
export function addFallback(list: readonly FallbackPick[], primary: FallbackPick): FallbackPick[] {
  return canAddFallback(list) ? [...list, { ...primary }] : [...list];
}

export function replaceFallback(list: readonly FallbackPick[], index: number, pick: FallbackPick): FallbackPick[] {
  return list.map((item, at) => (at === index ? pick : item));
}

export function removeFallback(list: readonly FallbackPick[], index: number): FallbackPick[] {
  return list.filter((_, at) => at !== index);
}

/** Moves a reserve one step up (-1) or down (+1); the order is the launch priority. */
export function moveFallback(list: readonly FallbackPick[], index: number, step: -1 | 1): FallbackPick[] {
  const target = index + step;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list];
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export type FallbackProblem = { index: number; kind: "same_as_primary" | "repeated" | "incomplete" };

/** What the server would refuse, found before the save so the row can say it. */
export function fallbackProblems(primary: { providerId: string; model: string }, list: readonly FallbackPick[]): FallbackProblem[] {
  const problems: FallbackProblem[] = [];
  const seen = new Set<string>();
  const primaryKey = fallbackModelKey(primary);
  list.forEach((pick, index) => {
    if (!pick.providerId.trim() || !pick.model.trim()) {
      problems.push({ index, kind: "incomplete" });
      return;
    }
    const key = fallbackModelKey(pick);
    if (key === primaryKey) problems.push({ index, kind: "same_as_primary" });
    else if (seen.has(key)) problems.push({ index, kind: "repeated" });
    seen.add(key);
  });
  return problems;
}

export function fallbackModelsFromPicks(list: readonly FallbackPick[]): AgentFallbackModel[] {
  return list.map((pick) => ({
    providerId: pick.providerId.trim(),
    model: pick.model.trim(),
    ...(pick.reasoningLevel ? { reasoningEffort: pick.reasoningLevel as AgentFallbackModel["reasoningEffort"] } : {}),
    ...(pick.serviceTier ? { serviceTier: pick.serviceTier as AgentFallbackModel["serviceTier"] } : {}),
  }));
}

export function picksFromFallbackModels(list: readonly AgentFallbackModel[] | undefined): FallbackPick[] {
  return (list ?? []).map((pick) => ({
    providerId: pick.providerId,
    model: pick.model,
    reasoningLevel: pick.reasoningEffort ?? "medium",
    ...(pick.serviceTier ? { serviceTier: pick.serviceTier } : {}),
  }));
}

/** Stable text of the list for the dirty check: a reorder is a change. */
export function fallbackListKey(list: readonly FallbackPick[] | undefined): string {
  return (list ?? [])
    .map((pick) => [pick.providerId, pick.model, pick.reasoningLevel ?? "", pick.serviceTier ?? ""].join("\u0000"))
    .join("\u0001");
}
