import { DECISION_KEY_SOURCES, type DecisionKeySource } from "./decisions";

/**
 * Паспорт проекта: короткая сводка «что это за проект», собранная из накопленного — знаний
 * проекта, профилей работ, целей и принятых результатов. Верхний слой памяти: сотрудник читает
 * его первым и спускается к отдельным записям, только когда нужен конкретный факт.
 *
 * Паспорт не повторяет ни правила проекта (`.bb/AGENTS.md`), ни профили работ: правила говорят,
 * как здесь обращаются с папкой, профиль — как делают такой вид результата, паспорт — что это за
 * проект и для кого. Он принадлежит BB-проекту, а не папке: у проекта на двух машинах он один.
 */

export const PASSPORT_SECTIONS = [
  { key: "what", title: "Что это", hint: "Продукт или дело, папка, для кого. Две строки." },
  { key: "audience", title: "Кто пользуется", hint: "Аудитория, её язык и чего она ждёт." },
  { key: "decisions", title: "Устоявшиеся решения", hint: "Что уже выбрали и не пересматриваем." },
  { key: "limits", title: "Чего здесь не делают", hint: "Границы, запреты, больные места." },
  { key: "direction", title: "Куда идём", hint: "Цели периода, а не задачи дня." },
] as const;

export type PassportSectionKey = (typeof PASSPORT_SECTIONS)[number]["key"];

export type PassportSection = { key: PassportSectionKey; text: string };

export type ProjectPassport = {
  id: string;
  bbProjectId: string;
  /** Две-три строки «что это и для кого»: то, что доходит даже до механической работы. */
  header: string;
  sections: PassportSection[];
  /** Отпечаток материала, из которого собран: по нему видно, что материал с тех пор изменился. */
  sourceDigest: string;
  /** Сколько задач проекта было принято на момент сборки: отсюда считается следующий порог. */
  acceptedJobs: number;
  builtBy: "model" | "owner";
  /** Модель, которая собрала эту редакцию; у правки владельца пусто. */
  model: string | null;
  builtAt: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

/** Шапка доходит до всех, кому паспорт вообще положен: поэтому она короткая. */
export const PASSPORT_HEADER_LIMIT = 400;
/** Полный паспорт в промпте. Всё, что длиннее, — это уже знания, а не сводка. */
export const PASSPORT_FULL_LIMIT = 2_000;

/**
 * Сколько паспорта доходит до запуска. Тип роли — только значение по умолчанию: решает правило
 * работы, и владелец может изменить его отделу или отдельному сотруднику.
 */
export const PASSPORT_DELIVERIES = ["full", "header", "command"] as const;
export type PassportDelivery = (typeof PASSPORT_DELIVERIES)[number];

export const PASSPORT_DELIVERY_TITLES: Record<PassportDelivery, { title: string; hint: string }> = {
  full: { title: "Целиком", hint: "Все разделы. Тем, кто делит работу и судит результат." },
  header: { title: "Шапка", hint: "Что это и для кого, две-три строки. Достаточно, чтобы не сделать не то." },
  command: { title: "По команде", hint: "Одна строка с командой: паспорт читается, только если понадобился." },
};

/**
 * Команда, по которой сотрудник берёт паспорт целиком. Идентификатор проекта подставляется:
 * команда с «<проект>» внутри не выполняется, а сотруднику в запуске искать его негде.
 */
export function passportCommand(bbProjectId?: string): string {
  return `bb agency passport show --input-json '{"bbProjectId":"${bbProjectId ?? "<проект>"}"}'`;
}

/**
 * Сколько паспорта достаётся этому сотруднику. Своё значение сотрудника сильнее значения его
 * типа роли; тип роли неизвестен — работаем как с исполнителем, это середина.
 */
export function passportDeliveryFor(
  roleType: string | null,
  rules: {
    passportForLead: PassportDelivery;
    passportForExecutor: PassportDelivery;
    passportForReviewer: PassportDelivery;
    passportForAssistant: PassportDelivery;
    passportDelivery: PassportDelivery | null;
  },
): PassportDelivery {
  if (rules.passportDelivery) return rules.passportDelivery;
  if (roleType === "lead") return rules.passportForLead;
  if (roleType === "reviewer") return rules.passportForReviewer;
  if (roleType === "assistant") return rules.passportForAssistant;
  return rules.passportForExecutor;
}

export function sectionTitle(key: PassportSectionKey): string {
  return PASSPORT_SECTIONS.find((section) => section.key === key)?.title ?? key;
}

/** Непустые разделы в порядке паспорта: модель может промолчать по любому из них. */
export function filledSections(passport: Pick<ProjectPassport, "sections">): PassportSection[] {
  return PASSPORT_SECTIONS.map((section) => passport.sections.find((item) => item.key === section.key))
    .filter((section): section is PassportSection => Boolean(section?.text.trim()));
}

/**
 * Текст паспорта так, как его увидит сотрудник. Один источник для промпта и для предпросмотра в
 * интерфейсе: владелец правит паспорт и сразу видит, что доедет до запуска.
 */
export function passportText(
  passport: Pick<ProjectPassport, "header" | "sections"> & { bbProjectId?: string },
  mode: PassportDelivery,
): string | null {
  const command = passportCommand(passport.bbProjectId);
  const header = passport.header.trim().slice(0, PASSPORT_HEADER_LIMIT);
  const sections = filledSections(passport);
  if (!header && !sections.length) return null;
  if (mode === "command") {
    return `Паспорт проекта (что это за проект, для кого и чего здесь не делают): ${command}.`;
  }
  if (mode === "header") {
    return [`Паспорт проекта: ${header}`, `Остальные разделы: ${command}.`].filter(Boolean).join("\n");
  }
  const body = sections.map((section) => `### ${sectionTitle(section.key)}\n${section.text.trim()}`);
  return [`Паспорт проекта: ${header}`, ...body].join("\n").slice(0, PASSPORT_FULL_LIMIT);
}

/**
 * Настройки писаря паспорта: фоновая дешёвая модель, которая собирает сводку, не отвлекая
 * руководителя. Ключа здесь нет — только имя переменной, как у оценщика.
 */
export type PassportSettings = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  keySource: DecisionKeySource;
  keyName: string;
  timeoutMs: number;
  /** Через сколько принятых задач проекта паспорт пересобирается сам. */
  triggerEveryN: number;
  revision: number;
};

export const DEFAULT_PASSPORT_SETTINGS: PassportSettings = {
  enabled: false,
  baseUrl: "",
  // Дёшево, длинный контекст и связный русский: паспорт пишется словами, а не решениями.
  model: "deepseek/deepseek-v4.1-flash",
  keySource: "env-catalog",
  keyName: "OPENROUTER_API_KEY",
  timeoutMs: 40_000,
  triggerEveryN: 10,
  revision: 0,
};

export const PASSPORT_BASE_URL = "https://openrouter.ai/api/v1";

export { DECISION_KEY_SOURCES };
