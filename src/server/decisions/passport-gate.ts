import { decisionPoint, type DecisionQuestion, type DecisionSettings } from "../../shared/decisions";
import type { PassportDraft } from "../projects/passport-writer.js";
import { askDecisions, confident } from "./client";

/**
 * Привратник паспорта: последний вопрос перед тем, как новая редакция станет той, что читают все
 * сотрудники проекта. Паспорт применяется сразу, без приёмки владельца, поэтому проверка на
 * секрет и на состояние дня здесь не формальность.
 *
 * Отдельно спрашиваем, отличается ли новая редакция от прежней по существу: иначе история
 * паспорта заросла бы редакциями, в которых переставлены слова.
 */

export const PASSPORT_GATE_POINT = "passport-gate";

export type PassportVerdict = { apply: boolean; reason: string | null; ms: number };

function text(draft: PassportDraft): string {
  return [draft.header, ...draft.sections.map((section) => `${section.key}: ${section.text}`)].join("\n");
}

function questions(hasPrevious: boolean): DecisionQuestion[] {
  return [
    { id: "secret", kind: "bool", prompt: "Есть ли в этой сводке ключ, пароль, токен или личные данные?" },
    { id: "transient", kind: "bool", prompt: "Это состояние на сегодня (ход задач, кто чем занят), а не устойчивые черты проекта?" },
    ...(hasPrevious ? [{ id: "changed", kind: "bool" as const, prompt: "Отличается ли новая сводка от прежней по существу, а не только словами?" }] : []),
  ];
}

/** Оценщик выключен, не отвечает или не уверен — редакция применяется по обычному правилу. */
export async function askPassportGate(
  settings: DecisionSettings,
  draft: PassportDraft,
  previous: PassportDraft | null,
  deps: { fetch?: typeof fetch; key?: string } = {},
): Promise<PassportVerdict | null> {
  if (!settings.enabled || !settings.points.includes(PASSPORT_GATE_POINT)) return null;
  const point = decisionPoint(PASSPORT_GATE_POINT);
  if (!point) return null;
  const state = [
    "Новая редакция паспорта проекта:",
    text(draft),
    ...(previous ? ["", "Прежняя редакция:", text(previous)] : []),
  ].join("\n");
  const outcome = await askDecisions(settings, { state, questions: questions(Boolean(previous)) }, deps);
  if (!outcome.ok) return null;

  const secret = confident(outcome.answers, "secret", point.threshold);
  const transient = confident(outcome.answers, "transient", point.threshold);
  const changed = confident(outcome.answers, "changed", point.threshold);
  const reason = secret?.value === true
    ? "В сводке нашёлся ключ или личные данные: редакция не применена."
    : transient?.value === true
      ? "Сводка описывает состояние дня, а не проект: редакция не применена."
      : previous && changed?.value === false
        ? "Новая редакция не отличается от прежней по существу."
        : null;
  return { apply: reason === null, reason, ms: outcome.ms };
}
