import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { getDecisionSettings, saveDecisionSettings } from "../src/server/decisions/settings";
import { askDecisions } from "../src/server/decisions/client";
import { askMemoryGate } from "../src/server/decisions/memory-gate";
import { askBriefing, askBriefingDetailed, BRIEFING_POINT } from "../src/server/decisions/briefing";
import { askIntake, askIntakeDetailed, activityHasIntake, recordLeadIntake, INTAKE_POINT } from "../src/server/decisions/intake";
import { askHandInGate, HAND_IN_GATE_POINT } from "../src/server/decisions/hand-in-gate";
import { appendDecisionLog, listDecisionLog } from "../src/server/decisions/log";
import { probeDecisionPoints } from "../src/server/decisions/probe";
import { DEFAULT_DECISION_SETTINGS, type DecisionSettings } from "../src/shared/decisions";
import { proposeLessonForJob } from "../src/server/knowledge/lessons";
import { listKnowledge } from "../src/server/knowledge/store";
import { seed } from "./role-types.test";

const NOW = "2026-09-20T10:00:00.000Z";
const ON: DecisionSettings = { ...DEFAULT_DECISION_SETTINGS, enabled: true, revision: 1 };
/** Обычная модель через чат: у неё другой эндпоинт и другая форма ответа. */
const CHAT: DecisionSettings = { ...ON, endpointKind: "openrouter" };

/** Ответ модели в чат-форме: content с JSON по нашей схеме. */
function chatReply(answers: Record<string, { value: unknown; confidence: number }>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(answers) } }] }),
  } as unknown as Response;
}

describe("decision model settings", () => {
  it("keeps only the name of the key and refuses to switch on without one", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    expect(getDecisionSettings(db).enabled).toBe(false);

    const empty = saveDecisionSettings(db, { expectedRevision: 0, enabled: true, endpointKind: "openrouter", model: "typesafe/jev-1.13", keySource: "env-catalog", keyName: "  " }, NOW);
    expect(empty.ok).toBe(false);

    const saved = saveDecisionSettings(
      db,
      { expectedRevision: 0, enabled: true, endpointKind: "openrouter", model: "typesafe/jev-1.13", keySource: "env-catalog", keyName: "OPENROUTER_API_KEY", points: ["memory-gate", "выдумка"] },
      NOW,
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    // Неизвестная точка решения не сохраняется: включать нечего.
    expect(saved.value.points).toEqual(["memory-gate"]);
    expect(saved.value.revision).toBe(1);
    // Ключа в базе нет и быть не должно: там только имя переменной.
    const dump = JSON.stringify(db.prepare(`SELECT * FROM agency_decision_settings`).all());
    expect(dump).toContain("OPENROUTER_API_KEY");
    expect(dump).not.toMatch(/sk-|Bearer/);
  });

  it("refuses a stale revision", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const first = saveDecisionSettings(db, { expectedRevision: 0, enabled: false, endpointKind: "openrouter", model: "m", keySource: "machine-env", keyName: "K" }, NOW);
    expect(first.ok).toBe(true);
    expect(saveDecisionSettings(db, { expectedRevision: 0, enabled: false, endpointKind: "openrouter", model: "m", keySource: "machine-env", keyName: "K" }, NOW).ok).toBe(false);
  });
});

