import { randomUUID } from "node:crypto";
import {
  INTAKE_REFERENCE_VALUES,
  intakeReferencesComplete,
  type Job,
} from "../../shared/contracts";
import { decisionPoint, type DecisionQuestion, type DecisionSettings } from "../../shared/decisions";
import { agencyLanguage } from "../i18n/language.js";
import type { ServiceContext } from "../services/context.js";
import type { DomainStore } from "../services/domain-store.js";
import { askDecisions, confident } from "./client";
import { formatDecisionAnswers, type DecisionLogInput } from "./log";

/**
 * Оценка на входе: размер, риск и решение по поручению.
 *
 * Пишет тот же комментарий с references, что и руководитель. Это предложение: оценщик не
 * создаёт подзадачи, не блокирует задачу на return и не зовёт владельца на clarify.
 * Ниже порога по любому из трёх ответов — молчание, оценку пишет руководитель как раньше.
 */

export const INTAKE_POINT = "intake";

export type IntakeProposal = {
  size: "S" | "M" | "L";
  risk: "low" | "medium" | "high";
  decision: "accept" | "split" | "clarify" | "return";
  ms: number;
  answers: string;
};

/** Полный исход вопроса, в том числе молчание: иначе в журнале пустые ответы и 0 мс. */
export type IntakeAskResult = {
  proposal: IntakeProposal | null;
  ms: number;
  answers: string;
  reason: "proposal" | "disabled" | "failed" | "unconfident";
};

const SIZES = INTAKE_REFERENCE_VALUES.intake_size;
const RISKS = INTAKE_REFERENCE_VALUES.intake_risk;
const DECISIONS = INTAKE_REFERENCE_VALUES.intake_decision;

