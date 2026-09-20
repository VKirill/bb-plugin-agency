import { decisionPoint, type DecisionQuestion, type DecisionSettings } from "../../shared/decisions";
import { agencyLanguage } from "../i18n/language.js";
import { askDecisions, confident } from "./client";
import { formatDecisionAnswers } from "./log";

/**
 * Привратник сдачи: первый проход по опубликованной версии исполнителя.
 *
 * Возвращает на доработку только уверенный мусор или сдачу мимо брифа. Принятие
 * независимую проверку не пропускает: неоднозначное — молчание, дальше конвейер.
 * Оценщик не пишет прозу проверки: замечание — шаблон.
 */

export const HAND_IN_GATE_POINT = "hand-in-gate";

export type HandInGateResult =
  | { action: "rework"; remark: string; ms: number; answers: string }
  | { action: "proceed"; ms: number; answers: string };

function questions(): DecisionQuestion[] {
  return [
    {
      id: "complete",
      kind: "bool",
      prompt: "Похоже ли, что сданная работа закрывает бриф и критерии приёмки, а не обещает доделать потом?",
    },
    {
      id: "junk",
      kind: "bool",
      prompt: "Это пустая, черновая или мимо брифа сдача: заглушка, чужой результат, «должно работать» без факта?",
    },
    {
      id: "verdict",
      kind: "choice",
      prompt: "Что делать со сдачей до независимой проверки?",
      choices: ["rework", "proceed"],
      descriptions: {
        rework: "Уверенный мусор или сдача мимо брифа: вернуть тому же исполнителю.",
        proceed: "Не мусор: пусть идёт на независимую проверку. Оценщик проверку не заменяет.",
      },
    },
  ];
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

function state(job: { key: string; title: string; brief: string; acceptance: string }, comment: string): string {
  return [
    `Сдача ${job.key}: ${job.title}`,
    `Бриф: ${clip(job.brief, 1_200)}`,
    `Критерии: ${clip(job.acceptance, 800)}`,
    `Последний комментарий: ${clip(comment, 1_200) || "нет"}`,
  ].join("\n");
}

function reworkRemark(): string {
  return agencyLanguage() === "en"
    ? "Decision model: the hand-in does not look ready for independent review. Publish a result that meets the acceptance criteria, name the checks you ran and leave a summary comment."
    : "Оценщик: сдача не выглядит готовой к независимой проверке. Опубликуйте результат, который закрывает критерии приёмки, назовите проверки и оставьте итоговый комментарий.";
}

/**
 * Уверенный мусор → `rework`. Иначе `null`: конвейер идёт на независимую проверку.
 */
export async function askHandInGate(
  settings: DecisionSettings,
  job: { key: string; title: string; brief: string; acceptance: string },
  comment: string,
  deps: { fetch?: typeof fetch; key?: string } = {},
): Promise<HandInGateResult | null> {
  if (!settings.enabled || !settings.points.includes(HAND_IN_GATE_POINT)) return null;
  const point = decisionPoint(HAND_IN_GATE_POINT);
  if (!point) return null;
  const outcome = await askDecisions(settings, { state: state(job, comment), questions: questions() }, deps);
  if (!outcome.ok) return null;
  const answers = formatDecisionAnswers(outcome.answers);
  const complete = confident(outcome.answers, "complete", point.threshold);
  const junk = confident(outcome.answers, "junk", point.threshold);
  const verdict = confident(outcome.answers, "verdict", point.threshold);
  const sendBack =
    complete?.value === false || junk?.value === true || verdict?.value === "rework";
  if (!sendBack) return { action: "proceed", ms: outcome.ms, answers };
  return { action: "rework", remark: reworkRemark(), ms: outcome.ms, answers };
}