describe("asking the decision model", () => {
  it("sends the chat shape and returns typed answers with their confidence", async () => {
    const fetchMock = vi.fn(async () => chatReply({ keep: { value: true, confidence: 0.91 }, kind: { value: "lesson", confidence: 0.8 } }));
    const outcome = await askDecisions(
      CHAT,
      {
        state: "Запись отдела.",
        questions: [
          { id: "keep", kind: "bool", prompt: "Хранить?" },
          { id: "kind", kind: "choice", prompt: "Вид?", choices: ["lesson", "fact"] },
        ],
      },
      { fetch: fetchMock as unknown as typeof fetch, key: "test-key" },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.answers).toEqual([
      { id: "keep", value: true, confidence: 0.91 },
      { id: "kind", value: "lesson", confidence: 0.8 },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(body.response_format.json_schema.schema.properties.kind.properties.value.enum).toEqual(["lesson", "fact"]);
  });

  it("sends the decisions shape where a model of decisions lives, not the chat endpoint", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        answers: {
          keep: { type: "noul", noul: 0.23 },
          kind: { type: "choice", choice: "lesson", probabilities: { lesson: 0.9, fact: 0.1 }, confidence: 0.9 },
          importance: { type: "score", score: 0.5, confidence: 0.4 },
        },
      }),
    }) as unknown as Response);
    const outcome = await askDecisions(
      { ...ON, endpointKind: "openrouter-decisions" },
      {
        state: "Запись.",
        questions: [
          { id: "keep", kind: "bool", prompt: "Хранить?" },
          { id: "kind", kind: "choice", prompt: "Вид?", choices: ["lesson", "fact"], descriptions: { lesson: "вывод из задачи" } },
          { id: "importance", kind: "score", prompt: "Насколько важно?", min: 0, max: 100 },
        ],
      },
      { fetch: fetchMock as unknown as typeof fetch, key: "test-key" },
    );
    // Вероятность «да» 0.23 читается как «нет» с уверенностью 0.77: отдельного поля уверенности у noul нет.
    expect(outcome.ok && outcome.answers).toEqual([
      { id: "keep", value: false, confidence: 0.77 },
      { id: "kind", value: "lesson", confidence: 0.9 },
      // Шкала приходит долей 0–1 и разворачивается в наши границы.
      { id: "importance", value: 50, confidence: 0.4 },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    const body = JSON.parse(String(init.body));
    expect(body.state).toBe("Запись.");
    expect(body.messages).toBeUndefined();
    expect(body.questions.keep).toEqual({ type: "noul", instructions: "Хранить?" });
    expect(body.questions.kind).toEqual({ type: "choice", instructions: "Вид?", criteria: { lesson: "вывод из задачи", fact: "fact" } });
    expect(body.questions.importance.criteria).toHaveLength(3);
  });

  it("names what a status code means instead of leaving a bare number", async () => {
    const question = { state: "x", questions: [{ id: "keep", kind: "bool" as const, prompt: "Хранить?" }] };
    const wrongKey = await askDecisions(ON, question, { key: "k", fetch: (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch });
    expect(wrongKey.ok === false && wrongKey.detail).toContain("ключ не подходит");
    const wrongEndpoint = await askDecisions(ON, question, { key: "k", fetch: (async () => ({ ok: false, status: 400, json: async () => ({}) })) as unknown as typeof fetch });
    expect(wrongEndpoint.ok === false && wrongEndpoint.detail).toContain("не то подключение");
  });

  it("treats a refusal, a broken answer and being switched off the same way: as «don't know»", async () => {
    const question = { state: "x", questions: [{ id: "keep", kind: "bool" as const, prompt: "Хранить?" }] };
    const off = await askDecisions({ ...ON, enabled: false }, question, { key: "k" });
    expect(off.ok).toBe(false);

    const failed = await askDecisions(ON, question, { key: "k", fetch: (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch });
    expect(failed.ok === false && failed.reason).toBe("request_failed");

    const garbage = await askDecisions(ON, question, {
      key: "k",
      fetch: (async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "не json" } }] }) })) as unknown as typeof fetch,
    });
    expect(garbage.ok === false && garbage.reason).toBe("bad_answer");

    // Ответ не по нашей схеме — тоже отказ: применять половину решения нельзя.
    const wrong = await askDecisions(ON, question, { key: "k", fetch: (async () => chatReply({ keep: { value: "может быть", confidence: 1 } })) as unknown as typeof fetch });
    expect(wrong.ok === false && wrong.reason).toBe("bad_answer");
  });
});

