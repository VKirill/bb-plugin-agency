import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { openMigratedDatabase, type SqlDatabase } from "../src/server/db";
import { createDomainStore, type ServiceContext } from "../src/server/services";
import {
  buildAgencyInstructions,
  buildSessionInstructions,
  buildWorkerInstructions,
  charterAccepts,
  departmentPurpose,
  INSTRUCTIONS_LIMIT,
  readProjectRoutes,
} from "../src/server/delegation/instructions";

function seedAgency(db: SqlDatabase) {
  const store = createDomainStore(db);
  const bootstrap: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [] };
  const policy = store.createPolicyVersion(bootstrap, {
    requestId: randomUUID(),
    allowedCapabilities: ["read.files"],
    cliHostConstraints: { providerIds: ["claude-code"], hostIds: ["host_mini"] },
    secretRefs: [],
  });
  if (!policy.ok) throw new Error(policy.error.message);
  const agent = (name: string, role: string) => {
    const created = store.provisionAgent(bootstrap, {
      requestId: randomUUID(),
      name,
      state: "active",
      version: {
        version: 1,
        role,
        instructions: "Работать по процессу отдела.",
        providerId: "claude-code",
        model: "claude-sonnet-5",
        skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
        mcpIds: [],
        policyVersionId: policy.value.id,
      },
    });
    if (!created.ok) throw new Error(created.error.message);
    return created.value.agent;
  };
  const lead = agent("Fable", "lead");
  const developer = agent("Sonnet", "developer");
  const department = store.provisionDepartment(bootstrap, {
    requestId: randomUUID(),
    name: "Программисты",
    leadAgentId: lead.id,
    process: {
      instructions: "Разрабатывает и проверяет код плагинов. Руководитель декомпозирует.",
      acceptance: "Принятая версия.",
      reviewPolicy: { required: true },
    },
  });
  if (!department.ok) throw new Error(department.error.message);
  const member = store.addMembership(bootstrap, {
    requestId: randomUUID(),
    departmentId: department.value.department.id,
    agentId: developer.id,
    role: "executor",
  } as Parameters<typeof store.addMembership>[1]);
  if (!member.ok) throw new Error(member.error.message);
  const binding = store.createProjectBinding(bootstrap, {
    requestId: randomUUID(),
    bbProjectId: "proj_bound",
    environmentId: "env_ucx7sb57rs",
    hostId: "host_mini",
    canonicalRoot: "/work/plugins",
    policyVersionId: policy.value.id,
    sectionId: null,
  });
  if (!binding.ok) throw new Error(binding.error.message);
  const ctx: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [binding.value.id] };
  const linked = store.linkDepartment(ctx, {
    requestId: randomUUID(),
    bindingId: binding.value.id,
    departmentId: department.value.department.id,
  });
  if (!linked.ok) throw new Error(linked.error.message);
  return { bindingId: binding.value.id, departmentId: department.value.department.id, lead, developer };
}

