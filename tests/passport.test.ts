import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { openMigratedDatabase } from "../src/server/db";
import { createDomainStore, type ServiceContext } from "../src/server/services";
import { saveKnowledge } from "../src/server/knowledge/store";
import { saveWorkProfile } from "../src/server/projects/work-profiles";
import { getPassport, listPassportVersions, rollbackPassport, writePassport } from "../src/server/projects/passport";
import { buildPassport, collectPassportMaterial, passportDue, projectsDueForPassport } from "../src/server/projects/passport-build";
import { savePassportSettings } from "../src/server/projects/passport-settings";
import { writePassportDraft } from "../src/server/projects/passport-writer";
import { askPassportGate } from "../src/server/decisions/passport-gate";
import { DEFAULT_DECISION_SETTINGS } from "../src/shared/decisions";
import { DEFAULT_PASSPORT_SETTINGS, passportDeliveryFor, passportText, PASSPORT_HEADER_LIMIT, type PassportSettings } from "../src/shared/passport";
import { DEFAULT_WORK_RULES } from "../src/shared/contracts/work-rules";

/**
 * Паспорт проекта — верхний слой памяти. Проверяем три вещи, в которых ошибка дорога: что в
 * промпт уходит ровно тот объём, который положен роли; что редакция применяется только через
 * привратника; и что прежнюю редакцию можно вернуть.
 */

const NOW = "2026-09-18T09:00:00.000Z";
const PROJECT = "proj_vech";

const draft = {
  header: "Плагин «Агентство» для BB: отделы ИИ-сотрудников, поручения и приёмка. Для владельца BB.",
  sections: [
    { key: "what" as const, text: "Плагин BB в папке bb-plugin-agency." },
    { key: "limits" as const, text: "Базу руками не правим: только миграцией." },
  ],
};

function seed() {
  const db = openMigratedDatabase(new Database(":memory:"));
  const store = createDomainStore(db);
  const bootstrap: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [] };
  const policy = store.createPolicyVersion(bootstrap, {
    requestId: randomUUID(),
    allowedCapabilities: ["read.files"],
    cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_mini"] },
    secretRefs: [],
  });
  if (!policy.ok) throw new Error(policy.error.message);
  const agent = (role: string) => {
    const created = store.provisionAgent(bootstrap, {
      requestId: randomUUID(),
      name: `Сотрудник ${role}`,
      state: "active",
      version: {
        version: 1,
        role,
        instructions: "Работать по брифу.",
        providerId: "codex",
        model: "gpt-5.6",
        skillIds: [],
        mcpIds: [],
        policyVersionId: policy.value.id,
      },
    });
    if (!created.ok) throw new Error(created.error.message);
    return created.value.agent;
  };
  const lead = agent("lead");
  const helper = agent("assistant");
  const department = store.provisionDepartment(bootstrap, {
    requestId: randomUUID(),
    name: "Разработка",
    leadAgentId: lead.id,
    process: { instructions: "Сделать и проверить.", acceptance: "Есть принятая версия.", reviewPolicy: { required: true } },
  });
  if (!department.ok) throw new Error(department.error.message);
  const membership = store.addMembership(bootstrap, {
    requestId: randomUUID(),
    departmentId: department.value.department.id,
    agentId: helper.id,
    role: "assistant",
    helpsAgentId: lead.id,
  });
  if (!membership.ok) throw new Error(membership.error.message);
  const binding = store.createProjectBinding(bootstrap, {
    requestId: randomUUID(),
    bbProjectId: PROJECT,
    environmentId: "env_ucx7sb57rs",
    hostId: "host_mini",
    canonicalRoot: "/work/agency",
    policyVersionId: policy.value.id,
    sectionId: null,
  });
  if (!binding.ok) throw new Error(binding.error.message);
  const ctx: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [binding.value.id] };
  const linked = store.linkDepartment(ctx, { requestId: randomUUID(), bindingId: binding.value.id, departmentId: department.value.department.id });
  if (!linked.ok) throw new Error(linked.error.message);
  return { db, store, ctx, lead, helper, department: department.value.department, binding: binding.value };
}