describe("the memory gatekeeper", () => {
  const draft = { title: "Урок из AG-12", summary: "Возвращали за тесты.", body: "Тело урока." };

  it("stops a record with a secret and names the reason", async () => {
    const verdict = await askMemoryGate(CHAT, draft, [], {
      key: "k",
      fetch: (async () =>
        chatReply({
          keep: { value: true, confidence: 0.9 },
          secret: { value: true, confidence: 0.95 },
          transient: { value: false, confidence: 0.9 },
          kind: { value: "lesson", confidence: 0.9 },
          importance: { value: 60, confidence: 0.9 },
        })) as unknown as typeof fetch,
    });
    expect(verdict?.keep).toBe(false);
    expect(verdict?.reason).toContain("ключ или пароль");
  });

  it("ignores an answer it is not sure about", async () => {
    const verdict = await askMemoryGate(CHAT, draft, [], {
      key: "k",
      fetch: (async () =>
        chatReply({
          // Уверенность ниже порога точки: решение остаётся за правилами Агентства.
          keep: { value: false, confidence: 0.4 },
          secret: { value: false, confidence: 0.4 },
          transient: { value: false, confidence: 0.4 },
          kind: { value: "fact", confidence: 0.4 },
          importance: { value: 10, confidence: 0.4 },
        })) as unknown as typeof fetch,
    });
    expect(verdict?.keep).toBe(true);
    expect(verdict?.kind).toBeNull();
    expect(verdict?.importance).toBeNull();
  });

  it("stays out of the way when the owner did not switch its point on", async () => {
    const fetchMock = vi.fn();
    expect(await askMemoryGate({ ...CHAT, points: [] }, draft, [], { key: "k", fetch: fetchMock as unknown as typeof fetch })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a lesson and the gatekeeper's verdict", () => {
  it("does not write a rejected lesson and reports why", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const main = s.job("Задача с уроком", s.developer);
    const written = proposeLessonForJob(db, main.id, NOW, {
      autoLearn: true,
      verdict: { keep: false, reason: "Это состояние на сегодня.", importance: null, duplicateOf: null },
    });
    expect(written.ok && written.value.proposed).toBeNull();
    expect(written.ok && written.value.rejected).toContain("состояние на сегодня");
    expect(listKnowledge(db)).toHaveLength(0);
  });

  it("takes the suggested importance and keeps writing when the model stays silent", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const main = s.job("Важная задача", s.developer);
    const written = proposeLessonForJob(db, main.id, NOW, { autoLearn: true, verdict: { keep: true, reason: null, importance: 90, duplicateOf: null } });
    expect(written.ok && written.value.proposed?.importance).toBe(90);

    // Оценщик молчит — пишем как раньше, со своей важностью по умолчанию.
    const other = openMigratedDatabase(new Database(":memory:"));
    const rest = seed(other);
    const quiet = proposeLessonForJob(other, rest.job("Без оценщика", rest.developer).id, NOW, { autoLearn: true, verdict: null });
    expect(quiet.ok && quiet.value.proposed?.importance).toBe(60);
  });
});

describe("the launch briefing", () => {
  const job = { key: "AG-31", title: "Статья про кокон", brief: "Написать статью по нашему методу.", acceptance: "Статья прошла вычитку." };
  const lesson = (id: string, title: string) =>
    ({ id, title, summary: `${title}.`, body: "Тело.", kind: "lesson", importance: 50, pinned: false, writeReason: "", readCount: 0, lastReadAt: null, source: "Тест", scopeKind: "department", scopeId: "dep_1", status: "accepted", proposedBy: null, revision: 1, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }) as never;
  const ready = { ...CHAT, points: [BRIEFING_POINT] };

  it("names the skills and records the model picked, and leaves the rest out", async () => {
    const briefing = await askBriefing(
      ready,
      { job, skills: [{ id: "s1", name: "ru-text" }, { id: "s2", name: "telegram-ads" }], lessons: [lesson("kno_1", "Вычитка обязательна"), lesson("kno_2", "Отчёт по рекламе")] },
      {
        key: "k",
        fetch: (async () =>
          chatReply({
            s0: { value: true, confidence: 0.9 },
            s1: { value: false, confidence: 0.9 },
            k0: { value: true, confidence: 0.8 },
            k1: { value: false, confidence: 0.85 },
          })) as unknown as typeof fetch,
      },
    );
    expect(briefing?.skills.map((skill) => skill.name)).toEqual(["ru-text"]);
    expect(briefing?.lessons.map((item) => item.id)).toEqual(["kno_1"]);
    expect(briefing?.text).toContain("ru-text");
    expect(briefing?.text).toContain("Вычитка обязательна");
    // Ненужное не попадает в промпт: иначе подсказка ничем не лучше полного списка.
    expect(briefing?.text).not.toContain("telegram-ads");
    expect(briefing?.text).toContain("не приказ");
  });

  it("stays silent when nothing fits or the model is unsure", async () => {
    const nothing = await askBriefing(ready, { job, skills: [{ id: "s1", name: "ru-text" }], lessons: [] }, {
      key: "k",
      fetch: (async () => chatReply({ s0: { value: false, confidence: 0.99 } })) as unknown as typeof fetch,
    });
    expect(nothing).toBeNull();

    const unsure = await askBriefing(ready, { job, skills: [{ id: "s1", name: "ru-text" }], lessons: [] }, {
      key: "k",
      fetch: (async () => chatReply({ s0: { value: true, confidence: 0.3 } })) as unknown as typeof fetch,
    });
    expect(unsure).toBeNull();

    // Живой AG-78: ru-text да@64 при пороге 0.65 выбрасывался. 0.6 это оставляет.
    const barely = await askBriefing(ready, { job, skills: [{ id: "s1", name: "ru-text" }], lessons: [] }, {
      key: "k",
      fetch: (async () => chatReply({ s0: { value: true, confidence: 0.64 } })) as unknown as typeof fetch,
    });
    expect(barely?.skills.map((skill) => skill.name)).toEqual(["ru-text"]);
  });

  it("keeps a short skill list even when every skill is needed: that is the hint", async () => {
    const briefing = await askBriefing(
      ready,
      { job, skills: [{ id: "s1", name: "ru-text" }, { id: "s2", name: "telegram-ads" }], lessons: [] },
      {
        key: "k",
        fetch: (async () =>
          chatReply({
            s0: { value: true, confidence: 0.9 },
            s1: { value: true, confidence: 0.9 },
          })) as unknown as typeof fetch,
      },
    );
    expect(briefing?.skills.map((skill) => skill.name)).toEqual(["ru-text", "telegram-ads"]);
  });

  it("drops a pick that covers more than half of a long list: that is not a hint, that is the list again", async () => {
    const briefing = await askBriefing(
      ready,
      {
        job,
        skills: [
          { id: "s1", name: "ru-text" },
          { id: "s2", name: "dataviz" },
          { id: "s3", name: "seo" },
          { id: "s4", name: "ads" },
        ],
        lessons: [lesson("kno_1", "Первая"), lesson("kno_2", "Вторая"), lesson("kno_3", "Третья"), lesson("kno_4", "Четвёртая")],
      },
      {
        key: "k",
        fetch: (async () =>
          chatReply({
            s0: { value: true, confidence: 0.9 },
            s1: { value: true, confidence: 0.9 },
            s2: { value: true, confidence: 0.9 },
            s3: { value: false, confidence: 0.9 },
            k0: { value: true, confidence: 0.9 },
            k1: { value: false, confidence: 0.9 },
            k2: { value: false, confidence: 0.9 },
            k3: { value: false, confidence: 0.9 },
          })) as unknown as typeof fetch,
      },
    );
    // Три из четырёх навыков «нужны» — сигнала нет; одна запись из четырёх — сигнал есть.
    expect(briefing?.skills).toEqual([]);
    expect(briefing?.lessons.map((item) => item.id)).toEqual(["kno_1"]);
    expect(briefing?.text).not.toContain("Навыки");
  });

  it("opens a skill from the department library for this job and reports it separately", async () => {
    const briefing = await askBriefing(
      ready,
      {
        job: { key: "AG-42", title: "Полный аудит сайта", brief: "Технический и контентный аудит.", acceptance: "Отчёт с приоритетами." },
        skills: [{ id: "s1", name: "ru-text" }, { id: "s2", name: "dataviz" }],
        pool: [{ id: "p1", name: "drmax", description: "аудит сайта" }, { id: "p2", name: "telegram-ads" }],
        lessons: [],
      },
      {
        key: "k",
        fetch: (async () =>
          chatReply({
            s0: { value: true, confidence: 0.9 },
            s1: { value: false, confidence: 0.9 },
            // Порог выдачи выше обычного: 0.55 его не проходит, 0.95 проходит.
            p0: { value: true, confidence: 0.95 },
            p1: { value: true, confidence: 0.55 },
          })) as unknown as typeof fetch,
      },
    );
    expect(briefing?.granted.map((row) => row.skill.name)).toEqual(["drmax"]);
    expect(briefing?.skills.map((skill) => skill.name)).toEqual(["ru-text"]);
    expect(briefing?.text).toContain("Открыты для этой задачи из библиотеки отдела: drmax");
    expect(briefing?.text).toContain("журнал выдач");
    // Навык, в котором оценщик не уверен, не открывается: права — не место для «на всякий случай».
    expect(briefing?.text).not.toContain("telegram-ads");
  });

  it("does not ask at all when the point is off or there is nothing to pick from", async () => {
    const fetchMock = vi.fn();
    expect(await askBriefing({ ...CHAT, points: [] }, { job, skills: [{ id: "s", name: "ru-text" }], lessons: [] }, { key: "k", fetch: fetchMock as unknown as typeof fetch })).toBeNull();
    expect(await askBriefing(ready, { job, skills: [], lessons: [] }, { key: "k", fetch: fetchMock as unknown as typeof fetch })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await askBriefingDetailed(ready, { job, skills: [], lessons: [] }, { key: "k", fetch: fetchMock as unknown as typeof fetch })).reason).toBe("empty");
  });

  it("records silence with answers when the model picks nothing", async () => {
    const silent = await askBriefingDetailed(ready, { job, skills: [{ id: "s1", name: "ru-text" }], lessons: [] }, {
      key: "k",
      fetch: (async () => chatReply({ s0: { value: false, confidence: 0.99 } })) as unknown as typeof fetch,
    });
    expect(silent.briefing).toBeNull();
    expect(silent.reason).toBe("silent");
    expect(silent.answers).toContain("s0=false");
    expect(silent.candidates).toEqual({ skills: 1, pool: 0, lessons: 0 });
  });
});

