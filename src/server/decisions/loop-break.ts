import { decisionPoint, type DecisionQuestion, type DecisionSettings } from "../../shared/decisions";
import { askDecisions, confident } from "./client";
import { formatDecisionAnswers } from "./log";
import { asCause, asRelation, type LoopMark } from "../runtime/loop-break/mark.js";

/**
 * After a rework verdict: one Choice for the hypothesis, one for the cause.
 * Both run on the same state. Under the threshold an axis stays empty and
 * does not block on its own.
 */

export const LOOP_BREAK_POINT = "loop-break";

export type LoopBreakResult = LoopMark & { ms: number; answers: string };

function questions(): DecisionQuestion[] {
  return [
    {
      id: "relation",
      kind: "choice",
      prompt:
        "Новый вердикт «доработать» — это та же гипотеза, что уже проверяли на этой линии, или появилась новая улика?",
      choices: ["same_loop", "new_evidence"],
      descriptions: {
        same_loop: "Те же проверки, тот же дефект или тот же патч. Повторять эту гипотезу нечего.",
        new_evidence: "Вывод, файл или окружение сдвинулись. Это не повтор предыдущего круга.",
      },
    },
    {
      id: "cause",
      kind: "choice",
      prompt: "Что мешает закрыть работу по этому вердикту?",
      choices: ["code", "env", "contract", "context"],
      descriptions: {
        code: "Патч в разрешённых файлах может закрыть дефект.",
        env: "Мешает среда: машина, сеть, доступ, бинарник. Тот же патч повторять нельзя.",
        contract: "Рамки задачи или уже выполненный сценарий делают следующий круг не тем, что заказали.",
        context: "Не хватило файла или факта. Это не повод повторять тот же патч вслепую, но и не тупик среды.",
      },
    },
  ];
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

export function loopBreakState(input: { key: string; title: string; acceptance: string; prior: string; defects: string }): string {
  return [
    `Линия ${input.key}: ${input.title}`,
    `Критерии продукта: ${clip(input.acceptance, 800)}`,
    `Уже было: ${clip(input.prior, 800) || "нет"}`,
    `Новый вердикт: ${clip(input.defects, 1_200)}`,
  ].join("\n");
}

export async function askLoopBreak(
  settings: DecisionSettings,
  state: string,
  deps: { fetch?: typeof fetch; key?: string } = {},
): Promise<LoopBreakResult | null> {
  if (!settings.enabled || !settings.points.includes(LOOP_BREAK_POINT)) return null;
  const point = decisionPoint(LOOP_BREAK_POINT);
  if (!point) return null;
  const outcome = await askDecisions(settings, { state, questions: questions() }, deps);
  if (!outcome.ok) return null;
  const relation = confident(outcome.answers, "relation", point.threshold);
  const cause = confident(outcome.answers, "cause", point.threshold);
  return {
    relation: asRelation(typeof relation?.value === "string" ? relation.value : null),
    cause: asCause(typeof cause?.value === "string" ? cause.value : null),
    ms: outcome.ms,
    answers: formatDecisionAnswers(outcome.answers),
  };
}
