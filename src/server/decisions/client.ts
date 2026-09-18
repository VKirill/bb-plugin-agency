import { DECISION_BASE_URLS, DECISION_NATIVE_KINDS, type DecisionAnswer, type DecisionQuestion, type DecisionSettings } from "../../shared/decisions";
import { resolveDecisionKey } from "./key";

/**
 * Вызов оценщика. Две формы запроса за одним интерфейсом:
 *
 * - **родная** (`typesafe`) — `{model, state, questions}`: модель читает состояние один раз и
 *   отвечает на все вопросы параллельно, каждый ответ со своей уверенностью;
 * - **через чат** (`openrouter`, `custom`) — обычный запрос с JSON-схемой ответа. Так работает
 *   любая модель провайдера, но уверенность модель называет сама, а не считает.
 *
 * Ответ оценщика — всегда предложение. Молчание, ошибка и таймаут равнозначны «не знаю»:
 * Агентство продолжает работать по своему правилу, а не останавливается.
 */

export type DecisionOutcome =
  | { ok: true; answers: DecisionAnswer[]; ms: number }
  | { ok: false; reason: "disabled" | "no_key" | "request_failed" | "bad_answer" | "timeout"; detail?: string; ms: number };

function endpointUrl(settings: DecisionSettings): string {
  const base = settings.baseUrl.trim() || DECISION_BASE_URLS[settings.endpointKind];
  const trimmed = base.replace(/\/+$/, "");
  if (settings.endpointKind === "typesafe") return `${trimmed}/systemone`;
  if (settings.endpointKind === "openrouter-decisions") return `${trimmed}/decisions`;
  return `${trimmed}/chat/completions`;
}

/** Вопрос в форме модели решений: у выбора описания вариантов, у шкалы — её ступени. */
function nativeQuestion(question: DecisionQuestion): Record<string, unknown> {
  if (question.kind === "choice") {
    return {
      type: "choice",
      instructions: question.prompt,
      criteria: Object.fromEntries(question.choices.map((choice) => [choice, question.descriptions?.[choice] ?? choice])),
    };
  }
  if (question.kind === "score") {
    return {
      type: "score",
      instructions: question.prompt,
      criteria: question.ladder ?? [`${question.min} — нет`, `${Math.round((question.min + question.max) / 2)} — отчасти`, `${question.max} — полностью`],
    };
  }
  // Noul — вероятность «да»: отдельного поля уверенности у него нет, её даёт сама вероятность.
  return { type: "noul", instructions: question.prompt };
}

/** Схема ответа для чат-формы: по вопросу — значение и уверенность, ничего лишнего. */
function answerSchema(questions: readonly DecisionQuestion[]) {
  const properties: Record<string, unknown> = {};
  for (const question of questions) {
    const value =
      question.kind === "choice"
        ? { type: "string", enum: [...question.choices] }
        : question.kind === "score"
          ? { type: "integer", minimum: question.min, maximum: question.max }
          : { type: "boolean" };
    properties[question.id] = {
      type: "object",
      properties: { value, confidence: { type: "number", minimum: 0, maximum: 1 } },
      required: ["value", "confidence"],
      additionalProperties: false,
    };
  }
  return { type: "object", properties, required: questions.map((question) => question.id), additionalProperties: false };
}

function questionLine(question: DecisionQuestion): string {
  if (question.kind === "choice") return `${question.id}: ${question.prompt} Выбор из: ${question.choices.join(", ")}.`;
  if (question.kind === "score") return `${question.id}: ${question.prompt} Число от ${question.min} до ${question.max}.`;
  return `${question.id}: ${question.prompt} Да или нет.`;
}

function parseAnswers(payload: unknown, questions: readonly DecisionQuestion[]): DecisionAnswer[] | null {
  if (!payload || typeof payload !== "object") return null;
  const source = payload as Record<string, unknown>;
  const answers: DecisionAnswer[] = [];
  for (const question of questions) {
    const raw = source[question.id];
    if (!raw || typeof raw !== "object") return null;
    const { value, confidence } = raw as { value?: unknown; confidence?: unknown };
    const okValue =
      question.kind === "choice"
        ? typeof value === "string" && question.choices.includes(value)
        : question.kind === "score"
          ? typeof value === "number" && Number.isFinite(value)
          : typeof value === "boolean";
    if (!okValue) return null;
    answers.push({
      id: question.id,
      value: value as string | number | boolean,
      // Модель без калиброванной вероятности своей уверенности не знает: считаем её средней.
      confidence: typeof confidence === "number" && confidence >= 0 && confidence <= 1 ? confidence : 0.5,
    });
  }
  return answers;
}

/**
 * Ответ модели решений: карта по id вопроса. `noul` — вероятность «да»: значение берём по
 * стороне вероятности, уверенностью служит она сама. `score` приходит долей 0–1 по ступеням
 * шкалы, поэтому разворачиваем его обратно в наши границы.
 */
