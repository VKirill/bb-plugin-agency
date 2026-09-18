import { PASSPORT_BASE_URL, PASSPORT_HEADER_LIMIT, PASSPORT_SECTIONS, type PassportSection, type PassportSettings } from "../../shared/passport.js";
import { statusHint } from "../decisions/client.js";
import { resolveDecisionKey } from "../decisions/key.js";

/**
 * Писарь паспорта: один вызов дешёвой модели, который превращает накопленный материал проекта в
 * сводку из пяти разделов. Модель здесь ничего не решает — она сокращает. Всё, чего нет в
 * материале, в паспорт попасть не должно, и об этом сказано прямо в задании.
 *
 * Молчание, ошибка и таймаут равнозначны «не сейчас»: прежний паспорт остаётся в силе.
 */

export type PassportDraft = { header: string; sections: PassportSection[] };

export type PassportWriteOutcome =
  | { ok: true; draft: PassportDraft; ms: number; model: string }
  | { ok: false; reason: "disabled" | "no_key" | "no_material" | "request_failed" | "bad_answer" | "timeout"; detail?: string; ms: number };

const SYSTEM = [
  "Ты ведёшь паспорт проекта в системе управления ИИ-сотрудниками.",
  "Паспорт — это короткая сводка «что это за проект», которую читает сотрудник перед работой.",
  "Правила:",
  "1. Пиши только то, что подтверждено материалом. Ничего не додумывай и не обобщай сверх него.",
  "2. Правила проекта в материале — источник, по которому ты понимаешь, что это за проект и для кого. Опирайся на них, но не переписывай из них порядок работы, требования и запреты: они приходят сотруднику отдельным слоем.",
  "3. Путь к папке, имя машины и названия отделов сотрудник видит и без паспорта: шапку ими не занимай.",
  "4. Знания проекта приходят сотруднику отдельным списком. Не пересказывай их по одному: в паспорт идёт то, что верно для проекта в целом.",
  "5. Не пиши состояние дня, ход задач, числа отчётов и ничего, что устареет за неделю.",
  "6. Не переноси в паспорт ключи, пароли, токены и личные данные.",
  "7. Раздел, для которого в материале нет опоры, оставь пустой строкой. Пустой раздел лучше выдуманного, а оговорки «в материале не сказано» не пиши вовсе.",
  "8. Русский язык, простые слова, без вводных оборотов и без похвал проекту.",
  `9. Шапка — две-три строки, не длиннее ${PASSPORT_HEADER_LIMIT} знаков: что это за дело и для кого оно.`,
  "10. Каждый раздел — не больше четырёх строк.",
].join("\n");

const schema = {
  type: "object",
  properties: {
    header: { type: "string" },
    ...Object.fromEntries(PASSPORT_SECTIONS.map((section) => [section.key, { type: "string" }])),
  },
  required: ["header", ...PASSPORT_SECTIONS.map((section) => section.key)],
  additionalProperties: false,
};

function userMessage(material: string, previous: PassportDraft | null): string {
  const before = previous
    ? [
        "Прежний паспорт (перепиши его по материалу: что подтвердилось — оставь, что изменилось — поправь, чего больше нет в материале — убери):",
        previous.header,
        ...previous.sections.map((section) => `${section.key}: ${section.text}`),
        "",
      ]
    : ["Паспорта ещё нет: собери первый.", ""];
  return [
    ...before,
    "Материал проекта:",
    material,
    "",
    "Разделы паспорта:",
    ...PASSPORT_SECTIONS.map((section) => `${section.key} — ${section.title}: ${section.hint}`),
  ].join("\n");
}

export async function writePassportDraft(
  settings: PassportSettings,
  input: { material: string; previous: PassportDraft | null },
  deps: { fetch?: typeof fetch; key?: string } = {},
): Promise<PassportWriteOutcome> {
  const started = Date.now();
  const since = () => Date.now() - started;
  if (!settings.enabled) return { ok: false, reason: "disabled", ms: 0 };
  if (!input.material.trim()) return { ok: false, reason: "no_material", ms: 0 };

  const key = deps.key ?? (await resolveDecisionKey({ source: settings.keySource, name: settings.keyName }).then((found) => (found.ok ? found.value : null)));
  if (!key) return { ok: false, reason: "no_key", ms: since() };

  const call = deps.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  const base = (settings.baseUrl.trim() || PASSPORT_BASE_URL).replace(/\/+$/, "");
  try {
    const response = await call(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userMessage(input.material, input.previous) },
        ],
        response_format: { type: "json_schema", json_schema: { name: "project_passport", strict: true, schema } },
        // Рассуждение выключено намеренно: у дешёвых гибридных моделей оно съедает весь бюджет
        // ответа, и вместо паспорта возвращается пустой content. Здесь нечего выводить — модель
        // сокращает готовый материал.
        reasoning: { enabled: false },
        max_tokens: 1_200,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: "request_failed", detail: statusHint(response.status), ms: since() };
    const payload = (await response.json()) as Record<string, unknown>;
    const content = (payload.choices as { message?: { content?: unknown } }[] | undefined)?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) return { ok: false, reason: "bad_answer", detail: "пустой ответ", ms: since() };
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: "bad_answer", detail: "ответ не разобран", ms: since() };
    }
    const header = typeof parsed.header === "string" ? parsed.header.trim() : "";
    const sections = PASSPORT_SECTIONS.map((section) => ({
      key: section.key,
      text: typeof parsed[section.key] === "string" ? (parsed[section.key] as string).trim() : "",
    })).filter((section) => section.text);
    if (!header && !sections.length) return { ok: false, reason: "bad_answer", detail: "паспорт пустой", ms: since() };
    return { ok: true, draft: { header, sections }, ms: since(), model: settings.model };
  } catch (error) {
    const aborted = (error as { name?: string }).name === "AbortError";
    return { ok: false, reason: aborted ? "timeout" : "request_failed", detail: aborted ? undefined : String((error as Error).message ?? error).slice(0, 200), ms: since() };
  } finally {
    clearTimeout(timer);
  }
}
