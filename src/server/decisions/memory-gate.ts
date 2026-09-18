import { KNOWLEDGE_KINDS, type KnowledgeItem, type KnowledgeKind } from "../knowledge/store";
import { decisionPoint, type DecisionQuestion, type DecisionSettings } from "../../shared/decisions";
import { askDecisions, confident, type DecisionOutcome } from "./client";

/**
 * Привратник памяти: последний вопрос перед тем, как запись попадёт в запуски отдела.
 *
 * Спрашиваем ровно то, где наше правило грубое: «стоит ли это помнить», «нет ли здесь секрета
 * или состояния на сегодня», «не повтор ли это» и какой это вид. Замер на наших записях показал,
 * что решение «хранить или нет» дешёвой модели по силам, а вид она путает, — поэтому отказ и
 * секрет останавливают запись, а вид и важность приходят предложением.
 */

export const MEMORY_GATE_POINT = "memory-gate";

export type MemoryVerdict = {
  keep: boolean;
  /** Почему не храним: это идёт владельцу словами, а не кодом. */
  reason: string | null;
  kind: KnowledgeKind | null;
  importance: number | null;
  duplicateOf: string | null;
  ms: number;
};

const NONE = "нет";

function questions(existing: readonly KnowledgeItem[]): DecisionQuestion[] {
  return [
    { id: "keep", kind: "bool", prompt: "Стоит ли хранить эту запись в памяти отдела, чтобы она приходила в каждый запуск?" },
    { id: "secret", kind: "bool", prompt: "Есть ли в тексте ключ, пароль или иной доступ?" },
    { id: "transient", kind: "bool", prompt: "Это состояние на сегодня (статус задачи, кто чем занят), а не правило работы?" },
    { id: "kind", kind: "choice", prompt: "Какой это вид записи?", choices: KNOWLEDGE_KINDS },
    { id: "importance", kind: "score", prompt: "Насколько запись меняет работу отдела?", min: 0, max: 100 },
    ...(existing.length
      ? [{ id: "duplicate", kind: "choice" as const, prompt: "Это та же запись, что одна из уже имеющихся?", choices: [NONE, ...existing.map((item) => item.id)] }]
      : []),
  ];
}

function state(draft: { title: string; summary: string; body: string }, existing: readonly KnowledgeItem[]): string {
  const lines = [`Новая запись.`, `Название: ${draft.title}`, `Сводка: ${draft.summary}`, `Текст: ${draft.body.slice(0, 2_000)}`];
  if (existing.length) {
    lines.push("", "Уже в памяти отдела:");
    for (const item of existing.slice(0, 40)) lines.push(`${item.id}: ${item.title} — ${item.summary}`);
  }
  return lines.join("\n");
}

/**
 * Спросить оценщика о записи. Оценщик выключен, не отвечает или не уверен — возвращаем `null`:
 * запись идёт обычным путём, по правилам Агентства.
 */
export async function askMemoryGate(
  settings: DecisionSettings,
  draft: { title: string; summary: string; body: string },
  existing: readonly KnowledgeItem[],
  deps: { fetch?: typeof fetch; key?: string } = {},
): Promise<MemoryVerdict | null> {
  if (!settings.enabled || !settings.points.includes(MEMORY_GATE_POINT)) return null;
  const point = decisionPoint(MEMORY_GATE_POINT);
  if (!point) return null;
  const list = questions(existing);
  const outcome: DecisionOutcome = await askDecisions(settings, { state: state(draft, existing), questions: list }, deps);
  if (!outcome.ok) return null;

  const secret = confident(outcome.answers, "secret", point.threshold);
  const transient = confident(outcome.answers, "transient", point.threshold);
  const duplicate = confident(outcome.answers, "duplicate", point.threshold);
  const keep = confident(outcome.answers, "keep", point.threshold);
  const kind = confident(outcome.answers, "kind", point.threshold);
  const importance = confident(outcome.answers, "importance", point.threshold);

  const duplicateOf = duplicate && typeof duplicate.value === "string" && duplicate.value !== NONE ? duplicate.value : null;
  const reason = secret?.value === true
    ? "В тексте есть ключ или пароль: такие записи в память не идут."
    : transient?.value === true
      ? "Это состояние на сегодня, а не правило: через неделю запись будет мешать."
      : duplicateOf
        ? `Это повтор записи ${duplicateOf}.`
        : keep?.value === false
          ? "Оценщик не увидел здесь правила, которое стоит помнить."
          : null;

  return {
    keep: reason === null,
    reason,
    kind: kind && typeof kind.value === "string" && (KNOWLEDGE_KINDS as readonly string[]).includes(kind.value) ? (kind.value as KnowledgeKind) : null,
    importance: importance && typeof importance.value === "number" ? Math.max(0, Math.min(100, Math.round(importance.value))) : null,
    duplicateOf,
    ms: outcome.ms,
  };
}