describe("intake assessment", () => {
  const job = { key: "AG-40", title: "Кнопка цвета", brief: "Поменять цвет кнопки в карточке.", acceptance: "Цвет совпадает с макетом." };
  const ready = { ...CHAT, points: [INTAKE_POINT] };

  it("writes only when all three answers are confident", async () => {
    const proposal = await askIntake(ready, job, {
      key: "k",
      fetch: (async () =>
        chatReply({
          size: { value: "S", confidence: 0.9 },
          risk: { value: "low", confidence: 0.88 },
          decision: { value: "accept", confidence: 0.85 },
        })) as unknown as typeof fetch,
    });
    expect(proposal).toEqual({ size: "S", risk: "low", decision: "accept", ms: expect.any(Number), answers: "size=S@90,risk=low@88,decision=accept@85" });

    const partial = await askIntake(ready, job, {
      key: "k",
      fetch: (async () =>
        chatReply({
          size: { value: "L", confidence: 0.9 },
          risk: { value: "high", confidence: 0.2 },
          decision: { value: "split", confidence: 0.9 },
        })) as unknown as typeof fetch,
    });
    expect(partial).toBeNull();

    const traced = await askIntakeDetailed(ready, job, {
      key: "k",
      fetch: (async () =>
        chatReply({
          size: { value: "L", confidence: 0.9 },
          risk: { value: "high", confidence: 0.2 },
          decision: { value: "split", confidence: 0.9 },
        })) as unknown as typeof fetch,
    });
    expect(traced.reason).toBe("unconfident");
    expect(traced.answers).toContain("size=L@90");
    expect(traced.ms).toBeGreaterThanOrEqual(0);
  });

  it("tells the model the work kind and not to accept a new program into code", async () => {
    let body = "";
    await askIntake(ready, { ...job, workKind: "new-program" }, {
      key: "k",
      fetch: (async (_url: string, init?: RequestInit) => {
        body = String(init?.body ?? "");
        return chatReply({
          size: { value: "L", confidence: 0.9 },
          risk: { value: "medium", confidence: 0.88 },
          decision: { value: "split", confidence: 0.85 },
        });
      }) as unknown as typeof fetch,
    });
    expect(body).toContain("new-program");
    expect(body).toContain("отдел спецификаций");
  });

  it("records a lead proposal and leaves an executor launch alone", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const leadJob = s.job("Вход", s.lead);
    const traces: Array<{ outcome: string; detail: string }> = [];
    const written = await recordLeadIntake({
      settings: ready,
      job: leadJob,
      store: s.store,
      ctx: s.ctx,
      log: (entry) => traces.push({ outcome: entry.outcome, detail: entry.detail }),
      ask: async () => ({ size: "M", risk: "medium", decision: "split", ms: 12, answers: "size=M@90" }),
    });
    expect(written).toBe("written");
    expect(traces).toEqual([{ outcome: "written", detail: "M/medium/split" }]);
    expect(activityHasIntake(s.store.listActivity(leadJob.id))).toBe(true);
    const again = await recordLeadIntake({
      settings: ready,
      job: leadJob,
      store: s.store,
      ctx: s.ctx,
      ask: async () => ({ size: "S", risk: "low", decision: "accept", ms: 8, answers: "" }),
    });
    expect(again).toBe("skipped");

    const execJob = s.job("Код", s.developer);
    const skipped = await recordLeadIntake({
      settings: ready,
      job: execJob,
      store: s.store,
      ctx: s.ctx,
      ask: async () => ({ size: "S", risk: "low", decision: "accept", ms: 8, answers: "" }),
    });
    expect(skipped).toBe("skipped");
    expect(activityHasIntake(s.store.listActivity(execJob.id))).toBe(false);
    db.close();
  });
});