function addJob(seeded: ReturnType<typeof seed>, key: string, state: "done" | "backlog" = "done") {
  const created = seeded.store.createJob(seeded.ctx, {
    requestId: randomUUID(),
    key,
    bindingId: seeded.binding.id,
    departmentId: seeded.department.id,
    title: `Задача ${key}`,
    brief: "Собрать результат.",
    acceptance: "Результат принят владельцем.",
    parentJobId: null,
    assignedAgentId: seeded.lead.id,
    priority: "normal",
    dueAt: null,
  });
  if (!created.ok) throw new Error(created.error.message);
  if (state === "done") seeded.db.prepare(`UPDATE agency_job SET state = 'done' WHERE id = ?`).run(created.value.id);
  return created.value;
}

function enableWriter(db: ReturnType<typeof seed>["db"], triggerEveryN = 2) {
  const saved = savePassportSettings(
    db,
    { expectedRevision: 0, enabled: true, model: DEFAULT_PASSPORT_SETTINGS.model, keySource: "machine-env", keyName: "OPENROUTER_API_KEY", triggerEveryN },
    NOW,
  );
  if (!saved.ok) throw new Error(saved.error.message);
  return saved.value;
}

const stubWriter = (header = draft.header) =>
  async () => ({ ok: true as const, draft: { header, sections: draft.sections }, ms: 12, model: "stub/flash" });

