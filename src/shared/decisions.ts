/**
 * Оценщик: быстрая модель, которая отвечает не текстом, а типизированным решением — выбор из
 * списка, оценка по шкале или да/нет, каждое со своей уверенностью.
 *
 * Такая модель не заменяет сотрудника: она закрывает точки, где Агентство и так принимает
 * решение по правилу, но правило грубое. Ответ всегда остаётся предложением: у каждой точки
 * решения есть порог уверенности, ниже которого ответ не применяется, а уходит человеку.
 */

/**
 * Вопрос, на который оценщик отвечает типом, а не текстом.
 *
 * `descriptions` и `ladder` нужны модели решений: у неё вариант выбора описывается словами, а
 * шкала — ступенями. Обычной модели они тоже не мешают — попадают в текст вопроса.
 */
export type DecisionQuestion =
  | { id: string; kind: "choice"; prompt: string; choices: readonly string[]; descriptions?: Readonly<Record<string, string>> }
  | { id: string; kind: "score"; prompt: string; min: number; max: number; ladder?: readonly string[] }
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

/**
 * Куда ходим за решением. Модель решений живёт не на чат-эндпоинте: у OpenRouter это
 * `/api/alpha/decisions`, у TypeSafe — `/v1/systemone`, и тело у них одинаковое. Обычная модель
 * отвечает через чат с JSON-схемой.
 */
export const DECISION_ENDPOINT_KINDS = ["openrouter", "openrouter-decisions", "typesafe", "custom"] as const;
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
  endpointKind: "openrouter-decisions",
  baseUrl: "",
  // Jev отвечает решениями и ничего не пишет словами: это ровно наш случай.
  model: "typesafe/jev-1.13",
  keySource: "env-catalog",
  keyName: "OPENROUTER_API_KEY",
  timeoutMs: 8_000,
  // Защитные точки включены сразу, необязательные — по выбору владельца: привратники ловят
  // секрет в тексте, который иначе уедет во все запуски.
  points: ["memory-gate", "passport-gate"],
  revision: 0,
};

export const DECISION_BASE_URLS: Record<DecisionEndpointKind, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  "openrouter-decisions": "https://openrouter.ai/api/alpha",
  typesafe: "https://api.typesafe.ai/v1",
  custom: "",
};

/** Подключения, где вопросы уходят картой и возвращаются ответами с вероятностями. */
export const DECISION_NATIVE_KINDS: readonly DecisionEndpointKind[] = ["openrouter-decisions", "typesafe"];

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
    hint: "Перед запуском: какие методические навыки сотрудника поднять, что открыть из библиотеки отдела и какие записи памяти отнести к делу. Молчание и пустой список пишутся в журнал. Бриф и регламент выше подсказки.",
    threshold: 0.6,
  },
  {
    key: "passport-gate",
    title: "Привратник паспорта",
    hint: "Перед тем как новая редакция паспорта проекта заменит прежнюю: нет ли в ней секрета, не состояние ли это дня и отличается ли она от прежней по существу. Секрет и состояние дня отменяют замену, совпадение с прежней — просто пропускает её.",
    threshold: 0.7,
  },
  {
    key: "intake",
    title: "Оценка на входе",
    hint: "Перед запуском руководителя: размер S/M/L, риск и решение accept/split/clarify/return. Смешанный продукт — split, не return. Пишет тот же комментарий с данными, что и руководитель. Это предложение: подзадачи не создаются, возврат и уточнение сами не блокируют. Ниже порога — молчание, оценку пишет руководитель.",
    threshold: 0.7,
  },
  {
    key: "hand-in-gate",
    title: "Привратник сдачи",
    hint: "Когда исполнитель сдаёт версию: выглядит ли сдача пустой или мимо брифа. Уверенный мусор возвращается тому же исполнителю в ту же сессию. Принятие независимую проверку не пропускает: неоднозначное — молчание, дальше обычный конвейер.",
    threshold: 0.7,
  },
];

export function decisionPoint(key: string): DecisionPoint | null {
  return DECISION_POINTS.find((point) => point.key === key) ?? null;
}