describe("hand-in gate", () => {
  const job = { key: "AG-41", title: "Реализация", brief: "Сделать кнопку.", acceptance: "Тесты зелёные, отчёт опубликован." };
  const ready = { ...CHAT, points: [HAND_IN_GATE_POINT] };

  it("returns rework only on confident junk and stays silent otherwise", async () => {
    const junk = await askHandInGate(ready, job, "готово наверное", {
      key: "k",
      fetch: (async () =>
        chatReply({
          complete: { value: false, confidence: 0.92 },
          junk: { value: true, confidence: 0.9 },
          verdict: { value: "rework", confidence: 0.88 },
        })) as unknown as typeof fetch,
    });
    expect(junk?.action).toBe("rework");
    if (junk?.action === "rework") expect(junk.remark).toContain("Оценщик");

    const proceed = await askHandInGate(ready, job, "Отчёт опубликован, npm test зелёный.", {
      key: "k",
      fetch: (async () =>
        chatReply({
          complete: { value: true, confidence: 0.9 },
          junk: { value: false, confidence: 0.91 },
          verdict: { value: "proceed", confidence: 0.87 },
        })) as unknown as typeof fetch,
    });
    expect(proceed?.action).toBe("proceed");

    const unsure = await askHandInGate(ready, job, "Сдал.", {
      key: "k",
      fetch: (async () =>
        chatReply({
          complete: { value: false, confidence: 0.2 },
          junk: { value: true, confidence: 0.3 },
          verdict: { value: "rework", confidence: 0.4 },
        })) as unknown as typeof fetch,
    });
    expect(unsure?.action).toBe("proceed");
  });
});