describe("паспорт проекта", () => {
  it("хранит редакции и возвращает прежнюю", () => {
    const { db } = seed();
    const first = writePassport(db, { bbProjectId: PROJECT, ...draft, sourceDigest: "aaa", acceptedJobs: 1, builtBy: "model", model: "stub/flash", note: "Первая сборка" }, NOW);
    expect(first.ok && first.value.revision).toBe(1);
    const second = writePassport(
      db,
      { bbProjectId: PROJECT, header: "Другая шапка", sections: [{ key: "what", text: "Что-то ещё" }], sourceDigest: "bbb", acceptedJobs: 3, builtBy: "owner", note: "Правка владельца" },
      NOW,
    );
    expect(second.ok && second.value.revision).toBe(2);
    expect(listPassportVersions(db, PROJECT).map((version) => version.revision)).toEqual([2, 1]);

    const back = rollbackPassport(db, PROJECT, 1, NOW);
    expect(back.ok).toBe(true);
    const current = getPassport(db, PROJECT)!;
    expect(current.revision).toBe(3);
    expect(current.header).toBe(draft.header);
    expect(listPassportVersions(db, PROJECT)[0]!.note).toBe("Возврат к редакции 1");
  });

  it("правка владельца не проходит с чужой ревизией", () => {
    const { db } = seed();
    writePassport(db, { bbProjectId: PROJECT, ...draft, sourceDigest: "aaa", acceptedJobs: 0, builtBy: "model", note: "Сборка" }, NOW);
    const stale = writePassport(db, { bbProjectId: PROJECT, ...draft, sourceDigest: "aaa", acceptedJobs: 0, builtBy: "owner", note: "Правка", expectedRevision: 0 }, NOW);
    expect(stale.ok).toBe(false);
  });

  it("режет паспорт по объёму доставки", () => {
    const full = passportText(draft, "full")!;
    expect(full).toContain("Что это");
    expect(full).toContain("Базу руками не правим");

    const header = passportText(draft, "header")!;
    expect(header).toContain("Плагин «Агентство» для BB");
    expect(header).not.toContain("Базу руками не правим");

    const command = passportText(draft, "command")!;
    expect(command).toContain("bb agency passport show");
    expect(command).not.toContain("Плагин «Агентство» для BB");

    const long = passportText({ header: "я".repeat(PASSPORT_HEADER_LIMIT + 200), sections: [] }, "header")!;
    expect(long.length).toBeLessThan(PASSPORT_HEADER_LIMIT + 120);
  });

  it("объём доставки задаёт тип роли, а личное правило сильнее", () => {
    expect(passportDeliveryFor("lead", DEFAULT_WORK_RULES)).toBe("full");
    expect(passportDeliveryFor("reviewer", DEFAULT_WORK_RULES)).toBe("full");
    expect(passportDeliveryFor("executor", DEFAULT_WORK_RULES)).toBe("header");
    expect(passportDeliveryFor("assistant", DEFAULT_WORK_RULES)).toBe("command");
    expect(passportDeliveryFor(null, DEFAULT_WORK_RULES)).toBe("header");
    expect(passportDeliveryFor("assistant", { ...DEFAULT_WORK_RULES, passportDelivery: "full" })).toBe("full");
  });

  it("в запуск уходит столько паспорта, сколько положено сотруднику", () => {
    const seeded = seed();
    writePassport(seeded.db, { bbProjectId: PROJECT, ...draft, sourceDigest: "aaa", acceptedJobs: 0, builtBy: "model", note: "Сборка" }, NOW);

    const forLead = seeded.store.passportForLaunch(seeded.binding.id, seeded.department.id, seeded.lead.id, "host_mini")!;
    expect(forLead.mode).toBe("full");
    expect(forLead.text).toContain("Базу руками не правим");

    const forHelper = seeded.store.passportForLaunch(seeded.binding.id, seeded.department.id, seeded.helper.id, "host_mini")!;
    expect(forHelper.mode).toBe("command");
    expect(forHelper.text).toContain("bb agency passport show");

    const own = seeded.store.saveWorkRules(seeded.ctx, { requestId: randomUUID(), scope: `agent:${seeded.helper.id}`, expectedRevision: 0, rules: { passportDelivery: "full" } });
    expect(own.ok).toBe(true);
    expect(seeded.store.passportForLaunch(seeded.binding.id, seeded.department.id, seeded.helper.id, "host_mini")!.mode).toBe("full");
  });

  it("без паспорта слой проекта остаётся прежним", () => {
    const seeded = seed();
    expect(seeded.store.passportForLaunch(seeded.binding.id, seeded.department.id, seeded.lead.id, "host_mini")).toBeNull();
  });

  it("собирает материал из знаний, профилей и принятых задач", () => {
    const seeded = seed();
    addJob(seeded, "AG-1");
    saveKnowledge(
      seeded.db,
      { expectedRevision: 0, title: "Куда складывать отчёты", body: "Отчёты кладём в artifacts/.", source: "AG-1", scopeKind: "project", scopeId: seeded.binding.id, kind: "procedure" },
      { proposedBy: null },
      NOW,
    );
    saveWorkProfile(
      seeded.db,
      { bbProjectId: PROJECT, key: "release-note", expectedRevision: 0, title: "Заметка о выпуске", triggers: ["релиз"], body: "Коротко и по делу.", samples: [], acceptance: "" },
      NOW,
    );
    const material = collectPassportMaterial(seeded.db, PROJECT, "# Правила проекта\nПишем по-русски.");
    expect(material.text).toContain("/work/agency");
    // Правила проекта — материал, но не содержимое паспорта: об этом сказано прямо в задании.
    expect(material.text).toContain("Пишем по-русски");
    expect(material.text).toContain("Не переписывай их в паспорт");
    expect(material.text).toContain("Собрать результат");
    expect(material.text).toContain("Куда складывать отчёты");
    expect(material.text).toContain("release-note");
    expect(material.text).toContain("Задача AG-1");
    expect(material.acceptedJobs).toBe(1);
    expect(material.digest).toHaveLength(32);
  });

  it("сборка пишет редакцию, а повтор без изменений её не трогает", async () => {
    const seeded = seed();
    addJob(seeded, "AG-1");
    const settings = enableWriter(seeded.db);
    const deps = { settings, decisions: { ...{ enabled: false } } as never, write: stubWriter(), gate: async () => null };

    const built = await buildPassport(seeded.db, { bbProjectId: PROJECT, trigger: "auto" }, deps);
    expect(built.ok).toBe(true);
    const stored = getPassport(seeded.db, PROJECT)!;
    expect(stored.builtBy).toBe("model");
    expect(stored.model).toBe("stub/flash");
    expect(stored.acceptedJobs).toBe(1);

    const again = await buildPassport(seeded.db, { bbProjectId: PROJECT, trigger: "auto" }, deps);
    expect(again.ok).toBe(false);
    expect(!again.ok && again.reason).toBe("unchanged");
    // Кнопка владельца зовёт модель и без изменений материала, но ту же редакцию не пишет.
    const manual = await buildPassport(seeded.db, { bbProjectId: PROJECT, trigger: "manual" }, deps);
    expect(manual.ok).toBe(false);
    expect(!manual.ok && manual.reason).toBe("same_text");
    expect(getPassport(seeded.db, PROJECT)!.revision).toBe(1);

    // Другой текст от модели — новая редакция.
    const changed = await buildPassport(
      seeded.db,
      { bbProjectId: PROJECT, trigger: "manual" },
      { ...deps, write: stubWriter("Плагин «Агентство»: другая шапка после правок.") },
    );
    expect(changed.ok).toBe(true);
    expect(getPassport(seeded.db, PROJECT)!.revision).toBe(2);
  });

  it("отказ привратника оставляет в силе прежнюю редакцию", async () => {
    const seeded = seed();
    addJob(seeded, "AG-1");
    const settings = enableWriter(seeded.db);
    writePassport(seeded.db, { bbProjectId: PROJECT, ...draft, sourceDigest: "старый", acceptedJobs: 0, builtBy: "owner", note: "Правка владельца" }, NOW);

    const refused = await buildPassport(
      seeded.db,
      { bbProjectId: PROJECT, trigger: "manual" },
      {
        settings,
        decisions: { enabled: true } as never,
        write: stubWriter("Ключ OPENROUTER_API_KEY=sk-123"),
        gate: async () => ({ apply: false, reason: "В сводке нашёлся ключ или личные данные: редакция не применена.", ms: 5 }),
      },
    );
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toBe("refused");
    const stored = getPassport(seeded.db, PROJECT)!;
    expect(stored.revision).toBe(1);
    expect(stored.header).toBe(draft.header);
  });

  it("проект попадает в пересборку только после порога принятых задач", async () => {
    const seeded = seed();
    addJob(seeded, "AG-1");
    const settings = enableWriter(seeded.db, 3);
    expect(projectsDueForPassport(seeded.db, settings)).toEqual([PROJECT]);

    const built = await buildPassport(seeded.db, { bbProjectId: PROJECT, trigger: "auto" }, { settings, write: stubWriter(), gate: async () => null });
    expect(built.ok).toBe(true);
    expect(projectsDueForPassport(seeded.db, settings)).toEqual([]);

    addJob(seeded, "AG-2");
    addJob(seeded, "AG-3");
    expect(projectsDueForPassport(seeded.db, settings)).toEqual([]);
    addJob(seeded, "AG-4");
    expect(projectsDueForPassport(seeded.db, settings)).toEqual([PROJECT]);
  });

  it("правила проекта — материал, но не часть отпечатка", () => {
    const seeded = seed();
    addJob(seeded, "AG-1");
    const bare = collectPassportMaterial(seeded.db, PROJECT);
    const withRules = collectPassportMaterial(seeded.db, PROJECT, "# Правила\nПишем по-русски.");
    // Иначе недоступная машина выглядела бы как «материал изменился» и переписывала бы паспорт.
    expect(withRules.digest).toBe(bare.digest);
    expect(withRules.text.length).toBeGreaterThan(bare.text.length);
  });

  it("молчащая машина не переписывает готовый паспорт", async () => {
    const seeded = seed();
    addJob(seeded, "AG-1");
    const settings = enableWriter(seeded.db);
    writePassport(seeded.db, { bbProjectId: PROJECT, ...draft, sourceDigest: "старый", acceptedJobs: 0, builtBy: "model", note: "Сборка" }, NOW);
    const offline = { settings, write: stubWriter("Тощая редакция без правил проекта"), gate: async () => null, readRules: async () => ({ reachable: false, text: null }) };

    const auto = await buildPassport(seeded.db, { bbProjectId: PROJECT, trigger: "auto" }, offline);
    expect(auto.ok).toBe(false);
    expect(!auto.ok && auto.reason).toBe("no_material");
    expect(getPassport(seeded.db, PROJECT)!.header).toBe(draft.header);

    // Кнопкой владелец всё же может собрать: он видит, что машина не отвечает.
    const manual = await buildPassport(seeded.db, { bbProjectId: PROJECT, trigger: "manual" }, offline);
    expect(manual.ok).toBe(true);
  });

  it("в строке с командой стоит идентификатор проекта, а не заглушка", () => {
    const seeded = seed();
    writePassport(seeded.db, { bbProjectId: PROJECT, ...draft, sourceDigest: "aaa", acceptedJobs: 0, builtBy: "model", note: "Сборка" }, NOW);
    const forHelper = seeded.store.passportForLaunch(seeded.binding.id, seeded.department.id, seeded.helper.id, "host_mini")!;
    expect(forHelper.text).toContain(PROJECT);
    expect(forHelper.text).not.toContain("<проект>");
  });

  it("правка владельца держится вдвое дольше обычной редакции", async () => {
    const seeded = seed();
    addJob(seeded, "AG-1");
    const settings = enableWriter(seeded.db, 2);
    const deps = { settings, write: stubWriter(), gate: async () => null };
    expect((await buildPassport(seeded.db, { bbProjectId: PROJECT, trigger: "auto" }, deps)).ok).toBe(true);

    // Владелец переписал паспорт руками: обычный порог для него не действует.
    const material = collectPassportMaterial(seeded.db, PROJECT);
    writePassport(
      seeded.db,
      { bbProjectId: PROJECT, header: "Шапка владельца", sections: [], sourceDigest: material.digest, acceptedJobs: material.acceptedJobs, builtBy: "owner", note: "Правка владельца" },
      NOW,
    );
    addJob(seeded, "AG-2");
    addJob(seeded, "AG-3");
    expect(projectsDueForPassport(seeded.db, settings)).toEqual([]);
    expect((await buildPassport(seeded.db, { bbProjectId: PROJECT, trigger: "auto" }, deps)).ok).toBe(false);
    expect(getPassport(seeded.db, PROJECT)!.header).toBe("Шапка владельца");

    addJob(seeded, "AG-4");
    addJob(seeded, "AG-5");
    expect(projectsDueForPassport(seeded.db, settings)).toEqual([PROJECT]);
    expect(passportDue(getPassport(seeded.db, PROJECT), collectPassportMaterial(seeded.db, PROJECT), settings)).toBe(true);
  });

  it("выключенный писарь ничего не собирает", async () => {
    const seeded = seed();
    addJob(seeded, "AG-1");
    const result = await buildPassport(seeded.db, { bbProjectId: PROJECT, trigger: "manual" }, { write: stubWriter(), gate: async () => null });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("disabled");
    expect(getPassport(seeded.db, PROJECT)).toBeNull();
  });
});

