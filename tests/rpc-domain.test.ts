import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { SDK_RPC_AUTH } from "../src/server/api/auth";
import { createDomainRpc } from "../src/server/api/domain-rpc";
import { withCallerThread } from "../src/server/api/caller";
import { resolveAgencyBoundFileOp, runBoundArtifactFileOp } from "../src/server/api/bound-files";
import { createArtifactMetadataPort, createDomainStore } from "../src/server/services";
import { withCommitFailure } from "../src/server/artifacts";
import { openDatabase } from "../src/server/db/database";
import { sameAuthor } from "../src/server/artifacts/metadata-port";
import { documentHostContract } from "../src/shared/document-contract";
import { rpcContract } from "../src/shared/rpc-contract";
import { artifactVersionSchema } from "../src/shared/contracts";

const signal = { projectId: "proj_test", eventId: "research-1", topic: "research.delivered", reference: "artifact-1" };
const ROOT = "/work/SelfyStudio";
const OTHER_ROOT = "/work/OtherStudio";

function requestId() {
  return randomUUID();
}

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

type DomainEnvelope<T = unknown> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

const DEFAULT_SKILLS = [
  { id: "skill_6153a163aaaa", name: "agency", scope: "plugin", pluginId: "agency", description: "Agency" },
  { id: "skill_41e7026daaaa", name: "model-task-prompts", scope: "bb-user", pluginId: null, description: "MTP" },
  { id: "skill_dffe1cd2aaaa", name: "agency-artifacts", scope: "bb-user", pluginId: null, description: "Artifacts" },
  { id: "skill_4eb429d2aaaa", name: "telegram-ads-method", scope: "bb-user", pluginId: null, description: "Ads" },
  { id: "skl_ru000001", name: "ru-text", scope: "bb-user", pluginId: null, description: "fixture" },
];

type Catalog = {
  projects?: Array<{ id: string; name?: string }>;
  hosts?: Array<{ id: string; name?: string }>;
  environments?: Record<string, { id: string; projectId: string; hostId: string; path: string | null; name?: string }>;
  projectsList?: "throw";
  environmentsList?: "throw";
  skillsList?: "throw";
  skills?: typeof DEFAULT_SKILLS;
};

function catalogSdk(catalog: Catalog = {}) {
  const projects = catalog.projects ?? [
    { id: "proj_trusted", name: "SelfyStudio" },
    { id: "proj_other", name: "OtherStudio" },
  ];
  const hosts = catalog.hosts ?? [
    { id: "host_mini", name: "Mac mini" },
    { id: "host_order", name: "Order host" },
  ];
  const environments = catalog.environments ?? {
    env_local01: {
      id: "env_local01",
      projectId: "proj_trusted",
      hostId: "host_mini",
      path: ROOT,
      name: "локально",
    },
  };
  return {
    system: { config: async () => ({ primaryHostId: "host_primary" }) },
    projects: {
      list: async () => {
        if (catalog.projectsList === "throw") throw new Error("no sdk");
        return projects;
      },
      create: async (args: { name: string; source: { type: "local_path"; hostId: string; path: string } }) => {
        const created = { id: `proj_${args.name.replace(/\W/g, "").slice(0, 8).padEnd(8, "x")}`, name: args.name };
        projects.push(created);
        return created;
      },
    },
    hosts: { list: async () => hosts },
    status: {
      get: async () => ({
        project: { id: projects[0]?.id ?? "proj_trusted" },
        thread: { environmentId: Object.values(environments)[0]?.id ?? null },
        childThreads: null,
        pendingTodos: null,
      }),
    },
    skills: {
      list: async () => {
        if (catalog.skillsList === "throw") throw new Error("no skills");
        return { skills: catalog.skills ?? DEFAULT_SKILLS };
      },
    },
    environments: {
      list: async () => {
        if (catalog.environmentsList === "throw") throw new Error("no env list");
        return Object.values(environments);
      },
      get: async ({ environmentId }: { environmentId: string }) => {
        const environment = environments[environmentId];
        if (!environment) throw new Error(`missing ${environmentId}`);
        return environment;
      },
    },
  };
}

function memoryHost() {
  const files = new Map<string, { bytesBase64: string; hash: string; size: number }>();
  const calls: Array<{ method: string; hostId: string; root?: string; op?: string }> = [];
  let writesAccepted = 0;
  const keyOf = (hostId: string, root: string | undefined, relativePath: string | undefined) =>
    `${hostId}:${root}:${relativePath}`;
  return {
    files,
    calls,
    get writesAccepted() {
      return writesAccepted;
    },
    find(relativePath: string) {
      return [...files.entries()].find(([key]) => key.endsWith(`:${relativePath}`));
    },
    call: async (call: { method: string; hostId: string; input: unknown }) => {
      const input = call.input as { op?: string; canonicalRoot?: string; relativePath?: string; bytesBase64?: string };
      calls.push({ method: call.method, hostId: call.hostId, root: input.canonicalRoot, op: input.op });
      if (call.method !== "fileOp") throw new Error(`unexpected ${call.method}`);
      const key = keyOf(call.hostId, input.canonicalRoot, input.relativePath);
      if (input.op === "writeAtomic" && input.bytesBase64) {
        if (files.has(key)) {
          return { ok: false, code: "artifact_immutable", message: `refusing to overwrite ${input.relativePath}` };
        }
        const bytes = Buffer.from(input.bytesBase64, "base64");
        const hash = createHash("sha256").update(bytes).digest("hex");
        files.set(key, { bytesBase64: input.bytesBase64, hash, size: bytes.length });
        writesAccepted += 1;
        return { ok: true, hash, size: bytes.length };
      }
      if (input.op === "read") {
        const stored = files.get(key);
        if (!stored) return { ok: true, missing: true };
        return { ok: true, ...stored };
      }
      if (input.op === "stat") {
        const stored = files.get(key);
        return stored ? { ok: true, hash: stored.hash, size: stored.size } : { ok: true, missing: true };
      }
      if (input.op === "remove") {
        files.delete(key);
        return { ok: true };
      }
      return { ok: true };
    },
  };
}

async function load(catalog: Catalog = {}, experimental_callHostRpc?: (call: { method: string; hostId: string; input: unknown }) => Promise<unknown>) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "agency",
    sdk: catalogSdk(catalog),
    experimental_callHostRpc,
  });
  await plugin(bb);
  return { bb, harness };
}

async function rpc<T>(harness: Awaited<ReturnType<typeof load>>["harness"], method: string, input: unknown): Promise<T> {
  return harness.behavior.callRpc(method, input) as Promise<T>;
}

async function requireOk<T>(envelope: DomainEnvelope<T>, label: string): Promise<T> {
  if (!envelope.ok) throw new Error(`${label}: ${envelope.error.code} ${envelope.error.message}`);
  return envelope.value;
}