describe("decision log", () => {
  it("stores a row without the brief and keeps newest first", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    expect(appendDecisionLog(db, { point: "intake", jobKey: "AG-1", outcome: "written", detail: "S/low/accept", answers: "size=S@91", ms: 40 }, NOW)?.outcome).toBe("written");
    appendDecisionLog(db, { point: "hand-in-gate", jobKey: "AG-2", outcome: "rework", detail: "junk", ms: 55 }, "2026-09-20T10:01:00.000Z");
    const rows = listDecisionLog(db, 10);
    expect(rows.map((row) => row.point)).toEqual(["hand-in-gate", "intake"]);
    expect(JSON.stringify(rows)).not.toMatch(/секрет|sk-|brief/i);
    db.close();
  });

  it("probes intake and both hand-ins on the live question shape", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const text = String(init?.body ?? "");
      if (text.includes("Какой это размер")) {
        return chatReply({
          size: { value: "S", confidence: 0.9 },
          risk: { value: "low", confidence: 0.9 },
          decision: { value: "accept", confidence: 0.9 },
        });
      }
      if (text.includes("типа готово")) {
        return chatReply({
          complete: { value: false, confidence: 0.9 },
          junk: { value: true, confidence: 0.9 },
          verdict: { value: "rework", confidence: 0.9 },
        });
      }
      if (text.includes("Нужен ли навык") || text.includes("Поможет ли навык")) {
        return chatReply({
          s0: { value: true, confidence: 0.9 },
          p0: { value: true, confidence: 0.92 },
        });
      }
      return chatReply({
        complete: { value: true, confidence: 0.9 },
        junk: { value: false, confidence: 0.9 },
        verdict: { value: "proceed", confidence: 0.9 },
      });
    });
    const probed = await probeDecisionPoints(
      { ...CHAT, points: [INTAKE_POINT, HAND_IN_GATE_POINT] },
      { key: "k", fetch: fetchMock as unknown as typeof fetch },
    );
    expect(probed.intake).toMatchObject({ size: "S", decision: "accept" });
    expect(probed.intakeTrace.reason).toBe("proposal");
    expect(probed.junk?.action).toBe("rework");
    expect(probed.solid?.action).toBe("proceed");
    expect(probed.briefing.reason).toBe("hint");
    expect(probed.briefing.skills).toEqual(["ru-text"]);
    expect(probed.briefing.granted).toEqual(["telegram-rich-messages"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});