describe("delegation instructions for ordinary sessions", () => {
  it("routes by department with placement ids and a minimal create payload", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const seeded = seedAgency(db);
    const text = buildAgencyInstructions(db, { threadId: "thr_plain", projectId: "proj_bound" }, "delegate");
    expect(text).toContain("## BB Agency: where the work goes");
    expect(text).toContain('"Программисты": Разрабатывает и проверяет код плагинов.');
    expect(text).toContain(`Lead: Fable (${seeded.lead.id})`);
    expect(text).toContain(`departmentId ${seeded.departmentId}`);
    expect(text).toContain(`"bindingId":"${seeded.bindingId}"`);
    expect(text).toContain("The server assigns the key");
    expect(text).toContain("do not delegate it again");
    expect(text).toContain("Language: write job titles, briefs, acceptance criteria");
    db.close();
  });

  it("only suggests in suggest mode and stays silent when off", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    seedAgency(db);
    const suggest = buildAgencyInstructions(db, { threadId: "thr_plain", projectId: "proj_bound" }, "suggest");
    expect(suggest).toContain("Propose handing it to");
    expect(suggest).toContain("After the owner agrees");
    expect(buildAgencyInstructions(db, { threadId: "thr_plain", projectId: "proj_bound" }, "off")).toBeNull();
    db.close();
  });

  it("gives an unbound project a short note and an empty agency nothing", () => {
    const empty = openMigratedDatabase(new Database(":memory:"));
    expect(buildAgencyInstructions(empty, { threadId: "thr_plain", projectId: "proj_other" }, "delegate")).toBeNull();
    empty.close();
    const db = openMigratedDatabase(new Database(":memory:"));
    seedAgency(db);
    const note = buildAgencyInstructions(db, { threadId: "thr_plain", projectId: "proj_other" }, "delegate");
    expect(note).toContain("not connected");
    expect(note).toContain("Do not create a job yourself");
    expect(readProjectRoutes(db, "proj_other")).toEqual({ workplaces: [], departments: [] });
    db.close();
  });

  it("keeps the closing rules when the department list is too long", () => {
    const departments = Array.from({ length: 80 }, (_, index) => ({
      departmentId: `dep_${String(index).padStart(8, "0")}`,
      name: `Отдел ${index}`,
      purpose: "Очень длинное описание процесса отдела, которое повторяется для проверки предела.",
      leadAgentId: `agt_${String(index).padStart(8, "0")}`,
      leadName: `Руководитель ${index}`,
      memberCount: 3,
    }));
    const text = buildSessionInstructions({
      mode: "delegate",
      routes: { workplaces: [{ bindingId: "bnd_aaaaaaaa", hostId: "host_mini", root: "/work" }], departments },
      totalDepartments: 80,
    }) as string;
    expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_LIMIT);
    expect(text).toContain("more: bb agency workspace --json");
    expect(text.trimEnd()).toMatch(/Language: write job titles.*in Russian\.$/);
  });

  it("offers departments open to all projects without a link and hides disconnected projects", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const seeded = seedAgency(db);
    const store = createDomainStore(db);
    const system: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [] };
    const other = store.provisionDepartment(system, {
      requestId: randomUUID(),
      name: "Копирайтинг",
      leadAgentId: seeded.developer.id,
      process: { instructions: "## Принимаем\n- Тексты лендингов", acceptance: "Текст принят.", reviewPolicy: { required: false } },
    });
    if (!other.ok) throw new Error(other.error.message);
    const restricted = store.provisionDepartment(system, {
      requestId: randomUUID(),
      name: "Закрытый отдел",
      leadAgentId: seeded.developer.id,
      process: { instructions: "Только своё.", acceptance: "Принято.", reviewPolicy: { required: false } },
    });
    if (!restricted.ok) throw new Error(restricted.error.message);
    const limited = store.setDepartmentAvailability(system, {
      requestId: randomUUID(),
      expectedRevision: restricted.value.department.revision,
      departmentId: restricted.value.department.id,
      availability: "selected",
    });
    expect(limited.ok).toBe(true);

    const text = buildAgencyInstructions(db, { threadId: "thr_plain", projectId: "proj_bound" }, "delegate", () => "Mac mini") as string;
    expect(text).toContain('"Копирайтинг": Принимает: Тексты лендингов.');
    expect(text).not.toContain("Закрытый отдел");
    expect(text).toContain("runs on Mac mini in /work/plugins");

    const binding = store.getBinding(seeded.bindingId);
    const archived = store.archiveProjectBinding({ actor: { kind: "system" }, allowedBindingIds: [seeded.bindingId] }, {
      requestId: randomUUID(),
      expectedRevision: binding?.revision ?? 1,
      bindingId: seeded.bindingId,
    });
    expect(archived.ok).toBe(true);
    expect(buildAgencyInstructions(db, { threadId: "thr_plain", projectId: "proj_bound" }, "delegate")).toContain("not connected");
    db.close();
  });

  it("routes by the charter «Принимаем» section when the department has one", () => {
    const charter = [
      "## Назначение",
      "Разработка плагинов BB.",
      "## Принимаем",
      "- Новые функции и исправления в коде плагинов;",
      "- Тесты и сборку.",
      "## Не принимаем",
      "- Тексты лендингов → «Копирайтинг».",
    ].join("\n");
    expect(charterAccepts(charter)).toBe("Новые функции и исправления в коде плагинов; Тесты и сборку");
    expect(departmentPurpose(charter)).toBe("Принимает: Новые функции и исправления в коде плагинов; Тесты и сборку.");
    expect(charterAccepts("Принимаем: SEO-аудиты и семантику.\nРабота: …")).toBe("SEO-аудиты и семантику.");
    expect(charterAccepts("Просто процесс без раздела.")).toBeNull();
  });

  it("uses the first sentence of the process as the purpose", () => {
    expect(departmentPurpose("Пишет тексты.  Затем редактор проверяет.")).toBe("Пишет тексты.");
    expect(departmentPurpose("Без точки")).toBe("Без точки.");
    expect(departmentPurpose("")).toBe("процесс отдела не описан");
  });
});