/** Ответ модели-писаря: content с JSON по нашей схеме. */
function writerReply(payload: Record<string, string>) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) } as unknown as Response;
}

const WRITER: PassportSettings = { ...DEFAULT_PASSPORT_SETTINGS, enabled: true, keySource: "machine-env", revision: 1 };

describe("писарь паспорта", () => {
  it("зовёт чат-эндпоинт и разбирает разделы, пропуская пустые", async () => {
    const fetchStub = vi.fn(async () => writerReply({ header: "Плагин для BB.", what: "Папка bb-plugin-agency.", audience: "  ", decisions: "", limits: "Базу руками не правим.", direction: "" }));
    const outcome = await writePassportDraft(WRITER, { material: "Знания проекта…", previous: null }, { fetch: fetchStub as unknown as typeof fetch, key: "sk-test" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.draft.header).toBe("Плагин для BB.");
    expect(outcome.draft.sections.map((section) => section.key)).toEqual(["what", "limits"]);

    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/chat/completions");
    const body = JSON.parse(String(init.body)) as { messages: { content: string }[]; response_format: { json_schema: { name: string } } };
    expect(body.response_format.json_schema.name).toBe("project_passport");
    // Материал уходит один раз и целиком: модель сокращает его, а не додумывает.
    expect(body.messages[1]!.content).toContain("Знания проекта…");
  });

  it("выключенный писарь и пустой материал не тратят ни запроса", async () => {
    const fetchStub = vi.fn(async () => writerReply({ header: "…" }));
    expect((await writePassportDraft({ ...WRITER, enabled: false }, { material: "что-то", previous: null }, { fetch: fetchStub as unknown as typeof fetch, key: "sk" })).ok).toBe(false);
    expect((await writePassportDraft(WRITER, { material: "   ", previous: null }, { fetch: fetchStub as unknown as typeof fetch, key: "sk" })).ok).toBe(false);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("ответ не по схеме остаётся без паспорта", async () => {
    const fetchStub = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "просто текст" } }] }) }) as unknown as Response);
    const outcome = await writePassportDraft(WRITER, { material: "Материал", previous: null }, { fetch: fetchStub as unknown as typeof fetch, key: "sk" });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe("bad_answer");
  });
});

