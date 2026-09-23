import { decisionPoint, type DecisionQuestion, type DecisionSettings } from "../../shared/decisions";
import type { KnowledgeItem } from "../knowledge/store";
import { askDecisions, confident } from "./client";
import { formatDecisionAnswers } from "./log";
import { askLaunchEffort, type EffortResult, type LaunchPlan } from "./launch-effort";
import type { ReasoningEffort } from "../../shared/contracts/versions";

/**
 * Подсказка к запуску: что поднять под эту работу.
 *
 * Кандидаты двух видов. **Из профиля** — то, что у сотрудника и так есть: список не выбор, при
 * десяти навыках он либо читает всё (дорого), либо ничего, поэтому оценщик подсвечивает нужное.
 * **Из библиотеки отдела** — то, что отдел вправе поднять под задание: такой навык открывается
 * на один запуск и попадает в журнал выдач. Права остаются у человека: библиотеку собирает
 * владелец или руководитель, оценщик лишь выбирает из неё по ТЗ.
 *
 * Записи памяти отбираются так же: подходящие называются в задаче, остальные остаются за
 * командой `bb agency knowledge list`.
 *
 * Это подсказка, а не приказ: бриф и регламент выше неё.
 */

export const BRIEFING_POINT = "launch-briefing";

/** Сколько кандидатов уходит в один вопрос: больше — дороже и бесполезнее. */
const SKILL_LIMIT = 10;
/** Из библиотеки отдела спрашиваем шире: там лежит всё, чем отдел вправе пользоваться. */
const POOL_LIMIT = 24;
const LESSON_LIMIT = 12;
/** Столько подсказок доходит до промпта: подсказка длиннее брифа перестаёт быть подсказкой. */
const PICK_LIMIT = 4;
/**
 * Доля кандидатов, после которой выбор перестаёт быть выбором. Живой прогон показал это на
 * широком брифе вроде «полный аудит сайта»: модель отвечает «нужно» почти на всё, и подсказка
 * повторяет общий список. Такой ответ мы выбрасываем — сотрудник и так видит всё, что ему дано.
 * На коротком профиле (один–три навыка) «нужны оба» — это и есть подсказка, а не шум.
 */
const NOISE_RATIO = 0.5;
const NOISE_MIN = 4;
/**
 * Открыть навык — решение о правах: порог выше обычного, и больше двух за раз не открываем.
 * 0.7, а не 0.8: на живых заданиях нужный навык получает 0.78–0.85, ненужный — ниже 0.35, и
 * порог у самой верхушки этого разрыва отсекал верные ответы из-за сотых долей.
 */
const GRANT_THRESHOLD = 0.7;
const GRANT_LIMIT = 2;
export const BRIEFING_TEXT_LIMIT = 1_400;

export type BriefingSkill = { id: string; name: string; description?: string };

export type LaunchEffort = ReasoningEffort;

export type BriefingInput = {
  job: LaunchPlan & { key: string };
  /** Навыки сотрудника: они уедут в запуск в любом случае. */
  skills: readonly BriefingSkill[];
  /** Библиотека отдела за вычетом профиля: это можно открыть под задание. */
  pool?: readonly BriefingSkill[];
  lessons: readonly KnowledgeItem[];
  /** Effort uses a separate request containing only the complete work plan. */
  askEffort?: boolean;
  supportedEfforts?: readonly string[];
};

export type Briefing = {
  text: string;
  skills: BriefingSkill[];
  /** Открытые под эту задачу из библиотеки: их добавляют в запуск и пишут в журнал. */
  granted: { skill: BriefingSkill; confidence: number }[];
  lessons: KnowledgeItem[];
  ms: number;
};

/** Имя навыка ничего не говорит: «drmax» — это аудит сайта, и без строки из SKILL.md это не угадать. */
function skillLine(prefix: string, skill: BriefingSkill, index: number): string {
  return `${prefix}${index}: ${skill.name}${skill.description ? ` — ${skill.description}` : ""}`;
}