function parseNative(payload: unknown, questions: readonly DecisionQuestion[]): DecisionAnswer[] | null {
  const answers = (payload as { answers?: unknown })?.answers;
  if (!answers || typeof answers !== "object") return null;
  const source = answers as Record<string, Record<string, unknown> | undefined>;
  const result: DecisionAnswer[] = [];
  for (const question of questions) {
    const row = source[question.id];
    if (!row) return null;
    const confidence = typeof row.confidence === "number" ? row.confidence : null;
    if (question.kind === "bool") {
      const probability = typeof row.noul === "number" ? row.noul : null;
      if (probability === null) return null;
      result.push({ id: question.id, value: probability >= 0.5, confidence: Math.max(probability, 1 - probability) });
      continue;
    }
    if (question.kind === "choice") {
      const choice = typeof row.choice === "string" ? row.choice : null;
      if (choice === null || !question.choices.includes(choice)) return null;
      result.push({ id: question.id, value: choice, confidence: confidence ?? 0.5 });
      continue;
    }
    const share = typeof row.score === "number" ? row.score : null;
    if (share === null) return null;
    const scaled = question.min + Math.max(0, Math.min(1, share)) * (question.max - question.min);
    result.push({ id: question.id, value: Math.round(scaled), confidence: confidence ?? 0.5 });
  }
  return result;
}

export async function askDecisions(
  settings: DecisionSettings,
  request: { state: string; questions: readonly DecisionQuestion[] },
  deps: { fetch?: typeof fetch; key?: string } = {},
): Promise<DecisionOutcome> {
  const started = Date.now();
  const since = () => Date.now() - started;
  if (!settings.enabled) return { ok: false, reason: "disabled", ms: 0 };
  if (!request.questions.length) return { ok: true, answers: [], ms: 0 };

  const key = deps.key ?? (await resolveDecisionKey({ source: settings.keySource, name: settings.keyName }).then((found) => (found.ok ? found.value : null)));
  if (!key) return { ok: false, reason: "no_key", ms: since() };

  const native = DECISION_NATIVE_KINDS.includes(settings.endpointKind);
  const body = native
    ? {
        model: settings.model,
        state: request.state,
        questions: Object.fromEntries(request.questions.map((question) => [question.id, nativeQuestion(question)])),
      }
    : {
        model: settings.model,
        messages: [
          {
            role: "system",
            content: "Ты отвечаешь только решениями по заданной схеме. Для каждого вопроса верни значение и свою уверенность от 0 до 1. Ничего не объясняй словами.",
          },
          { role: "user", content: `Состояние:\n${request.state}\n\nВопросы:\n${request.questions.map(questionLine).join("\n")}` },
        ],
        response_format: { type: "json_schema", json_schema: { name: "decisions", strict: true, schema: answerSchema(request.questions) } },
        // Модели с рассуждением иначе тратят весь бюджет на размышление и возвращают пустоту.
        reasoning: { effort: "low" },
        max_tokens: 1_200,
      };

  const call = deps.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const response = await call(endpointUrl(settings), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: "request_failed", detail: statusHint(response.status), ms: since() };
    const payload = (await response.json()) as Record<string, unknown>;
    if (native) {
      const answers = parseNative(payload, request.questions);
      return answers ? { ok: true, answers, ms: since() } : { ok: false, reason: "bad_answer", ms: since() };
    }
    const content = (payload.choices as { message?: { content?: unknown } }[] | undefined)?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) return { ok: false, reason: "bad_answer", detail: "пустой ответ", ms: since() };
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { ok: false, reason: "bad_answer", detail: "ответ не разобран", ms: since() };
    }
    const answers = parseAnswers(parsed, request.questions);
    return answers ? { ok: true, answers, ms: since() } : { ok: false, reason: "bad_answer", detail: "ответ не по схеме", ms: since() };
  } catch (error) {
    const aborted = (error as { name?: string }).name === "AbortError";
    return { ok: false, reason: aborted ? "timeout" : "request_failed", detail: aborted ? undefined : String((error as Error).message ?? error).slice(0, 200), ms: since() };
  } finally {
    clearTimeout(timer);
  }
}

/** Что значит код ответа для владельца: он читает это в проверке связи, а не лезет в журнал. */
export function statusHint(status: number): string {
  if (status === 401 || status === 403) return `HTTP ${status}: ключ не подходит — проверьте переменную с ключом`;
  if (status === 402) return `HTTP ${status}: на счету провайдера кончились средства`;
  if (status === 404) return `HTTP ${status}: модели нет на этом подключении — проверьте имя модели и «куда обращаться»`;
  if (status === 400 || status === 422) return `HTTP ${status}: запрос не принят — возможно, выбрано не то подключение для этой модели`;
  if (status === 429) return `HTTP ${status}: слишком часто, провайдер ограничил запросы`;
  if (status >= 500) return `HTTP ${status}: провайдер не отвечает`;
  return `HTTP ${status}`;
}

/** Ответ по id, если оценщик уверен не меньше порога точки решения. */
export function confident(answers: readonly DecisionAnswer[], id: string, threshold: number): DecisionAnswer | null {
  const answer = answers.find((item) => item.id === id);
  return answer && answer.confidence >= threshold ? answer : null;
}
