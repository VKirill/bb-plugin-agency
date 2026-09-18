import { decisionPoint, type DecisionQuestion, type DecisionSettings } from "../../shared/decisions";
import type { KnowledgeItem } from "../knowledge/store";
import { askDecisions, confident } from "./client";

/**
 * Подсказка к запуску: какие из назначенных навыков поднять под эту работу и какие записи памяти
 * отдела к ней относятся.
 *
 * Сотрудник и так видит список своих навыков и индекс знаний, но список — это не выбор: при
 * десяти навыках и сорока записях он либо читает всё (дорого), либо не читает ничего. Оценщик
 * читает состояние один раз и отвечает по каждому кандидату «да/нет» со своей уверенностью, а
 * Агентство кладёт в задачу короткую строку. Это подсказка, а не приказ: бриф и регламент выше.
 */

export const BRIEFING_POINT = "launch-briefing";

/** Сколько кандидатов уходит в один вопрос: больше — дороже и бесполезнее. */
const SKILL_LIMIT = 10;
const LESSON_LIMIT = 12;
/** Столько подсказок доходит до промпта: подсказка длиннее брифа перестаёт быть подсказкой. */
const PICK_LIMIT = 4;
/**
 * Доля кандидатов, после которой выбор перестаёт быть выбором. Живой прогон показал это на
 * широком брифе вроде «полный аудит сайта»: модель отвечает «нужно» почти на всё, и подсказка
 * повторяет общий список. Такой ответ мы выбрасываем — сотрудник и так видит всё, что ему дано.
 */
const NOISE_RATIO = 0.5;
export const BRIEFING_TEXT_LIMIT = 1_400;

export type BriefingSkill = { id: string; name: string; description?: string };

export type BriefingInput = {
  job: { key: string; title: string; brief: string; acceptance: string };
  skills: readonly BriefingSkill[];
  lessons: readonly KnowledgeItem[];
};

export type Briefing = { text: string; skills: BriefingSkill[]; lessons: KnowledgeItem[]; ms: number };

function state(input: BriefingInput, skills: readonly BriefingSkill[], lessons: readonly KnowledgeItem[]): string {
  const lines = [
    `Работа ${input.job.key}: ${input.job.title}`,
    `Что нужно сделать: ${input.job.brief.slice(0, 1_500)}`,
    `Критерий приёмки: ${input.job.acceptance.slice(0, 500)}`,
  ];
  if (skills.length) {
    lines.push("", "Навыки, доступные исполнителю:");
    // Имя навыка ничего не говорит: «drmax» — это аудит сайта, и без строки из SKILL.md это не угадать.
    skills.forEach((skill, index) => lines.push(`s${index}: ${skill.name}${skill.description ? ` — ${skill.description.slice(0, 200)}` : ""}`));
  }
  if (lessons.length) {
    lines.push("", "Записи памяти отдела:");
    lessons.forEach((lesson, index) => lines.push(`k${index}: ${lesson.title} — ${lesson.summary}`));
  }
  return lines.join("\n");
}

function questions(skills: readonly BriefingSkill[], lessons: readonly KnowledgeItem[]): DecisionQuestion[] {
  return [
    ...skills.map((skill, index) => ({ id: `s${index}`, kind: "bool" as const, prompt: `Нужен ли навык «${skill.name}» для этой работы?` })),
    ...lessons.map((lesson, index) => ({ id: `k${index}`, kind: "bool" as const, prompt: `Поможет ли в этой работе запись «${lesson.title}»?` })),
  ];
}

function text(skills: readonly BriefingSkill[], lessons: readonly KnowledgeItem[]): string {
  const lines = ["Подсказка к этой работе (собрал оценщик Агентства; это не приказ — бриф и регламент выше)."];
  if (skills.length) {
    lines.push(`Навыки, которые здесь скорее всего нужны: ${skills.map((skill) => skill.name).join(", ")}. Прочитайте их до начала.`);
  }
  if (lessons.length) {
    lines.push("Записи памяти отдела про такую же работу (полный текст: bb agency knowledge get):");
    for (const lesson of lessons) lines.push(`- ${lesson.title} — ${lesson.summary} (${lesson.id})`);
  }
  lines.push("Подсказка не подошла — работайте по брифу; ошибку в ней стоит назвать в отчёте.");
  return lines.join("\n").slice(0, BRIEFING_TEXT_LIMIT);
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
  if (!settings.enabled || !settings.points.includes(BRIEFING_POINT)) return null;
  const point = decisionPoint(BRIEFING_POINT);
  if (!point) return null;
  const skills = input.skills.slice(0, SKILL_LIMIT);
  // Записи берём по ценности: список уже отсортирован тем же порядком, что и индекс в промпте.
  const lessons = input.lessons.slice(0, LESSON_LIMIT);
  if (!skills.length && !lessons.length) return null;

  const outcome = await askDecisions(settings, { state: state(input, skills, lessons), questions: questions(skills, lessons) }, deps);
  if (!outcome.ok) return null;

  const signal = <T>(all: readonly T[], picked: readonly T[]): T[] =>
    picked.length && picked.length <= all.length * NOISE_RATIO ? picked.slice(0, PICK_LIMIT) : [];
  const pickedSkills = signal(skills, skills.filter((_, index) => confident(outcome.answers, `s${index}`, point.threshold)?.value === true));
  const pickedLessons = signal(lessons, lessons.filter((_, index) => confident(outcome.answers, `k${index}`, point.threshold)?.value === true));
  if (!pickedSkills.length && !pickedLessons.length) return null;
  return { text: text(pickedSkills, pickedLessons), skills: pickedSkills, lessons: pickedLessons, ms: outcome.ms };
}