describe("instructions inside Agency job threads", () => {
  const members = [
    { agentId: "agt_lead0001", name: "Fable", role: "Руководитель отдела", lead: true, type: "lead" as const },
    { agentId: "agt_dev00001", name: "Sonnet", role: "Разработчик", lead: false, type: "executor" as const },
    { agentId: "agt_qa000001", name: "Opus", role: "Проверяющий кода", lead: false, type: "reviewer" as const },
  ];

  it("tells a lead to orchestrate subtasks instead of implementing", () => {
    const text = buildWorkerInstructions({
      jobId: "job_root0001",
      jobKey: "AG-2201",
      title: "Калькулятор",
      departmentName: "Программисты",
      isLead: true,
      assigneeType: "lead",
      members,
    });
    expect(text).toContain('## Your role: lead of the "Программисты" department for AG-2201');
    expect(text).toContain("parentJobId=job_root0001");
    expect(text).toContain("Executors (implementation and rework):\n- Sonnet — Разработчик: agt_dev00001");
    expect(text).toContain("Reviewers (independent review of other people's versions):\n- Opus — Проверяющий кода: agt_qa000001");
    expect(text).not.toContain("agt_lead0001");
    expect(text).toContain("the Agency messages this thread");
    expect(text).toContain("A job outside the department's scope");
    expect(text).toContain("bb agency launch cancel");
  });

  it("tells an executor not to re-delegate", () => {
    const text = buildWorkerInstructions({
      jobId: "job_child001",
      jobKey: "AG-2202",
      title: "Реализация",
      departmentName: "Программисты",
      isLead: false,
      assigneeType: "executor",
      members,
    });
    expect(text).toContain("## Your role: executor of AG-2202");
    expect(text).toContain("do not hand this work on");
    expect(text).toContain("report-needs-input");
    expect(text).toContain('"Return: reason; who fits; what is missing"');
    expect(text).toContain("transition` to blocked");
  });

  it("gives a reviewer the checking protocol instead of the executor one", () => {
    const text = buildWorkerInstructions({
      jobId: "job_check001",
      jobKey: "AG-2203",
      title: "Проверка",
      departmentName: "Программисты",
      isLead: false,
      assigneeType: "reviewer",
      members,
    });
    expect(text).toContain("## Your role: reviewer of AG-2203");
    expect(text).toContain("Do not edit the reviewed result");
    expect(text).toContain("a review of your own work");
    expect(text).not.toContain("executor of");
  });

  it("finds the accepted-work section in English charters too", () => {
    expect(charterAccepts("## Purpose\nCode.\n\n## Accepts\n- Bug fixes\n- Tests\n\n## Does not accept\n- Copy")).toBe("Bug fixes; Tests");
    expect(charterAccepts("## Принимаем\n- Код")).toBe("Код");
  });
});

describe("plugin registration", () => {
  it("contributes instructions without spawning anything", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "agency" });
    try {
      await plugin(bb);
      const provider = harness.inspection.registrations.instructionProvider;
      expect(provider).toBeTypeOf("function");
      expect(provider?.({ threadId: "thr_plain", projectId: "proj_none" })).toBeNull();
      expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});

describe("role in the launch prompt", () => {
  it("does not give an Agency launch thread the chat routing text", async () => {
    const { readJobRoleContext } = await import("../src/server/delegation/instructions");
    const db = openMigratedDatabase(new Database(":memory:"));
    expect(readJobRoleContext(db, "job_missing01")).toBeNull();
    db.close();
  });
});