function state(input: BriefingInput, skills: readonly BriefingSkill[], pool: readonly BriefingSkill[], lessons: readonly KnowledgeItem[]): string {
  const lines = [
    `Работа ${input.job.key}: ${input.job.title}`,
    `Что нужно сделать: ${input.job.brief}`,
    `Критерий приёмки: ${input.job.acceptance}`,
  ];
  if (skills.length) {
    lines.push("", "Навыки, которые у исполнителя уже есть:");
    skills.forEach((skill, index) => lines.push(skillLine("s", skill, index)));
  }
  if (pool.length) {
    lines.push("", "Навыки библиотеки отдела: их можно открыть под это задание, если без них результат заметно хуже:");
    pool.forEach((skill, index) => lines.push(skillLine("p", skill, index)));
  }
  if (lessons.length) {
    lines.push("", "Записи памяти отдела:");
    lessons.forEach((lesson, index) => lines.push(`k${index}: ${lesson.title} — ${lesson.summary}`));
  }
  return lines.join("\n");
}

function questions(
  skills: readonly BriefingSkill[],
  pool: readonly BriefingSkill[],
  lessons: readonly KnowledgeItem[],
): DecisionQuestion[] {
  return [
    ...skills.map((skill, index) => ({ id: `s${index}`, kind: "bool" as const, prompt: `Нужен ли навык «${skill.name}» для этой работы?` })),
    // Открытие навыка — расход прав: не «пригодится ли», а «без него хуже / с ним качественнее».
    ...pool.map((skill, index) => ({
      id: `p${index}`,
      kind: "bool" as const,
      prompt: `Поможет ли навык «${skill.name}» сделать эту работу качественнее — так, что без него результат заметно хуже?`,
    })),
    ...lessons.map((lesson, index) => ({ id: `k${index}`, kind: "bool" as const, prompt: `Поможет ли в этой работе запись «${lesson.title}»?` })),
  ];
}

function text(skills: readonly BriefingSkill[], granted: readonly BriefingSkill[], lessons: readonly KnowledgeItem[]): string {
  const lines = ["Подсказка к этой работе (собрал оценщик Агентства; это не приказ — бриф и регламент выше)."];
  if (skills.length) {
    lines.push(`Навыки, которые здесь скорее всего нужны: ${skills.map((skill) => skill.name).join(", ")}. Прочитайте их до начала.`);
  }
  if (granted.length) {
    lines.push(`Открыты для этой задачи из библиотеки отдела: ${granted.map((skill) => skill.name).join(", ")}. Они действуют только здесь и записаны в журнал выдач.`);
  }
  if (lessons.length) {
    lines.push("Записи памяти отдела про такую же работу (полный текст: bb agency knowledge get):");
    for (const lesson of lessons) lines.push(`- ${lesson.title} — ${lesson.summary} (${lesson.id})`);
  }
  lines.push("Подсказка не подошла — работайте по брифу; ошибку в ней стоит назвать в отчёте.");
  return lines.join("\n").slice(0, BRIEFING_TEXT_LIMIT);
}

export type BriefingAskResult = {
  briefing: Briefing | null;
  effort: LaunchEffort | null;
  effortTrace?: EffortResult;
  reason: "hint" | "disabled" | "empty" | "failed" | "silent";
  answers: string;
  ms: number;
  candidates: { skills: number; pool: number; lessons: number };
};

function trace(
  reason: BriefingAskResult["reason"],
  extra: {
    briefing?: Briefing | null;
    effort?: LaunchEffort | null;
    answers?: string;
    ms?: number;
    candidates?: BriefingAskResult["candidates"];
  } = {},
): BriefingAskResult {
  return {
    briefing: extra.briefing ?? null,
    effort: extra.effort ?? null,
    reason,
    answers: extra.answers ?? "",
    ms: extra.ms ?? 0,
    candidates: extra.candidates ?? { skills: 0, pool: 0, lessons: 0 },
  };
}

/**
 * Полный исход подсказки, в том числе молчание: иначе в журнале «оценщик не предложил навыки»
 * неотличимо от «оценщика не звали» и от пустой библиотеки.
 */
