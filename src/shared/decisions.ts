/**
 * Оценщик: быстрая модель, которая отвечает не текстом, а типизированным решением — выбор из
 * списка, оценка по шкале или да/нет, каждое со своей уверенностью.
 *
 * Такая модель не заменяет сотрудника: она закрывает точки, где Агентство и так принимает
 * решение по правилу, но правило грубое. Ответ всегда остаётся предложением: у каждой точки
 * решения есть порог уверенности, ниже которого ответ не применяется, а уходит человеку.
 */

/** Вопрос, на который оценщик отвечает типом, а не текстом. */
export type DecisionQuestion =
  | { id: string; kind: "choice"; prompt: string; choices: readonly string[] }
  | { id: string; kind: "score"; prompt: string; min: number; max: number }
  | { id: string; kind: "bool"; prompt: string };

export type DecisionAnswer = {
  id: string;
  /** Выбор, число или да/нет — по виду вопроса. */
  value: string | number | boolean;
  /** 0–1: насколько модель уверена. Ниже порога точки решения ответ не применяется. */
  confidence: number;
};

export type DecisionRequest = {
  /** Состояние, которое читает модель: текст записи, брифа, отчёта. */
  state: string;
  questions: readonly DecisionQuestion[];
};

/** Куда ходим за решением. `typesafe` — родной API System One, он не в формате чата. */
export const DECISION_ENDPOINT_KINDS = ["openrouter", "typesafe", "custom"] as const;
export type DecisionEndpointKind = (typeof DECISION_ENDPOINT_KINDS)[number];

/** Откуда берётся ключ. Сам ключ Агентство у себя не хранит — только имя. */
export const DECISION_KEY_SOURCES = ["env-catalog", "machine-env"] as const;
export type DecisionKeySource = (typeof DECISION_KEY_SOURCES)[number];

export type DecisionSettings = {
  enabled: boolean;
  endpointKind: DecisionEndpointKind;
  /** Пусто — адрес по умолчанию для выбранного вида. */
  baseUrl: string;
  model: string;
  keySource: DecisionKeySource;
  /** Имя переменной в Env Catalog или в окружении машины. */
  keyName: string;
  timeoutMs: number;
  /** Точки решения, включённые владельцем. */
  points: string[];
  revision: number;
};

export const DEFAULT_DECISION_SETTINGS: DecisionSettings = {
  enabled: false,
  endpointKind: "openrouter",
  baseUrl: "",
  // Jev отвечает решениями и ничего не пишет словами: это ровно наш случай.
  model: "typesafe/jev-1.13",
  keySource: "env-catalog",
  keyName: "OPENROUTER_API_KEY",
  timeoutMs: 8_000,
  points: ["memory-gate"],
  revision: 0,
};

export const DECISION_BASE_URLS: Record<DecisionEndpointKind, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  typesafe: "https://api.typesafe.ai/v1",
  custom: "",
};

/**
 * Точки, где Агентство спрашивает оценщика. Каждая включается отдельно: владелец видит, что
 * именно отдано модели, и может оставить решение себе.
 */
export type DecisionPoint = {
  key: string;
  title: string;
  /** Что именно спрашиваем и что делаем с ответом. */
  hint: string;
  /** Ниже этой уверенности ответ не применяется. */
  threshold: number;
};

export const DECISION_POINTS: readonly DecisionPoint[] = [
  {
    key: "memory-gate",
    title: "Привратник памяти",
    hint: "Перед записью урока в память отдела: хранить ли, какой это вид, нет ли в тексте секрета или временного статуса, не повтор ли это. Отказ и находка секрета останавливают запись, вид и важность приходят предложением.",
    threshold: 0.7,
  },
  {
    key: "launch-briefing",
    title: "Подсказка к запуску",
    hint: "Перед запуском задачи: какие из назначенных сотруднику навыков поднять под эту работу и какие записи памяти отдела к ней относятся. В задачу уходит короткая строка-подсказка; бриф и регламент остаются выше неё.",
    threshold: 0.65,
  },
];

export function decisionPoint(key: string): DecisionPoint | null {
  return DECISION_POINTS.find((point) => point.key === key) ?? null;
}
