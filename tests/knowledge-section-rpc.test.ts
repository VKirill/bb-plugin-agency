import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { openMigratedDatabase } from "../src/server/db";
import { knowledgeDecisionRefusal } from "../src/server/knowledge/decide";
import { KNOWLEDGE_INDEX_LIMIT, knowledgeBlock, listKnowledge, saveKnowledge } from "../src/server/knowledge/store";
import { CLI_EXAMPLES } from "../src/server/cli/examples";
import { CLI_OPERATIONS } from "../src/server/cli/operations";
import { knowledgeItemSchema, listKnowledgeInputSchema, saveKnowledgeInputSchema } from "../src/shared/rpc-contract";
import { seed } from "./role-types.test";

const NOW = "2026-09-20T00:00:00.000Z";
const SECTION_1 = "sec_1111111111111111";
const SECTION_2 = "sec_2222222222222222";
const ROOT = "/work/SelfyStudio";

type DomainEnvelope<T = unknown> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

function requestId() {
  return randomUUID();
}

function catalogSdk() {
  return {
    system: { config: async () => ({ primaryHostId: "host_primary" }) },
    projects: { list: async () => [{ id: "proj_trusted", name: "SelfyStudio" }] },
    hosts: { list: async () => [{ id: "host_mini", name: "Mac mini" }] },
    status: {
      get: async () => ({
        project: { id: "proj_trusted" },
        thread: { environmentId: "env_local01" },
        childThreads: null,
        pendingTodos: null,
      }),
    },
    skills: {
      list: async () => ({
        skills: [{ id: "skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff", name: "agency", scope: "plugin", pluginId: "agency", description: "Agency" }],
      }),
    },
    environments: {
      list: async () => [{ id: "env_local01", projectId: "proj_trusted", hostId: "host_mini", path: ROOT, name: "локально" }],
      get: async ({ environmentId }: { environmentId: string }) => {
        if (environmentId !== "env_local01") throw new Error("missing env");
        return { id: "env_local01", projectId: "proj_trusted", hostId: "host_mini", path: ROOT, name: "локально" };
      },
    },
  };
}

async function loadPlugin() {
  const { bb, harness } = createFakePluginHost({ pluginId: "agency", sdk: catalogSdk() });
  await plugin(bb);
  return harness;
}

async function rpc<T>(harness: Awaited<ReturnType<typeof loadPlugin>>, method: string, input: unknown): Promise<T> {
  return harness.behavior.callRpc(method, input) as Promise<T>;
}

async function requireOk<T>(envelope: DomainEnvelope<T>, label: string): Promise<T> {
  if (!envelope.ok) throw new Error(`${label}: ${envelope.error.code} ${envelope.error.message}`);
  return envelope.value;
}

async function seedRpc(harness: Awaited<ReturnType<typeof loadPlugin>>) {
  const policy = await requireOk(
    await rpc<DomainEnvelope<{ id: string }>>(harness, "createPolicyVersion", {
      requestId: requestId(),
      allowedCapabilities: ["read.files"],
      cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_mini"] },
      secretRefs: [],
    }),
    "policy",
  );
  const agent = await requireOk(
    await rpc<DomainEnvelope<{ agent: { id: string } }>>(harness, "provisionAgent", {
      requestId: requestId(),
      name: "Редактор",
      state: "active",
      version: {
        version: 1,
        role: "editor",
        instructions: "Править тексты по брифу.",
        providerId: "codex",
        model: "gpt-5.6",
        skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
        mcpIds: [],
        policyVersionId: policy.id,
      },
    }),
    "agent",
  );
  const department = await requireOk(
    await rpc<DomainEnvelope<{ department: { id: string; leadAgentId: string } }>>(harness, "provisionDepartment", {
      requestId: requestId(),
      name: "Редактура",
      leadAgentId: agent.agent.id,
      process: { instructions: "Черновик.", acceptance: "Версия.", reviewPolicy: { required: true } },
    }),
    "department",
  );
  const binding = await requireOk(
    await rpc<DomainEnvelope<{ id: string }>>(harness, "createProjectBinding", {
      requestId: requestId(),
      bbProjectId: "proj_trusted",
      environmentId: "env_local01",
      hostId: "host_mini",
      canonicalRoot: ROOT,
      policyVersionId: policy.id,
      sectionId: null,
    }),
    "binding",
  );
  return { policyId: policy.id, leadId: agent.agent.id, departmentId: department.department.id, bindingId: binding.id };
}