async function askSkillBriefingDetailed(
  settings: DecisionSettings,
  input: BriefingInput,
  deps: { fetch?: typeof fetch; key?: string } = {},
): Promise<BriefingAskResult> {
  const skills = input.skills.slice(0, SKILL_LIMIT);
  const pool = (input.pool ?? []).slice(0, POOL_LIMIT);
  const lessons = input.lessons.slice(0, LESSON_LIMIT);
  const candidates = { skills: skills.length, pool: pool.length, lessons: lessons.length };
  if (!settings.enabled || !settings.points.includes(BRIEFING_POINT)) return trace("disabled", { candidates });
  const point = decisionPoint(BRIEFING_POINT);
  if (!point) return trace("disabled", { candidates });
  if (!skills.length && !pool.length && !lessons.length) return trace("empty", { candidates });

  const outcome = await askDecisions(
    settings,
    { state: state(input, skills, pool, lessons), questions: questions(skills, pool, lessons) },
    deps,
  );
  if (!outcome.ok) {
    const hint = [outcome.reason, outcome.detail].filter(Boolean).join(":");
    return trace("failed", { answers: hint, ms: outcome.ms, candidates });
  }

  const answers = formatDecisionAnswers(outcome.answers);
  const signal = <T>(all: readonly T[], picked: readonly T[]): T[] => {
    if (!picked.length) return [];
    if (all.length >= NOISE_MIN && picked.length > all.length * NOISE_RATIO) return [];
    return picked.slice(0, PICK_LIMIT);
  };
  const pickedSkills = signal(skills, skills.filter((_, index) => confident(outcome.answers, `s${index}`, point.threshold)?.value === true));
  const pickedLessons = signal(lessons, lessons.filter((_, index) => confident(outcome.answers, `k${index}`, point.threshold)?.value === true));
  const granted = pool
    .map((skill, index) => ({ skill, answer: confident(outcome.answers, `p${index}`, GRANT_THRESHOLD) }))
    .filter((row) => row.answer?.value === true)
    .slice(0, GRANT_LIMIT)
    .map((row) => ({ skill: row.skill, confidence: row.answer?.confidence ?? GRANT_THRESHOLD }));
  if (!pickedSkills.length && !pickedLessons.length && !granted.length) {
    return trace("silent", { answers, ms: outcome.ms, candidates });
  }
  const briefing: Briefing = {
    text: text(pickedSkills, granted.map((row) => row.skill), pickedLessons),
    skills: pickedSkills,
    granted,
    lessons: pickedLessons,
    ms: outcome.ms,
  };
  return trace("hint", { briefing, answers, ms: outcome.ms, candidates });
}

/** Skill selection and effort are independent: skills/lessons never enter the effort state. */
export async function askBriefingDetailed(
  settings: DecisionSettings,
  input: BriefingInput,
  deps: { fetch?: typeof fetch; key?: string } = {},
): Promise<BriefingAskResult> {
  const [hint, effortTrace] = await Promise.all([
    askSkillBriefingDetailed(settings, input, deps),
    input.askEffort ? askLaunchEffort(settings, input.job, input.supportedEfforts, deps) : Promise.resolve(null),
  ]);
  if (!effortTrace) return hint;
  return {
    ...hint,
    reason: hint.reason === "empty" ? "silent" : hint.reason,
    effort: effortTrace.effort, effortTrace,
    answers: [hint.answers, effortTrace.answers].filter(Boolean).join(","),
    ms: Math.max(hint.ms, effortTrace.ms),
  };
}

/**
 * Спросить оценщика перед запуском. Выключен, не отвечает, не уверен или выбрал пусто — `null`:
 * запуск идёт как раньше, со списком навыков и индексом знаний.
 */
export async function askBriefing(
  settings: DecisionSettings,
  input: BriefingInput,
  deps: { fetch?: typeof fetch; key?: string } = {},
): Promise<Briefing | null> {
  return (await askBriefingDetailed(settings, input, deps)).briefing;
}