function questions(): DecisionQuestion[] {
  return [
    {
      id: "size",
      kind: "choice",
      prompt: "Какой это размер работы — по смыслу поручения, а не по числу строк?",
      choices: SIZES,
      descriptions: {
        S: "Одна работа на одного человека, один результат, часы, а не дни.",
        M: "Несколько подзадач или один круг проверки, всё ещё одно поручение.",
        L: "Несколько этапов, несколько людей или высокая неопределённость: лучше резать.",
      },
    },
    {
      id: "risk",
      kind: "choice",
      prompt: "Какой риск, если сделать как написано?",
      choices: RISKS,
      descriptions: {
        low: "Знакомый шаблон, ошибка обратима.",
        medium: "Есть неизвестные, но откат есть.",
        high: "Необратимо, секреты, много модулей или размытые требования.",
      },
    },
    {
      id: "decision",
      kind: "choice",
      prompt: "Что делать с этим поручением? Это предложение руководителю, а не действие.",
      choices: DECISIONS,
      descriptions: {
        accept: "Отдел берёт целиком одной задачей: весь бриф в его «Принимаем».",
        split: "Резать на подзадачи — у себя и в другие отделы по «Принимаем». Смешанный продукт (текст + картинка + код в одном брифе) — тоже split, не return. Новая программа без принятого предложения — split в отдел спецификаций, не accept в разработку. Оценщик подзадачи не создаёт.",
        clarify: "Не хватает входа или решения владельца. Оценщик сам не спрашивает.",
        return: "Весь бриф мимо, собирать продукт не из чего или нет подходящего отдела. Оценщик сам не блокирует.",
      },
    },
  ];
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

function state(job: {
  key: string;
  title: string;
  brief: string;
  acceptance: string;
  charter?: string;
  workKind?: string | null;
}): string {
  return [
    `Задача ${job.key}: ${job.title}`,
    `Бриф: ${clip(job.brief, 1_200)}`,
    `Критерии: ${clip(job.acceptance, 800)}`,
    `Вид работы: ${job.workKind ?? "не указан"}`,
    ...(job.charter ? [`Регламент отдела: ${clip(job.charter, 800)}`] : []),
    "Смешанный продукт (несколько видов работы в одном брифе) — split, не return: чужие части уходят подзадачами в отделы, которые их принимают.",
    "Новая программа или сервис (workKind new-program) без принятого proposal.md/spec.md — split в отдел спецификаций, не accept в отдел, который пишет код.",
  ].join("\n");
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export function activityHasIntake(activity: readonly { references: readonly { type: string }[] }[]): boolean {
  return activity.some((row) => {
    const intake = row.references.filter((reference) =>
      reference.type === "intake_size" || reference.type === "intake_risk" || reference.type === "intake_decision",
    );
    return intake.length > 0 && intakeReferencesComplete(row.references);
  });
}

/**
 * Спросить оценщика. Молчит, ошибка, выключенная точка или неуверенность хотя бы
 * по одному из трёх ответов — `null`: оценку пишет руководитель.
 */
export async function askIntakeDetailed(
  settings: DecisionSettings,
  job: { key: string; title: string; brief: string; acceptance: string; charter?: string; workKind?: string | null },
  deps: { fetch?: typeof fetch; key?: string } = {},
): Promise<IntakeAskResult> {
  if (!settings.enabled || !settings.points.includes(INTAKE_POINT)) {
    return { proposal: null, ms: 0, answers: "", reason: "disabled" };
  }
  const point = decisionPoint(INTAKE_POINT);
  if (!point) return { proposal: null, ms: 0, answers: "", reason: "disabled" };
  const outcome = await askDecisions(settings, { state: state(job), questions: questions() }, deps);
  if (!outcome.ok) {
    const hint = [outcome.reason, outcome.detail].filter(Boolean).join(":");
    return { proposal: null, ms: outcome.ms, answers: hint, reason: "failed" };
  }
  const answers = formatDecisionAnswers(outcome.answers);
  const size = pick(confident(outcome.answers, "size", point.threshold)?.value, SIZES);
  const risk = pick(confident(outcome.answers, "risk", point.threshold)?.value, RISKS);
  const decision = pick(confident(outcome.answers, "decision", point.threshold)?.value, DECISIONS);
  if (!size || !risk || !decision) {
    return { proposal: null, ms: outcome.ms, answers, reason: "unconfident" };
  }
  return { proposal: { size, risk, decision, ms: outcome.ms, answers }, ms: outcome.ms, answers, reason: "proposal" };
}

export async function askIntake(
  settings: DecisionSettings,
  job: { key: string; title: string; brief: string; acceptance: string; charter?: string; workKind?: string | null },
  deps: { fetch?: typeof fetch; key?: string } = {},
): Promise<IntakeProposal | null> {
  return (await askIntakeDetailed(settings, job, deps)).proposal;
}

function intakeComment(proposal: IntakeProposal): string {
  if (agencyLanguage() === "en") {
    return `Intake (decision model): size ${proposal.size}, risk ${proposal.risk}, decision ${proposal.decision}. This is a proposal: if you disagree, write your own assessment as a comment.`;
  }
  return `Оценка на входе (оценщик): размер ${proposal.size}, риск ${proposal.risk}, решение ${proposal.decision}. Это предложение: не согласны — запишите свою оценку комментарием.`;
}

export type RecordLeadIntakeDeps = {
  settings: DecisionSettings;
  job: Job | undefined;
  store: Pick<DomainStore, "memberRole" | "listActivity" | "createActivity" | "getDepartment" | "getProcessVersion">;
  ctx: ServiceContext;
  ask?: typeof askIntake;
  askDetailed?: typeof askIntakeDetailed;
  log?: (entry: DecisionLogInput) => void;
};

export type RecordLeadIntakeResult = "written" | "skipped";

/** Пишет оценку в историю, только если запуск принадлежит руководителю и оценки ещё нет. */
export async function recordLeadIntake(deps: RecordLeadIntakeDeps): Promise<RecordLeadIntakeResult> {
  const job = deps.job;
  const trace = (entry: Omit<DecisionLogInput, "point">) =>
    deps.log?.({ point: INTAKE_POINT, jobKey: job?.key ?? null, ...entry });
  if (!job?.assignedAgentId) {
    trace({ outcome: "skipped", detail: "no_assignee" });
    return "skipped";
  }
  if (deps.store.memberRole(job.departmentId, job.assignedAgentId) !== "lead") {
    trace({ outcome: "skipped", detail: "not_lead" });
    return "skipped";
  }
  if (activityHasIntake(deps.store.listActivity(job.id))) {
    trace({ outcome: "skipped", detail: "already" });
    return "skipped";
  }
  const department = deps.store.getDepartment(job.departmentId);
  const process = department ? deps.store.getProcessVersion(department.processVersionId) : undefined;
  const asked = deps.ask
    ? await deps.ask(deps.settings, {
        key: job.key,
        title: job.title,
        brief: job.brief,
        acceptance: job.acceptance,
        workKind: job.workKind,
        ...(process?.instructions ? { charter: process.instructions } : {}),
      }).then((proposal) =>
        proposal
          ? { proposal, ms: proposal.ms, answers: proposal.answers, reason: "proposal" as const }
          : { proposal: null, ms: 0, answers: "", reason: "unconfident" as const },
      )
    : await (deps.askDetailed ?? askIntakeDetailed)(deps.settings, {
        key: job.key,
        title: job.title,
        brief: job.brief,
        acceptance: job.acceptance,
        workKind: job.workKind,
        ...(process?.instructions ? { charter: process.instructions } : {}),
      });
  const proposal = asked.proposal;
  if (!proposal) {
    trace({ outcome: "silent", detail: asked.reason, answers: asked.answers, ms: asked.ms });
    return "skipped";
  }
  const written = deps.store.createActivity(deps.ctx, {
    requestId: randomUUID(),
    jobId: job.id,
    actor: { kind: "system" },
    kind: "comment",
    causationId: null,
    references: [
      { type: "intake_size", id: proposal.size },
      { type: "intake_risk", id: proposal.risk },
      { type: "intake_decision", id: proposal.decision },
    ],
    comment: intakeComment(proposal),
  });
  if (!written.ok) {
    trace({ outcome: "skipped", detail: "write_failed", answers: proposal.answers, ms: proposal.ms });
    return "skipped";
  }
  trace({
    outcome: "written",
    detail: `${proposal.size}/${proposal.risk}/${proposal.decision}`,
    answers: proposal.answers,
    ms: proposal.ms,
  });
  return "written";
}