describe("привратник паспорта", () => {
  const gateSettings = { ...DEFAULT_DECISION_SETTINGS, enabled: true, endpointKind: "openrouter" as const, points: ["passport-gate"], revision: 1 };
  const gateReply = (answers: Record<string, { value: unknown; confidence: number }>) =>
    ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(answers) } }] }) }) as unknown as Response;

  it("останавливает редакцию с секретом", async () => {
    const fetchStub = vi.fn(async () => gateReply({ secret: { value: true, confidence: 0.95 }, transient: { value: false, confidence: 0.9 } }));
    const verdict = await askPassportGate(gateSettings, draft, null, { fetch: fetchStub as unknown as typeof fetch, key: "sk" });
    expect(verdict?.apply).toBe(false);
    expect(verdict?.reason).toContain("ключ");
  });

  it("пропускает редакцию, которая отличается по существу", async () => {
    const fetchStub = vi.fn(async () => gateReply({ secret: { value: false, confidence: 0.95 }, transient: { value: false, confidence: 0.92 }, changed: { value: true, confidence: 0.8 } }));
    const verdict = await askPassportGate(gateSettings, draft, draft, { fetch: fetchStub as unknown as typeof fetch, key: "sk" });
    expect(verdict?.apply).toBe(true);
  });

  it("совпадение с прежней редакцией не применяется", async () => {
    const fetchStub = vi.fn(async () => gateReply({ secret: { value: false, confidence: 0.95 }, transient: { value: false, confidence: 0.9 }, changed: { value: false, confidence: 0.85 } }));
    const verdict = await askPassportGate(gateSettings, draft, draft, { fetch: fetchStub as unknown as typeof fetch, key: "sk" });
    expect(verdict?.apply).toBe(false);
  });

  it("выключенная точка решения молчит, и сборка идёт своим порядком", async () => {
    const verdict = await askPassportGate({ ...gateSettings, points: [] }, draft, null, { key: "sk" });
    expect(verdict).toBeNull();
  });
});