async function seedWorkspace(harness: Awaited<ReturnType<typeof load>>["harness"]) {
  const policy = await requireOk(
    await rpc<DomainEnvelope<{ id: string }>>(harness, "createPolicyVersion", {
      requestId: requestId(),
      allowedCapabilities: ["read.files"],
      cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_mini"] },
      secretRefs: ["OPENAI_API_KEY"],
    }),
    "policy",
  );
  const agent = await requireOk(
    await rpc<DomainEnvelope<{ agent: { id: string; name: string } }>>(harness, "provisionAgent", {
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
    await rpc<DomainEnvelope<{ department: { id: string; name: string } }>>(harness, "provisionDepartment", {
      requestId: requestId(),
      name: "Редактура",
      leadAgentId: agent.agent.id,
      process: {
        instructions: "Черновик, затем проверка.",
        acceptance: "Есть принятая версия файла.",
        reviewPolicy: { required: true },
      },
    }),
    "department",
  );
  const binding = await requireOk(
    await rpc<DomainEnvelope<{ id: string; hostId: string; canonicalRoot: string; bbProjectId: string; revision: number }>>(
      harness,
      "createProjectBinding",
      {
        requestId: requestId(),
        bbProjectId: "proj_trusted",
        environmentId: "env_local01",
        hostId: "host_mini",
        canonicalRoot: ROOT,
        policyVersionId: policy.id,
        sectionId: null,
      },
    ),
    "binding",
  );
  await requireOk(
    await rpc<DomainEnvelope>(harness, "linkDepartment", {
      requestId: requestId(),
      bindingId: binding.id,
      departmentId: department.department.id,
    }),
    "link",
  );
  const job = await requireOk(
    await rpc<DomainEnvelope<{ id: string; title: string; revision: number; bindingId: string }>>(harness, "createJob", {
      requestId: requestId(),
      key: "AG-101",
      bindingId: binding.id,
      departmentId: department.department.id,
      title: "Карточка",
      brief: "Собрать.",
      acceptance: "Текст принят.",
      parentJobId: null,
      assignedAgentId: agent.agent.id,
      priority: "normal",
      dueAt: null,
    }),
    "job",
  );
  return { policy, agent: agent.agent, department: department.department, binding, job };
}

describe("agency domain RPC", () => {
  it("records installation-owner: system actor, SQLite scope, projects.list is not grant", () => {
    expect(SDK_RPC_AUTH).toMatchObject({
      handlerArity: "input-only",
      callerFieldsOnHandler: false,
      inputActorAccepted: false,
      projectsListIsCallerScope: false,
      projectsListRole: "create-binding-existence",
      privilegedGate: "installation-owner",
      actor: "system",
      missingOrigin: "allowed",
      originIsSecret: false,
    });
  });

  it("keeps notify and status working and does not start runtime", async () => {
    const { harness } = await load();
    try {
      expect(await rpc(harness, "notify", signal)).toMatchObject({
        accepted: true,
        duplicate: false,
        execution: "unavailable",
      });
      expect(await rpc(harness, "status", null)).toMatchObject({
        execution: "requires_readiness",
        inboxCount: 1,
      });
      expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("rejects actor, isAdmin and allowedBindings on domain input", async () => {
    const { harness } = await load();
    try {
      await expect(
        rpc(harness, "listWorkspace", { actor: { kind: "user", userId: "usr_spoof" }, isAdmin: true }),
      ).rejects.toThrow();
      await expect(
        rpc(harness, "createJob", {
          requestId: requestId(),
          key: "AG-101",
          bindingId: "binding_aaaaaaaa",
          departmentId: "departme_aaaaaaaa",
          title: "X",
          brief: "Brief",
          acceptance: "Done",
          parentJobId: null,
          assignedAgentId: null,
          priority: "normal",
          dueAt: null,
          allowedBindings: ["binding_aaaaaaaa"],
          isAdmin: true,
        }),
      ).rejects.toThrow();
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("lists an empty workspace without calling projects.list and bootstraps the first binding", async () => {
    const { harness } = await load();
    try {
      const empty = await rpc<DomainEnvelope<{ bindings: unknown[]; jobs: unknown[] }>>(harness, "listWorkspace", {});
      expect(empty).toMatchObject({ ok: true, value: { bindings: [], jobs: [] } });
      expect(harness.inspection.sdk.callsTo("projects.list")).toHaveLength(0);

      const seeded = await seedWorkspace(harness);
      expect(harness.inspection.sdk.callsTo("projects.list")).toHaveLength(1);
      expect(harness.inspection.sdk.callsTo("environments.get")).toHaveLength(1);
      expect(harness.inspection.sdk.callsTo("hosts.list")).toHaveLength(1);

      const listed = await rpc<
        DomainEnvelope<{
          bindings: Array<{ id: string; bbProjectName: string; environmentName: string | null; hostName: string | null }>;
          jobs: Array<{ id: string; title: string }>;
        }>
      >(harness, "listWorkspace", {});
      expect(listed).toMatchObject({ ok: true });
      if (!listed.ok) throw new Error("list");
      expect(listed.value.bindings.map((row) => row.id)).toEqual([seeded.binding.id]);
      expect(listed.value.bindings[0]).toMatchObject({
        bbProjectName: "SelfyStudio",
        environmentName: "локально",
        hostName: "Mac mini",
      });
      expect(listed.value.jobs.map((row) => row.id)).toEqual([seeded.job.id]);
      expect(harness.inspection.sdk.callsTo("projects.list").length).toBeGreaterThan(1);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("exposes BB catalog names for binding forms without inventing a BB project", async () => {
    const { harness } = await load();
    try {
      const emptyCatalog = await requireOk(
        await rpc<
          DomainEnvelope<{
            projects: Array<{ id: string; name: string }>;
            environments: Array<{
              id: string;
              projectId: string;
              hostId: string;
              hostName: string;
              path: string;
              label: string;
            }>;
            policies: Array<{ id: string; label: string }>;
            skills: Array<{ id: string; label: string; source: string }>;
            mcps: Array<{ id: string }>;
            skillDiscovery: string;
            mcpDiscovery: string;
          }>
        >(harness, "listBbCatalog", null),
        "catalog",
      );
      expect(emptyCatalog.projects).toEqual([
        { id: "proj_trusted", name: "SelfyStudio" },
        { id: "proj_other", name: "OtherStudio" },
      ]);
      expect(emptyCatalog.environments).toEqual([
        {
          id: "env_local01",
          projectId: "proj_trusted",
          hostId: "host_mini",
          hostName: "Mac mini",
          path: ROOT,
          label: "локально",
        },
      ]);
      expect(emptyCatalog.policies).toEqual([]);
      expect(emptyCatalog.skills.map((row) => row.label)).toEqual([
        "agency",
        "model-task-prompts",
        "agency-artifacts",
        "telegram-ads-method",
        "ru-text",
      ]);
      expect(emptyCatalog.skills[0]).toEqual({
        id: "skill_6153a163aaaa",
        label: "agency",
        source: "plugin:agency",
      });
      expect(emptyCatalog.skills.some((row) => row.label === "copywriter")).toBe(false);
      expect(emptyCatalog.mcps).toEqual([]);
      expect(emptyCatalog.skillDiscovery).toBe("sdk");
      expect(emptyCatalog.mcpDiscovery).toBe("unavailable");
      expect(JSON.stringify(emptyCatalog.skills)).not.toContain("filePath");

      const policy = await requireOk(
        await rpc<DomainEnvelope<{ id: string }>>(harness, "createPolicyVersion", {
          requestId: requestId(),
          allowedCapabilities: ["read.files"],
          cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_mini"] },
          secretRefs: ["OPENAI_API_KEY"],
        }),
        "policy",
      );
      const withPolicy = await requireOk(
        await rpc<DomainEnvelope<{ policies: Array<{ id: string; label: string }> }>>(harness, "listBbCatalog", null),
        "catalog-policy",
      );
      expect(withPolicy.policies).toEqual([{ id: policy.id, label: "Политика · read.files" }]);

      const env = emptyCatalog.environments[0];
      const project = emptyCatalog.projects.find((row) => row.id === env.projectId);
      expect(project?.name).toBe("SelfyStudio");
      const binding = await requireOk(
        await rpc<DomainEnvelope<{ id: string; bbProjectId: string }>>(harness, "createProjectBinding", {
          requestId: requestId(),
          bbProjectId: env.projectId,
          environmentId: env.id,
          hostId: env.hostId,
          canonicalRoot: env.path,
          policyVersionId: policy.id,
          sectionId: null,
        }),
        "binding-from-catalog",
      );
      expect(binding.bbProjectId).toBe("proj_trusted");
      expect(harness.inspection.sdk.callsTo("projects.create")).toHaveLength(0);
      await expect(
        rpc(harness, "createBbProject", {
          requestId: requestId(),
          name: "Новый корпус",
          hostId: env.hostId,
          path: env.path,
        }),
      ).rejects.toThrow();
      expect(harness.inspection.sdk.callsTo("projects.create")).toHaveLength(0);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("exposes a read-only capability catalog without claiming isolation or MCP delivery", async () => {
    const { harness } = await load();
    try {
      const catalog = await requireOk(
        await rpc<
          DomainEnvelope<{
            skills: Array<{ id: string; label: string; source: string }>;
            mcps: unknown[];
            skillDiscovery: string;
            mcpDiscovery: string;
            isolation: { execution: string; catalogSkillsIsolated: boolean };
          }>
        >(harness, "listCapabilityCatalog", {}),
        "capabilities",
      );
      expect(catalog.skills.map((row) => ({ id: row.id, label: row.label }))).toEqual([
        { id: "skill_6153a163aaaa", label: "agency" },
        { id: "skill_41e7026daaaa", label: "model-task-prompts" },
        { id: "skill_dffe1cd2aaaa", label: "agency-artifacts" },
        { id: "skill_4eb429d2aaaa", label: "telegram-ads-method" },
        { id: "skl_ru000001", label: "ru-text" },
      ]);
      expect(catalog.skills.find((row) => row.label === "agency")?.source).toBe("plugin:agency");
      expect(catalog.mcps).toEqual([]);
      expect(catalog.skillDiscovery).toBe("sdk");
      expect(catalog.mcpDiscovery).toBe("unavailable");
      expect(catalog.isolation).toMatchObject({ execution: "unavailable", catalogSkillsIsolated: false });
    } finally {
      await harness.lifecycle.dispose();
    }

    const broken = await load({ skillsList: "throw" });
    try {
      const listed = await requireOk(
        await rpc<DomainEnvelope<{ skills: unknown[]; skillDiscovery: string }>>(broken.harness, "listBbCatalog", null),
        "catalog-without-skills",
      );
      expect(listed.skills).toEqual([]);
      expect(listed.skillDiscovery).toBe("unavailable");
      expect(
        await rpc<DomainEnvelope>(broken.harness, "listCapabilityCatalog", {}),
      ).toMatchObject({ ok: false, error: { code: "capability_catalog_unavailable" } });
    } finally {
      await broken.harness.lifecycle.dispose();
    }
  });

  it("persists rename and membership through existing stage-1 mutations", async () => {
    const { harness } = await load();
    try {
      const seeded = await seedWorkspace(harness);
      const second = await requireOk(
        await rpc<DomainEnvelope<{ agent: { id: string } }>>(harness, "provisionAgent", {
          requestId: requestId(),
          name: "Рецензент",
          state: "active",
          version: {
            version: 1,
            role: "reviewer",
            instructions: "Проверять черновик.",
            providerId: "codex",
            model: "gpt-5.6",
            skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
            mcpIds: [],
            policyVersionId: seeded.policy.id,
          },
        }),
        "second-agent",
      );
      const renamedAgent = await requireOk(
        await rpc<DomainEnvelope<{ name: string }>>(harness, "updateAgent", {
          requestId: requestId(),
          agentId: seeded.agent.id,
          expectedRevision: 1,
          name: "Старший редактор",
        }),
        "rename-agent",
      );
      expect(renamedAgent.name).toBe("Старший редактор");
      const renamedDept = await requireOk(
        await rpc<DomainEnvelope<{ name: string }>>(harness, "updateDepartment", {
          requestId: requestId(),
          departmentId: seeded.department.id,
          expectedRevision: 1,
          name: "Редактура плюс",
        }),
        "rename-dept",
      );
      expect(renamedDept.name).toBe("Редактура плюс");
      const membership = await requireOk(
        await rpc<DomainEnvelope<{ agentId: string; role: string }>>(harness, "addMembership", {
          requestId: requestId(),
          departmentId: seeded.department.id,
          agentId: second.agent.id,
          role: "member",
        }),
        "membership",
      );
      expect(membership).toMatchObject({ agentId: second.agent.id, role: "executor" });
      const renamedJob = await requireOk(
        await rpc<DomainEnvelope<{ title: string }>>(harness, "updateJob", {
          requestId: requestId(),
          jobId: seeded.job.id,
          expectedRevision: seeded.job.revision,
          title: "Карточка v2",
        }),
        "rename-job",
      );
      expect(renamedJob.title).toBe("Карточка v2");

      const workspace = await requireOk(
        await rpc<
          DomainEnvelope<{
            agents: Array<{ id: string; name: string }>;
            departments: Array<{ id: string; name: string }>;
            jobs: Array<{ id: string; title: string }>;
          }>
        >(harness, "listWorkspace", {}),
        "workspace-after-rename",
      );
      expect(workspace.agents.find((row) => row.id === seeded.agent.id)?.name).toBe("Старший редактор");
      expect(workspace.departments.find((row) => row.id === seeded.department.id)?.name).toBe("Редактура плюс");
      expect(workspace.jobs.find((row) => row.id === seeded.job.id)?.title).toBe("Карточка v2");
      const detail = await requireOk(
        await rpc<DomainEnvelope<{ memberships: Array<{ agentId: string; role: string }> }>>(
          harness,
          "getDepartment",
          { departmentId: seeded.department.id },
        ),
        "dept-detail",
      );
      expect(detail.memberships.some((row) => row.agentId === second.agent.id && row.role === "executor")).toBe(true);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("checks effective assignee and blocks unsafe cross-binding moves", async () => {
    const { harness } = await load({
      environments: {
        env_local01: { id: "env_local01", projectId: "proj_trusted", hostId: "host_mini", path: ROOT, name: "локально" },
        env_other01: { id: "env_other01", projectId: "proj_other", hostId: "host_mini", path: OTHER_ROOT, name: "другой" },
      },
    });
    try {
      const seeded = await seedWorkspace(harness);
      const reviewer = await requireOk(
        await rpc<DomainEnvelope<{ agent: { id: string } }>>(harness, "provisionAgent", {
          requestId: requestId(),
          name: "Рецензент",
          state: "active",
          version: {
            version: 1,
            role: "reviewer",
            instructions: "Проверять.",
            providerId: "codex",
            model: "gpt-5.6",
            skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
            mcpIds: [],
            policyVersionId: seeded.policy.id,
          },
        }),
        "reviewer",
      );
      const reviewDept = await requireOk(
        await rpc<DomainEnvelope<{ department: { id: string } }>>(harness, "provisionDepartment", {
          requestId: requestId(),
          name: "Проверка",
          leadAgentId: reviewer.agent.id,
          process: {
            instructions: "Проверить файл.",
            acceptance: "Замечаний нет.",
            reviewPolicy: { required: true },
          },
        }),
        "review-dept",
      );
      await requireOk(
        await rpc<DomainEnvelope>(harness, "linkDepartment", {
          requestId: requestId(),
          bindingId: seeded.binding.id,
          departmentId: reviewDept.department.id,
        }),
        "link-same-binding",
      );
      expect(
        await rpc<DomainEnvelope>(harness, "updateJob", {
          requestId: requestId(),
          expectedRevision: seeded.job.revision,
          jobId: seeded.job.id,
          departmentId: reviewDept.department.id,
        }),
      ).toMatchObject({ ok: false, error: { code: "assignee_not_member" } });

      const otherBinding = await requireOk(
        await rpc<DomainEnvelope<{ id: string }>>(harness, "createProjectBinding", {
          requestId: requestId(),
          bbProjectId: "proj_other",
          environmentId: "env_other01",
          hostId: "host_mini",
          canonicalRoot: OTHER_ROOT,
          policyVersionId: seeded.policy.id,
          sectionId: null,
        }),
        "other-binding",
      );
      await requireOk(
        await rpc<DomainEnvelope>(harness, "linkDepartment", {
          requestId: requestId(),
          bindingId: otherBinding.id,
          departmentId: reviewDept.department.id,
        }),
        "link-other",
      );
      await requireOk(
        await rpc<DomainEnvelope>(harness, "createJob", {
          requestId: requestId(),
          key: "AG-201",
          bindingId: seeded.binding.id,
          departmentId: seeded.department.id,
          title: "Подзадача",
          brief: "Часть.",
          acceptance: "Готово.",
          parentJobId: seeded.job.id,
          assignedAgentId: null,
          priority: "normal",
          dueAt: null,
        }),
        "child",
      );
      expect(
        await rpc<DomainEnvelope>(harness, "updateJob", {
          requestId: requestId(),
          expectedRevision: seeded.job.revision,
          jobId: seeded.job.id,
          bindingId: otherBinding.id,
          departmentId: reviewDept.department.id,
          assignedAgentId: reviewer.agent.id,
        }),
      ).toMatchObject({ ok: false, error: { code: "job_has_children" } });

      const empty = await requireOk(
        await rpc<DomainEnvelope<{ id: string; revision: number }>>(harness, "createJob", {
          requestId: requestId(),
          key: "AG-202",
          bindingId: seeded.binding.id,
          departmentId: seeded.department.id,
          title: "Пустая",
          brief: "Без файлов.",
          acceptance: "Нет файла.",
          parentJobId: null,
          assignedAgentId: null,
          priority: "normal",
          dueAt: null,
        }),
        "empty-job",
      );
      await requireOk(
        await rpc<DomainEnvelope>(harness, "createArtifact", { requestId: requestId(), jobId: empty.id }),
        "empty-artifact",
      );
      expect(
        await rpc<DomainEnvelope>(harness, "updateJob", {
          requestId: requestId(),
          expectedRevision: empty.revision,
          jobId: empty.id,
          bindingId: otherBinding.id,
          departmentId: reviewDept.department.id,
        }),
      ).toMatchObject({ ok: false, error: { code: "job_has_artifacts" } });

      const queued = await requireOk(
        await rpc<DomainEnvelope<{ id: string; revision: number }>>(harness, "createJob", {
          requestId: requestId(),
          key: "AG-203",
          bindingId: seeded.binding.id,
          departmentId: seeded.department.id,
          title: "В очереди",
          brief: "Запуск.",
          acceptance: "Нет.",
          parentJobId: null,
          assignedAgentId: seeded.agent.id,
          priority: "normal",
          dueAt: null,
        }),
        "queued-job",
      );
      expect(queued.revision).toBeGreaterThan(1);
      expect(
        await rpc<DomainEnvelope>(harness, "updateJob", {
          requestId: requestId(),
          expectedRevision: queued.revision,
          jobId: queued.id,
          bindingId: otherBinding.id,
          departmentId: reviewDept.department.id,
          assignedAgentId: reviewer.agent.id,
        }),
      ).toMatchObject({ ok: false, error: { code: "job_has_run" } });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("rejects invented host, root and project on create and does not grant via projects.list", async () => {
    const { harness } = await load();
    try {
      const policy = await requireOk(
        await rpc<DomainEnvelope<{ id: string }>>(harness, "createPolicyVersion", {
          requestId: requestId(),
          allowedCapabilities: ["read.files"],
          cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_mini"] },
          secretRefs: ["OPENAI_API_KEY"],
        }),
        "policy",
      );
      const base = {
        requestId: requestId(),
        environmentId: "env_local01",
        hostId: "host_mini",
        canonicalRoot: ROOT,
        policyVersionId: policy.id,
        sectionId: null,
      };
      expect(
        await rpc<DomainEnvelope>(harness, "createProjectBinding", { ...base, requestId: requestId(), bbProjectId: "proj_unknown" }),
      ).toMatchObject({ ok: false, error: { code: "untrusted_project" } });
      expect(
        await rpc<DomainEnvelope>(harness, "createProjectBinding", {
          ...base,
          requestId: requestId(),
          bbProjectId: "proj_trusted",
          hostId: "host_order",
        }),
      ).toMatchObject({ ok: false, error: { code: "untrusted_host" } });
      expect(
        await rpc<DomainEnvelope>(harness, "createProjectBinding", {
          ...base,
          requestId: requestId(),
          bbProjectId: "proj_trusted",
          canonicalRoot: OTHER_ROOT,
        }),
      ).toMatchObject({ ok: false, error: { code: "untrusted_root" } });
      expect(await rpc<DomainEnvelope>(harness, "createJob", {
        requestId: requestId(),
        key: "AG-199",
        bindingId: "binding_aaaaaaaa",
        departmentId: "departme_aaaaaaaa",
        title: "Чужой",
        brief: "Нет.",
        acceptance: "Нет.",
        parentJobId: null,
        assignedAgentId: null,
        priority: "normal",
        dueAt: null,
      })).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(
        await rpc<DomainEnvelope>(harness, "createProjectBinding", {
          ...base,
          requestId: requestId(),
          bbProjectId: "proj_trusted",
          environmentId: "env_missing1",
        }),
      ).toMatchObject({ ok: false, error: { code: "bb_environment_missing" } });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("rejects an environment that belongs to another BB project", async () => {
    const { harness } = await load({
      environments: {
        env_other01: { id: "env_other01", projectId: "proj_other", hostId: "host_mini", path: ROOT },
      },
    });
    try {
      const policy = await requireOk(
        await rpc<DomainEnvelope<{ id: string }>>(harness, "createPolicyVersion", {
          requestId: requestId(),
          allowedCapabilities: ["read.files"],
          cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_mini"] },
          secretRefs: ["OPENAI_API_KEY"],
        }),
        "policy",
      );
      expect(
        await rpc<DomainEnvelope>(harness, "createProjectBinding", {
          requestId: requestId(),
          bbProjectId: "proj_trusted",
          environmentId: "env_other01",
          hostId: "host_mini",
          canonicalRoot: ROOT,
          policyVersionId: policy.id,
          sectionId: null,
        }),
      ).toMatchObject({ ok: false, error: { code: "untrusted_project" } });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("updates a job and uploads/opens only through RPC with verified bytes", async () => {
    const host = memoryHost();
    const { harness } = await load({}, host.call);
    try {
      const seeded = await seedWorkspace(harness);
      const updated = await rpc<DomainEnvelope<{ title: string; revision: number }>>(harness, "updateJob", {
        requestId: requestId(),
        jobId: seeded.job.id,
        expectedRevision: seeded.job.revision,
        title: "Карточка услуги",
      });
      expect(updated).toMatchObject({ ok: true, value: { title: "Карточка услуги", revision: seeded.job.revision + 1 } });
      expect(
        await rpc<DomainEnvelope>(harness, "updateJob", {
          requestId: requestId(),
          jobId: seeded.job.id,
          expectedRevision: seeded.job.revision + 1,
          title: "Подмена",
          claimedBbProjectId: "proj_other",
        }),
      ).toMatchObject({ ok: false, error: { code: "untrusted_project" } });

      const artifact = await requireOk(
        await rpc<DomainEnvelope<{ id: string; jobId: string }>>(harness, "createArtifact", {
          requestId: requestId(),
          jobId: seeded.job.id,
        }),
        "artifact",
      );
      const body = "оффер";
      const bytesBase64 = Buffer.from(body).toString("base64");
      const hash = sha256(body);
      const publishInput = {
        requestId: requestId(),
        artifactId: artifact.id,
        jobId: seeded.job.id,
        relativePath: "card.md",
        mime: "text/markdown",
        size: Buffer.byteLength(body),
        hash,
        bytesBase64,
      };
      await expect(rpc(harness, "publishArtifactVersion", { ...publishInput, bytesBase64: undefined })).rejects.toThrow();
      await expect(
        rpc(harness, "publishArtifactVersion", { ...publishInput, requestId: requestId(), hash: "b".repeat(64) }),
      ).resolves.toMatchObject({ ok: false, error: { code: "artifact_hash_mismatch" } });

      const writesBefore = host.calls.filter((call) => call.op === "writeAtomic").length;
      const published = await rpc<DomainEnvelope<{ author: { kind: string }; hostId: string; version: number; hash: string }>>(
        harness,
        "publishArtifactVersion",
        publishInput,
      );
      expect(published).toMatchObject({
        ok: true,
        value: { author: { kind: "system" }, hostId: "host_mini", version: 1, hash },
      });
      const writes = host.calls.filter((call) => call.op === "writeAtomic");
      expect(writes.length).toBe(writesBefore + 1);
      expect(writes.at(-1)).toMatchObject({ method: "fileOp", hostId: "host_mini", root: ROOT, op: "writeAtomic" });
      expect(host.find(`.agency/originals/${artifact.id}/v1`)?.[1]).toMatchObject({ hash, bytesBase64 });

      const clobber = await host.call({
        method: "fileOp",
        hostId: "host_mini",
        input: {
          op: "writeAtomic",
          canonicalRoot: ROOT,
          relativePath: `.agency/originals/${artifact.id}/v1`,
          bytesBase64: Buffer.from("other").toString("base64"),
        },
      });
      expect(clobber).toMatchObject({ ok: false, code: "artifact_immutable" });
      expect(host.find(`.agency/originals/${artifact.id}/v1`)?.[1].bytesBase64).toBe(bytesBase64);

      const opened = await rpc<DomainEnvelope<{
        hostId: string;
        hash: string;
        bytesBase64: string;
        size: number;
        target: { hostId: string; path: string };
      }>>(
        harness,
        "openArtifact",
        { artifactId: artifact.id, jobId: seeded.job.id, version: 1 },
      );
      expect(opened).toMatchObject({ ok: true, value: { hostId: "host_mini", hash, bytesBase64, size: Buffer.byteLength(body) } });
      if (!opened.ok) throw new Error("open");
      expect(opened.value.target).toEqual({
        hostId: "host_mini",
        path: `${ROOT}/.agency/preview/${artifact.id}/${hash}.md`,
      });
      expect(opened.value.target.path).not.toContain("originals");
      expect(opened.value.target.path.endsWith(".md")).toBe(true);
      expect(host.find(`.agency/preview/${artifact.id}/${hash}.md`)?.[1]).toMatchObject({ hash, bytesBase64 });
      expect(sha256(Buffer.from(opened.value.bytesBase64, "base64").toString())).toBe(opened.value.hash);
      const accepted = await rpc<DomainEnvelope<{ version: number; hash: string }>>(harness, "acceptArtifactVersion", {
        requestId: requestId(),
        expectedRevision: seeded.job.revision + 1,
        jobId: seeded.job.id,
        artifactId: artifact.id,
        version: 1,
        hash,
      });
      expect(accepted).toMatchObject({ ok: true, value: { version: 1, hash } });

      expect(artifactVersionSchema.safeParse({
        artifactId: artifact.id,
        jobId: seeded.job.id,
        version: 1,
        hostId: "host_mini",
        relativePath: "card.md",
        mime: "text/markdown",
        size: Buffer.byteLength(body),
        hash,
        author: { kind: "system" },
      }).success).toBe(true);

      const stored = host.find(`.agency/originals/${artifact.id}/v1`);
      if (!stored) throw new Error("original missing after upload");
      stored[1].bytesBase64 = Buffer.from("tampered").toString("base64");
      stored[1].hash = sha256("tampered");
      stored[1].size = Buffer.byteLength("tampered");
      expect(
        await rpc<DomainEnvelope>(harness, "openArtifact", {
          artifactId: artifact.id,
          jobId: seeded.job.id,
          version: 1,
        }),
      ).toMatchObject({ ok: false, error: { code: "artifact_hash_mismatch" } });

      host.files.delete(stored[0]);
      expect(
        await rpc<DomainEnvelope>(harness, "openArtifact", {
          artifactId: artifact.id,
          jobId: seeded.job.id,
          version: 1,
        }),
      ).toMatchObject({ ok: false, error: { code: "artifact_file_missing" } });

      await expect(
        rpc(harness, "publishArtifactVersion", {
          ...publishInput,
          requestId: requestId(),
          author: { kind: "user", userId: "usr_spoof" },
          hostId: "host_order",
        }),
      ).rejects.toThrow();
      await expect(
        rpc(harness, "openArtifact", {
          artifactId: artifact.id,
          jobId: seeded.job.id,
          version: 1,
          hostId: "host_order",
          canonicalRoot: OTHER_ROOT,
          fileOp: "read",
        }),
      ).rejects.toThrow();
      expect(await rpc<DomainEnvelope>(harness, "listWorkspace", { claimedBbProjectId: "proj_other" })).toMatchObject({
        ok: false,
        error: { code: "untrusted_project" },
      });
      const activity = await rpc<DomainEnvelope<Array<{ actor: { kind: string } }>>>(harness, "listActivity", {
        jobId: seeded.job.id,
      });
      expect(activity).toMatchObject({ ok: true });
      if (!activity.ok) throw new Error("activity");
      expect(activity.value.every((row) => row.actor.kind === "system")).toBe(true);
      expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("resolves a preview path from SQLite and computed target, then opens by ids", async () => {
    const host = memoryHost();
    const { harness } = await load({}, host.call);
    try {
      const seeded = await seedWorkspace(harness);
      const artifact = await requireOk(
        await rpc<DomainEnvelope<{ id: string }>>(harness, "createArtifact", {
          requestId: requestId(),
          jobId: seeded.job.id,
        }),
        "artifact",
      );
      const body = "оффер";
      const hash = sha256(body);
      await requireOk(
        await rpc<DomainEnvelope>(harness, "publishArtifactVersion", {
          requestId: requestId(),
          artifactId: artifact.id,
          jobId: seeded.job.id,
          relativePath: "card.md",
          mime: "text/markdown",
          size: Buffer.byteLength(body),
          hash,
          bytesBase64: Buffer.from(body).toString("base64"),
        }),
        "publish",
      );
      const opened = await requireOk(
        await rpc<DomainEnvelope<{ target: { hostId: string; path: string } }>>(harness, "openArtifact", {
          artifactId: artifact.id,
          jobId: seeded.job.id,
          version: 1,
        }),
        "open",
      );
      const opsBeforeResolve = host.calls.length;
      const resolved = await requireOk(
        await rpc<
          DomainEnvelope<{
            artifactId: string;
            jobId: string;
            version: number;
            hash: string;
            bindingId: string;
            target: { hostId: string; path: string };
          }>
        >(harness, "resolveArtifactPreview", {
          hostId: opened.target.hostId,
          path: opened.target.path,
        }),
        "resolve",
      );
      expect(resolved).toMatchObject({
        artifactId: artifact.id,
        jobId: seeded.job.id,
        version: 1,
        hash,
        bindingId: seeded.binding.id,
        target: opened.target,
      });
      expect(host.calls.length).toBe(opsBeforeResolve);
      const restored = await requireOk(
        await rpc<DomainEnvelope<{ hash: string; target: { path: string } }>>(harness, "openArtifact", {
          artifactId: resolved.artifactId,
          jobId: resolved.jobId,
          version: resolved.version,
        }),
        "restore-open",
      );
      expect(restored.hash).toBe(hash);
      expect(restored.target.path).toBe(opened.target.path);

      expect(
        await rpc<DomainEnvelope>(harness, "resolveArtifactPreview", {
          hostId: "host_mini",
          path: `${ROOT}/missing/preview.md`,
        }),
      ).toMatchObject({ ok: false, error: { code: "preview_unresolved" } });
      expect(
        await rpc<DomainEnvelope>(harness, "resolveArtifactPreview", {
          hostId: "host_order",
          path: opened.target.path,
        }),
      ).toMatchObject({ ok: false, error: { code: "preview_unresolved" } });
      expect(
        await rpc<DomainEnvelope>(harness, "resolveArtifactPreview", {
          hostId: "host_mini",
          path: `${ROOT}/.agency/originals/${artifact.id}/v1`,
        }),
      ).toMatchObject({ ok: false, error: { code: "preview_unresolved" } });
      expect(
        await rpc<DomainEnvelope>(harness, "resolveArtifactPreview", {
          hostId: "host_mini",
          path: `${ROOT}/.agency/preview/${artifact.id}/${"c".repeat(64)}.md`,
        }),
      ).toMatchObject({ ok: false, error: { code: "preview_mismatch" } });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("retries the same upload after metadata commit failure without rewriting the original", async () => {
    const host = memoryHost();
    const { bb, harness } = await load({}, host.call);
    try {
      const seeded = await seedWorkspace(harness);
      const artifact = await requireOk(
        await rpc<DomainEnvelope<{ id: string }>>(harness, "createArtifact", {
          requestId: requestId(),
          jobId: seeded.job.id,
        }),
        "artifact",
      );
      const body = "pending";
      const payload = {
        requestId: requestId(),
        artifactId: artifact.id,
        jobId: seeded.job.id,
        relativePath: "card.md",
        mime: "text/markdown",
        size: Buffer.byteLength(body),
        hash: sha256(body),
        bytesBase64: Buffer.from(body).toString("base64"),
      };
      const db = openDatabase(bb);
      let failCommit = true;
      const domain = createDomainRpc({
        bb,
        store: createDomainStore(db),
        db,
        onChanged: () => {},
        documents: bb.hosts.experimental_client({ contract: documentHostContract }),
        createMetadataPort: (ctx) => {
          const inner = createArtifactMetadataPort(db, ctx);
          return failCommit
            ? withCommitFailure(inner, { code: "metadata_unavailable", message: "injected" })
            : inner;
        },
      });
      expect(await domain.publishArtifactVersion(payload)).toMatchObject({
        ok: false,
        error: { code: "metadata_unavailable" },
      });
      expect(host.find(`.agency/originals/${artifact.id}/v1`)?.[1].bytesBase64).toBe(payload.bytesBase64);
      expect(host.writesAccepted).toBe(1);
      failCommit = false;
      const retried = await domain.publishArtifactVersion(payload);
      expect(retried).toMatchObject({ ok: true, value: { version: 1, hash: payload.hash, author: { kind: "system" } } });
      expect(host.writesAccepted).toBe(1);
      const opened = await rpc<DomainEnvelope<{ bytesBase64: string; hash: string }>>(harness, "openArtifact", {
        artifactId: artifact.id,
        jobId: seeded.job.id,
        version: 1,
      });
      expect(opened).toMatchObject({ ok: true, value: { bytesBase64: payload.bytesBase64, hash: payload.hash } });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("authors a version by the calling attempt and refuses a publish into another job", async () => {
    const host = memoryHost();
    const { bb, harness } = await load({}, host.call);
    try {
      const seeded = await seedWorkspace(harness);
      const artifact = await requireOk(
        await rpc<DomainEnvelope<{ id: string }>>(harness, "createArtifact", { requestId: requestId(), jobId: seeded.job.id }),
        "artifact",
      );
      const db = openDatabase(bb);
      db.pragma("foreign_keys = OFF");
      const attempt = (id: string, jobId: string, threadId: string) =>
        db
          .prepare(
            `INSERT INTO agency_run_attempt (id, job_id, attempt_no, snapshot_id, digest, thread_id, launch_id, state, revision, created_at, updated_at)
             VALUES (?, ?, 1, 'snp_fixture', 'digest', ?, ?, 'running', 1, '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z')`,
          )
          .run(id, jobId, threadId, randomUUID());
      attempt("run_ownjob01", seeded.job.id, "thr_worker0001");
      attempt("run_other001", "job_elsewhere01", "thr_other00001");
      db.pragma("foreign_keys = ON");
      const domain = createDomainRpc({
        bb,
        store: createDomainStore(db),
        db,
        onChanged: () => {},
        documents: bb.hosts.experimental_client({ contract: documentHostContract }),
      });
      const body = "result";
      const payload = {
        requestId: requestId(),
        artifactId: artifact.id,
        jobId: seeded.job.id,
        relativePath: "result.md",
        mime: "text/markdown",
        size: Buffer.byteLength(body),
        hash: sha256(body),
        bytesBase64: Buffer.from(body).toString("base64"),
      };
      expect(await withCallerThread("thr_other00001", () => domain.publishArtifactVersion(payload))).toMatchObject({
        ok: false,
        error: { code: "artifact_foreign_job" },
      });
      expect(await withCallerThread("thr_worker0001", () => domain.publishArtifactVersion({ ...payload, requestId: requestId() }))).toMatchObject({
        ok: true,
        value: { author: { kind: "run", runId: "run_ownjob01" } },
      });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("does not expose host fileOp or roots on the plugin RPC contract", () => {
    expect(Object.keys(rpcContract)).not.toContain("fileOp");
    expect(Object.keys(rpcContract)).not.toContain("createBbProject");
    expect(rpcContract.prepareDemoDocument.output).toBeDefined();
    expect(rpcContract.openArtifact.input).toBeDefined();
  });

  it("selects the order host via callBoundFileOp and skips host RPC without a binding", async () => {
    const calls: Array<{ method: string; hostId: string; root?: string }> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "agency",
      sdk: catalogSdk(),
      experimental_callHostRpc: async (call) => {
        const input = call.input as { canonicalRoot?: string };
        calls.push({ method: call.method, hostId: call.hostId, root: input.canonicalRoot });
        if (call.method !== "fileOp") throw new Error(`unexpected ${call.method}`);
        return { ok: true, missing: true };
      },
    });
    try {
      await plugin(bb);
      const documents = bb.hosts.experimental_client({ contract: documentHostContract });
      const binding = { hostId: "host_order", canonicalRoot: "/tmp/order-root" };
      expect(binding.hostId).not.toBe("host_primary");

      const missing = await runBoundArtifactFileOp(documents, null, { op: "stat", relativePath: "note.md" });
      expect(missing).toMatchObject({ ok: false, error: { code: "binding_missing" } });
      const emptyHost = await runBoundArtifactFileOp(
        documents,
        { hostId: "", canonicalRoot: "/tmp/order-root" },
        { op: "stat", relativePath: "note.md" },
      );
      expect(emptyHost).toMatchObject({ ok: false, error: { code: "binding_host_missing" } });
      expect(
        resolveAgencyBoundFileOp(binding, {
          op: "stat",
          relativePath: "note.md",
          canonicalRoot: "/tmp/other-root",
        }),
      ).toMatchObject({ ok: false, error: { code: "untrusted_root" } });
      expect(
        await runBoundArtifactFileOp(documents, binding, {
          op: "stat",
          relativePath: "note.md",
          canonicalRoot: "/tmp/other-root",
        }),
      ).toMatchObject({ ok: false, error: { code: "untrusted_root" } });
      expect(calls).toEqual([]);

      const selected = await runBoundArtifactFileOp(documents, binding, { op: "stat", relativePath: "note.md" });
      expect(selected).toMatchObject({ ok: true });
      expect(calls).toEqual([{ method: "fileOp", hostId: "host_order", root: "/tmp/order-root" }]);
      expect(harness.inspection.experimental_hostRpcCalls[0]).toMatchObject({
        method: "fileOp",
        hostId: "host_order",
      });

      expect(await rpc<DomainEnvelope>(harness, "openArtifact", {
        artifactId: "artifact_aaaaaaaa",
        jobId: "job_brief001aaa",
        version: 1,
      })).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(calls).toHaveLength(1);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("does not treat a failed projects.list as a grant of existing bindings", async () => {
    const { harness } = await load({ projectsList: "throw" });
    try {
      expect(await rpc<DomainEnvelope>(harness, "listWorkspace", {})).toMatchObject({
        ok: true,
        value: { bindings: [] },
      });
      const policy = await requireOk(
        await rpc<DomainEnvelope<{ id: string }>>(harness, "createPolicyVersion", {
          requestId: requestId(),
          allowedCapabilities: ["read.files"],
          cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_mini"] },
          secretRefs: ["OPENAI_API_KEY"],
        }),
        "policy",
      );
      expect(
        await rpc<DomainEnvelope>(harness, "createProjectBinding", {
          requestId: requestId(),
          bbProjectId: "proj_trusted",
          environmentId: "env_local01",
          hostId: "host_mini",
          canonicalRoot: ROOT,
          policyVersionId: policy.id,
          sectionId: null,
        }),
      ).toMatchObject({ ok: false, error: { code: "bb_catalog_unavailable" } });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("keeps existing bindings when the BB catalog later fails to list", async () => {
    const { harness } = await load({ environmentsList: "throw" });
    try {
      const seeded = await seedWorkspace(harness);
      expect(
        await rpc<DomainEnvelope>(harness, "listBbCatalog", null),
      ).toMatchObject({ ok: false, error: { code: "bb_catalog_unavailable" } });
      const listed = await requireOk(
        await rpc<
          DomainEnvelope<{
            bindings: Array<{ id: string; bbProjectName: string }>;
            jobs: Array<{ id: string }>;
          }>
        >(harness, "listWorkspace", {}),
        "workspace-after-catalog-fail",
      );
      expect(listed.bindings.map((row) => row.id)).toEqual([seeded.binding.id]);
      expect(listed.bindings[0]?.bbProjectName).toBe("proj_trusted");
      expect(listed.jobs.map((row) => row.id)).toEqual([seeded.job.id]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("rejects cross-project department, stale environment, and keeps profile versions", async () => {
    const { harness } = await load({
      environments: {
        env_local01: { id: "env_local01", projectId: "proj_trusted", hostId: "host_mini", path: ROOT, name: "локально" },
        env_other01: { id: "env_other01", projectId: "proj_other", hostId: "host_mini", path: OTHER_ROOT, name: "другой" },
      },
    });
    try {
      const seeded = await seedWorkspace(harness);
      const otherBinding = await requireOk(
        await rpc<DomainEnvelope<{ id: string }>>(harness, "createProjectBinding", {
          requestId: requestId(),
          bbProjectId: "proj_other",
          environmentId: "env_other01",
          hostId: "host_mini",
          canonicalRoot: OTHER_ROOT,
          policyVersionId: seeded.policy.id,
          sectionId: null,
        }),
        "other-binding",
      );
      // Departments are open to all projects by default; this one is restricted to its linked project.
      await requireOk(
        await rpc<DomainEnvelope<{ id: string }>>(harness, "setDepartmentAvailability", {
          requestId: requestId(),
          expectedRevision: 1,
          departmentId: seeded.department.id,
          availability: "selected",
        }),
        "restrict-department",
      );
      expect(
        await rpc<DomainEnvelope>(harness, "createJob", {
          requestId: requestId(),
          key: "AG-777",
          bindingId: otherBinding.id,
          departmentId: seeded.department.id,
          title: "Чужой отдел",
          brief: "Нет.",
          acceptance: "Нет.",
          parentJobId: null,
          assignedAgentId: null,
          priority: "normal",
          dueAt: null,
        }),
      ).toMatchObject({ ok: false, error: { code: "department_not_on_binding" } });
      expect(
        await rpc<DomainEnvelope>(harness, "updateJob", {
          requestId: requestId(),
          expectedRevision: seeded.job.revision,
          jobId: seeded.job.id,
          bindingId: otherBinding.id,
        }),
      ).toMatchObject({ ok: false, error: { code: "department_not_on_binding" } });
      expect(
        await rpc<DomainEnvelope>(harness, "createProjectBinding", {
          requestId: requestId(),
          bbProjectId: "proj_trusted",
          environmentId: "env_missing1",
          hostId: "host_mini",
          canonicalRoot: ROOT,
          policyVersionId: seeded.policy.id,
          sectionId: null,
        }),
      ).toMatchObject({ ok: false, error: { code: "bb_environment_missing" } });
      expect(
        await rpc<DomainEnvelope>(harness, "createProjectBinding", {
          requestId: requestId(),
          bbProjectId: "proj_trusted",
          environmentId: "env_local01",
          hostId: "host_mini",
          canonicalRoot: OTHER_ROOT,
          policyVersionId: seeded.policy.id,
          sectionId: null,
        }),
      ).toMatchObject({ ok: false, error: { code: "untrusted_root" } });

      const profile = await requireOk(
        await rpc<
          DomainEnvelope<{
            agent: { currentVersionId: string; revision: number };
            version: { id: string; role: string; skillIds: string[] };
          }>
        >(harness, "saveAgentProfile", {
          requestId: requestId(),
          expectedRevision: 1,
          agentId: seeded.agent.id,
          name: seeded.agent.name,
          state: "active",
          version: {
            version: 2,
            role: "Старший редактор",
            instructions: "Держать стиль канона.",
            providerId: "codex",
            model: "gpt-5.6",
            skillIds: [
              "skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff",
              "skill_41e7026daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ],
            mcpIds: [],
            policyVersionId: seeded.policy.id,
          },
        }),
        "agent-profile",
      );
      expect(profile.version).toMatchObject({
        role: "Старший редактор",
        skillIds: [
          "skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff",
          "skill_41e7026daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ],
      });
      expect(profile.agent.currentVersionId).toBe(profile.version.id);
      expect(profile.agent.revision).toBe(2);
      const process = await requireOk(
        await rpc<
          DomainEnvelope<{
            department: { processVersionId: string; revision: number };
            process: { id: string; instructions: string };
          }>
        >(harness, "saveDepartmentProfile", {
          requestId: requestId(),
          expectedRevision: 2,
          departmentId: seeded.department.id,
          name: seeded.department.name,
          leadAgentId: seeded.agent.id,
          process: {
            instructions: "Бриф, черновик, проверка.",
            acceptance: "Файл принят.",
            reviewPolicy: { required: true },
          },
        }),
        "department-profile",
      );
      expect(process.process.instructions).toBe("Бриф, черновик, проверка.");
      expect(process.department.processVersionId).toBe(process.process.id);
      expect(process.department.revision).toBe(3);
      expect(
        await rpc<DomainEnvelope>(harness, "removeMembership", {
          requestId: requestId(),
          departmentId: seeded.department.id,
          agentId: seeded.agent.id,
        }),
      ).toMatchObject({ ok: false, error: { code: "lead_role_conflict" } });

      const workspace = await requireOk(
        await rpc<
          DomainEnvelope<{
            agentVersions: Array<{ role: string; skillIds: string[] }>;
            processVersions: Array<{ instructions: string }>;
            memberships: Array<{ agentId: string; role: string }>;
            projectDepartments: Array<{ bindingId: string; departmentId: string }>;
          }>
        >(harness, "listWorkspace", {}),
        "workspace-profile",
      );
      expect(
        workspace.agentVersions.some(
          (row) =>
            row.role === "Старший редактор" &&
            row.skillIds.includes("skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"),
        ),
      ).toBe(true);
      expect(workspace.processVersions.some((row) => row.instructions === "Бриф, черновик, проверка.")).toBe(true);
      expect(workspace.memberships.some((row) => row.agentId === seeded.agent.id && row.role === "lead")).toBe(true);
      expect(workspace.projectDepartments).toEqual([{ bindingId: seeded.binding.id, departmentId: seeded.department.id }]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("saves profiles atomically with CAS and keeps create*Version detached", async () => {
    const { harness } = await load();
    try {
      const seeded = await seedWorkspace(harness);
      const before = await requireOk(
        await rpc<DomainEnvelope<{ agent: { currentVersionId: string; revision: number } }>>(
          harness,
          "getAgent",
          { agentId: seeded.agent.id },
        ),
        "agent-before",
      );
      const detached = await requireOk(
        await rpc<DomainEnvelope<{ id: string }>>(harness, "createAgentVersion", {
          requestId: requestId(),
          agentId: seeded.agent.id,
          version: 9,
          role: "Черновик окна",
          instructions: "Не активировать без CAS.",
          providerId: "codex",
          model: "gpt-5.6",
          skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
          mcpIds: [],
          policyVersionId: seeded.policy.id,
        }),
        "detached-version",
      );
      const afterDetach = await requireOk(
        await rpc<DomainEnvelope<{ agent: { currentVersionId: string; revision: number } }>>(
          harness,
          "getAgent",
          { agentId: seeded.agent.id },
        ),
        "agent-after-detach",
      );
      expect(afterDetach.agent.currentVersionId).toBe(before.agent.currentVersionId);
      expect(afterDetach.agent.revision).toBe(before.agent.revision);
      expect(detached.id).not.toBe(before.agent.currentVersionId);

      expect(
        await rpc<DomainEnvelope>(harness, "saveAgentProfile", {
          requestId: requestId(),
          expectedRevision: 99,
          agentId: seeded.agent.id,
          name: "Устаревшее окно",
          state: "paused",
          version: {
            version: 2,
            role: "Не должно активироваться",
            instructions: "Stale draft.",
            providerId: "codex",
            model: "gpt-5.6",
            skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
            mcpIds: [],
            policyVersionId: seeded.policy.id,
          },
        }),
      ).toMatchObject({ ok: false, error: { code: "revision_conflict" } });
      const stale = await requireOk(
        await rpc<DomainEnvelope<{ agent: { name: string; currentVersionId: string; revision: number } }>>(
          harness,
          "getAgent",
          { agentId: seeded.agent.id },
        ),
        "stale-unchanged",
      );
      expect(stale.agent).toMatchObject({
        name: "Редактор",
        currentVersionId: before.agent.currentVersionId,
        revision: before.agent.revision,
      });

      expect(
        await rpc<DomainEnvelope>(harness, "saveDepartmentProfile", {
          requestId: requestId(),
          expectedRevision: 1,
          departmentId: seeded.department.id,
          name: "Без состава",
          leadAgentId: seeded.agent.id,
          memberships: [],
        }),
      ).toMatchObject({ ok: false, error: { code: "lead_role_conflict" } });
      const deptAfterFail = await requireOk(
        await rpc<DomainEnvelope<{ department: { name: string; revision: number } }>>(
          harness,
          "getDepartment",
          { departmentId: seeded.department.id },
        ),
        "dept-after-fail",
      );
      expect(deptAfterFail.department.name).toBe("Редактура");
      expect(deptAfterFail.department.revision).toBe(1);

      const first = await requireOk(
        await rpc<
          DomainEnvelope<{
            agent: { currentVersionId: string; revision: number; name: string };
            version: { id: string; role: string };
          }>
        >(harness, "saveAgentProfile", {
          requestId: requestId(),
          expectedRevision: before.agent.revision,
          agentId: seeded.agent.id,
          name: "Окно A",
          state: "active",
          version: {
            version: 2,
            role: "Редактор A",
            instructions: "Сохранено окном A.",
            providerId: "codex",
            model: "gpt-5.6",
            skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
            mcpIds: [],
            policyVersionId: seeded.policy.id,
          },
        }),
        "window-a",
      );
      expect(
        await rpc<DomainEnvelope>(harness, "saveAgentProfile", {
          requestId: requestId(),
          expectedRevision: before.agent.revision,
          agentId: seeded.agent.id,
          name: "Окно B",
          state: "paused",
          version: {
            version: 2,
            role: "Редактор B",
            instructions: "Не должно затереть A.",
            providerId: "codex",
            model: "gpt-5.6",
            skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
            mcpIds: [],
            policyVersionId: seeded.policy.id,
          },
        }),
      ).toMatchObject({ ok: false, error: { code: "revision_conflict" } });
      const won = await requireOk(
        await rpc<DomainEnvelope<{ agent: { name: string; currentVersionId: string; revision: number }; version?: { role: string } }>>(
          harness,
          "getAgent",
          { agentId: seeded.agent.id },
        ),
        "winner",
      );
      expect(won.agent.name).toBe("Окно A");
      expect(won.agent.currentVersionId).toBe(first.version.id);
      expect(won.agent.revision).toBe(first.agent.revision);
      expect(won.version?.role).toBe("Редактор A");
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("treats system author as honest provenance and not a user id", () => {
    expect(sameAuthor({ kind: "system" }, { kind: "system" })).toBe(true);
    expect(sameAuthor({ kind: "system" }, { kind: "user", userId: "usr_owner" })).toBe(false);
    expect(sameAuthor({ kind: "user", userId: "usr_owner" }, { kind: "user", userId: "usr_owner" })).toBe(true);
  });
});

describe("worker context RPC",()=>{
 it("feature-tests VK, saves via the live handler and shows departmental inheritance",async()=>{
  const {bb,harness}=createFakePluginHost({pluginId:"agency",sdk:catalogSdk({})});
  let resolver:unknown;
  Object.assign(bb.agents,{experimental_vkSessionPolicy:(fn:unknown)=>{resolver=fn;},experimental_vkContextContributions:()=>[{pluginId:"agency",instructions:true,configure:false,tools:[],skills:["agency"]}]});
  await plugin(bb);
  try{
   expect(typeof resolver).toBe("function");const s=await seedWorkspace(harness);
   const input={scope:"department",scopeId:s.department.id,requestId:requestId(),expectedRevision:0,policy:{skills:{mode:"assigned",names:[]}}};
   expect(await rpc(harness,"saveWorkerContext",input)).toMatchObject({ok:true,value:{revision:1}});
   expect(await rpc(harness,"getWorkerContext",{scope:"agent",scopeId:s.agent.id})).toMatchObject({ok:true,value:{available:true,inherited:[{departmentId:s.department.id,revision:1,policy:input.policy}]}});
   expect(await rpc(harness,"saveWorkerContext",{...input,requestId:requestId()})).toMatchObject({ok:false,error:{code:"revision_conflict"}});
  }finally{await harness.lifecycle.dispose();}
 });
 it("does not claim that saved context can be enforced without the API",async()=>{
  const {harness}=await load();try{
   const s=await seedWorkspace(harness);
   expect(await rpc(harness,"getWorkerContext",{scope:"agent",scopeId:s.agent.id})).toMatchObject({ok:true,value:{available:false}});
   expect(await rpc(harness,"saveWorkerContext",{scope:"agent",scopeId:s.agent.id,requestId:requestId(),expectedRevision:0,policy:{}})).toMatchObject({ok:false,error:{code:"unsupported"}});
  }finally{await harness.lifecycle.dispose();}
 });
});
