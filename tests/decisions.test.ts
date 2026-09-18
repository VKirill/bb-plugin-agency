import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { getDecisionSettings, saveDecisionSettings } from "../src/server/decisions/settings";
import { askDecisions } from "../src/server/decisions/client";
import { askMemoryGate } from "../src/server/decisions/memory-gate";
import { DEFAULT_DECISION_SETTINGS, type DecisionSettings } from "../src/shared/decisions";
import { proposeLessonForJob } from "../src/server/knowledge/lessons";
import { listKnowledge } from "../src/server/knowledge/store";
import { seed } from "./role-types.test";

const NOW = "2026-09-20T10:00:00.000Z";
const ON: DecisionSettings = { ...DEFAULT_DECISION_SETTINGS, enabled: true, revision: 1 };

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
      ON,
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

  it("sends the native shape to System One, where questions are not a chat", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ answers: [{ id: "keep", value: false, confidence: 0.99 }] }),
    }) as unknown as Response);
    const outcome = await askDecisions(
      { ...ON, endpointKind: "typesafe" },
      { state: "Запись.", questions: [{ id: "keep", kind: "bool", prompt: "Хранить?" }] },
      { fetch: fetchMock as unknown as typeof fetch, key: "test-key" },
    );
    expect(outcome.ok && outcome.answers[0]).toEqual({ id: "keep", value: false, confidence: 0.99 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(String(init.body));
    expect(body.state).toBe("Запись.");
    expect(body.questions).toEqual([{ id: "keep", type: "bool", prompt: "Хранить?" }]);
    expect(body.messages).toBeUndefined();
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
    const verdict = await askMemoryGate(ON, draft, [], {
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
    const verdict = await askMemoryGate(ON, draft, [], {
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
    expect(await askMemoryGate({ ...ON, points: [] }, draft, [], { key: "k", fetch: fetchMock as unknown as typeof fetch })).toBeNull();
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