describe("знания раздела: RPC, CLI и запуск", () => {
  it("save/list/get: фильтр раздела изолирует записи; без фильтра — все; чужой parent — not_found", async () => {
    const harness = await loadPlugin();
    const seeded = await seedRpc(harness);

    const saved = await requireOk(
      await rpc<DomainEnvelope<{ id: string; scopeKind: string; parentBindingId: string | null; revision: number }>>(harness, "saveKnowledge", {
        expectedRevision: 0,
        title: "Заметка S1",
        body: "Только первый раздел.",
        source: "тест",
        scopeKind: "section",
        scopeId: SECTION_1,
        parentBindingId: seeded.bindingId,
      }),
      "save S1",
    );
    expect(saved.scopeKind).toBe("section");
    expect(saved.parentBindingId).toBe(seeded.bindingId);

    const listedS2 = await requireOk(
      await rpc<DomainEnvelope<Array<{ id: string }>>>(harness, "listKnowledge", {
        scopeKind: "section",
        scopeId: SECTION_2,
      }),
      "list S2",
    );
    expect(listedS2.map((item) => item.id)).toEqual([]);

    const listedS1 = await requireOk(
      await rpc<DomainEnvelope<Array<{ id: string }>>>(harness, "listKnowledge", {
        scopeKind: "section",
        scopeId: SECTION_1,
      }),
      "list S1",
    );
    expect(listedS1.map((item) => item.id)).toEqual([saved.id]);

    const listedAll = await requireOk(await rpc<DomainEnvelope<Array<{ id: string }>>>(harness, "listKnowledge", null), "list null");
    const listedEmpty = await requireOk(await rpc<DomainEnvelope<Array<{ id: string }>>>(harness, "listKnowledge", {}), "list {}");
    expect(listedAll.map((item) => item.id)).toEqual(listedEmpty.map((item) => item.id));
    expect(listedAll.some((item) => item.id === saved.id)).toBe(true);

    const got = await requireOk(await rpc<DomainEnvelope<unknown>>(harness, "getKnowledge", { id: saved.id }), "get");
    expect(knowledgeItemSchema.parse(got).scopeKind).toBe("section");
    expect(knowledgeItemSchema.parse(listedS1[0]).id).toBe(saved.id);

    const missingParent = await rpc<DomainEnvelope<unknown>>(harness, "saveKnowledge", {
      expectedRevision: 0,
      title: "Чужая привязка",
      body: "Не должна сохраниться.",
      source: "тест",
      scopeKind: "section",
      scopeId: SECTION_1,
      parentBindingId: "bnd_does_not_exist",
    });
    expect(missingParent.ok).toBe(false);
    if (missingParent.ok) throw new Error("expected not_found");
    expect(missingParent.error.code).toBe("not_found");
    expect(missingParent.error.message).toContain("bnd_does_not_exist");
  });

  it("руководитель отдела не принимает запись section", () => {
    const refusal = knowledgeDecisionRefusal(
      "agt_lead",
      {
        id: "kno_section",
        title: "Знание раздела",
        summary: "Сводка.",
        body: "Текст.",
        kind: "lesson",
        importance: 50,
        pinned: false,
        writeReason: "",
        readCount: 0,
        lastReadAt: null,
        source: "тест",
        scopeKind: "section",
        scopeId: SECTION_1,
        parentBindingId: "bnd_parent",
        status: "proposal",
        proposedBy: "agt_lead",
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
      "agt_lead",
    );
    expect(refusal?.code).toBe("forbidden");
  });

  it("knowledgeForLaunch кладёт раздел в project и не смешивает соседей", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const seeded = seed(db);
    const store = seeded.store;
    const other = store.createProjectBinding(seeded.bootstrap, {
      requestId: randomUUID(),
      bbProjectId: "proj_other_section",
      environmentId: "env_ucx7sb57rs",
      hostId: "host_mini",
      canonicalRoot: "/work/other",
      policyVersionId: seeded.policyVersionId,
      sectionId: null,
    });
    if (!other.ok) throw new Error(other.error.message);

    const project = saveKnowledge(
      db,
      {
        expectedRevision: 0,
        title: "Знание проекта B",
        body: "Проектная запись.",
        source: "тест",
        scopeKind: "project",
        scopeId: seeded.bindingId,
      },
      { proposedBy: null },
      NOW,
    );
    const s1 = saveKnowledge(
      db,
      {
        expectedRevision: 0,
        title: "Знание раздела S1",
        body: "Только S1.",
        source: "тест",
        scopeKind: "section",
        scopeId: SECTION_1,
        parentBindingId: seeded.bindingId,
      },
      { proposedBy: null },
      NOW,
    );
    const s2 = saveKnowledge(
      db,
      {
        expectedRevision: 0,
        title: "Знание раздела S2",
        body: "Только S2.",
        source: "тест",
        scopeKind: "section",
        scopeId: SECTION_2,
        parentBindingId: seeded.bindingId,
      },
      { proposedBy: null },
      NOW,
    );
    const foreign = saveKnowledge(
      db,
      {
        expectedRevision: 0,
        title: "Чужой родитель того же S1",
        body: "Не должна попасть в запуск B.",
        source: "тест",
        scopeKind: "section",
        scopeId: SECTION_1,
        parentBindingId: other.value.id,
      },
      { proposedBy: null },
      NOW,
    );
    expect(project.ok && s1.ok && s2.ok && foreign.ok).toBe(true);
    if (!project.ok || !s1.ok || !s2.ok || !foreign.ok) throw new Error("save failed");

    const withS1 = store.knowledgeForLaunch(seeded.departmentId, seeded.bindingId, null, SECTION_1);
    expect(withS1?.project).toContain("Знание проекта B");
    expect(withS1?.project).toContain(`Знания раздела ${SECTION_1}`);
    expect(withS1?.project).toContain("Знание раздела S1");
    expect(withS1?.project).not.toContain("Знание раздела S2");
    expect(withS1?.project).not.toContain("Чужой родитель");
    expect(withS1?.ids.some((row) => row.id === s1.value.id)).toBe(true);
    expect(withS1?.ids.some((row) => row.id === s2.value.id)).toBe(false);

    const withS2 = store.knowledgeForLaunch(seeded.departmentId, seeded.bindingId, null, SECTION_2);
    expect(withS2?.project).toContain("Знание проекта B");
    expect(withS2?.project).toContain("Знание раздела S2");
    expect(withS2?.project).not.toContain("Знание раздела S1");

    const without = store.knowledgeForLaunch(seeded.departmentId, seeded.bindingId, null);
    const omitted = store.knowledgeForLaunch(seeded.departmentId, seeded.bindingId, null, undefined);
    const empty = store.knowledgeForLaunch(seeded.departmentId, seeded.bindingId, null, "");
    const nulled = store.knowledgeForLaunch(seeded.departmentId, seeded.bindingId, null, null);
    expect(without).toEqual(omitted);
    expect(without).toEqual(empty);
    expect(without).toEqual(nulled);
    expect(without?.project).toContain("Знание проекта B");
    expect(without?.project).not.toContain("Знания раздела");
    expect(without?.project).not.toContain("Знание раздела S1");
    expect(JSON.stringify(without)).toBe(JSON.stringify(omitted));
  });

  it("хвост индекса раздела даёт list с фильтром этого раздела", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const write = (title: string) =>
      saveKnowledge(
        db,
        {
          expectedRevision: 0,
          title,
          summary: `${title}: ${"хвост ".repeat(40)}`,
          body: "Тело.",
          kind: "fact",
          importance: 10,
          source: "тест",
          scopeKind: "section",
          scopeId: SECTION_1,
          parentBindingId: "bnd_parent_section01",
        },
        { proposedBy: null },
        NOW,
      );
    for (let index = 0; index < 40; index += 1) write(`Раздел ${String(index).padStart(2, "0")}`);
    const block = knowledgeBlock(db, "section", SECTION_1, null, "bnd_parent_section01");
    expect(block.text.length).toBeGreaterThan(0);
    expect(block.text).toContain(`"scopeKind":"section"`);
    expect(block.text).toContain(`"scopeId":"${SECTION_1}"`);
    expect(block.text).toContain(`"parentBindingId":"bnd_parent_section01"`);
    expect(block.text).not.toContain("bb agency knowledge list --input-json '{}'");
    expect(block.text.length).toBeLessThan(KNOWLEDGE_INDEX_LIMIT + 8_000);
  });

  it("схемы CLI listKnowledge и saveKnowledge принимают фильтр и пример section", () => {
    expect(listKnowledgeInputSchema.safeParse(null).success).toBe(true);
    expect(listKnowledgeInputSchema.safeParse({}).success).toBe(true);
    expect(listKnowledgeInputSchema.safeParse(CLI_EXAMPLES.listKnowledge).success).toBe(true);
    expect(CLI_OPERATIONS.listKnowledge.input.safeParse(CLI_EXAMPLES.listKnowledge).success).toBe(true);
    expect(CLI_OPERATIONS.listKnowledge.summary).toContain("разделов");
    expect(CLI_EXAMPLES.listKnowledge).toMatchObject({ scopeKind: "section", scopeId: "sec_aaaaaaaaaaaaaaaa" });
    expect(CLI_EXAMPLES.saveKnowledge).toMatchObject({
      scopeKind: "section",
      scopeId: "sec_aaaaaaaaaaaaaaaa",
      parentBindingId: "bnd_aaaaaaaaaaaa",
    });
    expect(saveKnowledgeInputSchema.safeParse(CLI_EXAMPLES.saveKnowledge).success).toBe(true);
    expect(CLI_OPERATIONS.saveKnowledge.input.safeParse(CLI_EXAMPLES.saveKnowledge).success).toBe(true);
  });

  it("prepare.ts передаёт job.sectionId четвёртым аргументом knowledgeForLaunch", () => {
    const source = readFileSync(join(__dirname, "../src/server/runtime/prepare-run/prepare.ts"), "utf8");
    expect(source).toContain("knowledgeForLaunch?.(job.departmentId, binding.id, briefing?.lessonIds ?? null, job.sectionId)");
    expect(source.match(/knowledgeForLaunch/g)?.length).toBe(1);
  });

  it("без фильтра listKnowledge на домене ведёт себя как раньше", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const seeded = seed(db);
    const agency = saveKnowledge(
      db,
      { expectedRevision: 0, title: "Тон", body: "Коротко.", source: "тест", scopeKind: "agency", scopeId: null },
      { proposedBy: null },
      NOW,
    );
    const section = saveKnowledge(
      db,
      {
        expectedRevision: 0,
        title: "Раздел",
        body: "Текст.",
        source: "тест",
        scopeKind: "section",
        scopeId: SECTION_1,
        parentBindingId: seeded.bindingId,
      },
      { proposedBy: null },
      NOW,
    );
    expect(agency.ok && section.ok).toBe(true);
    expect(listKnowledge(db).map((item) => item.title).sort()).toEqual(["Раздел", "Тон"]);
    expect(listKnowledge(db, {}).map((item) => item.title).sort()).toEqual(["Раздел", "Тон"]);
  });
});
