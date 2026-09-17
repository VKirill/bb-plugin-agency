import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { CLI_EXAMPLES, EXAMPLE_CATALOG_SKILL_ID } from "../src/server/cli/examples";
import { isCliOperation } from "../src/server/cli/operations";
import { CLI_OPERATIONS } from "../src/server/cli/operations";
import { helpText } from "../src/server/cli/schema-help";
import { FILE_SOURCE_REQUIRED } from "../src/server/cli/payload";
import { redactCliValue } from "../src/server/cli/format";

const ROOT = "/work/SelfyStudio";

type DomainEnvelope<T = unknown> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

function requestId() {
  return randomUUID();
}

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function catalogSdk() {
  return {
    system: { config: async () => ({ primaryHostId: "host_primary" }) },
    projects: {
      list: async () => [{ id: "proj_trusted", name: "SelfyStudio" }],
    },
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
        skills: [{ id: EXAMPLE_CATALOG_SKILL_ID, name: "agency", scope: "plugin", pluginId: "agency", description: "Agency" }],
      }),
    },
    environments: {
      list: async () => [
        { id: "env_local01", projectId: "proj_trusted", hostId: "host_mini", path: ROOT, name: "локально" },
      ],
      get: async ({ environmentId }: { environmentId: string }) => {
        if (environmentId !== "env_local01") throw new Error("missing env");
        return { id: "env_local01", projectId: "proj_trusted", hostId: "host_mini", path: ROOT, name: "локально" };
      },
    },
  };
}

function memoryHost() {
  const files = new Map<string, { bytesBase64: string; hash: string; size: number }>();
  return {
    call: async (call: { method: string; hostId: string; input: unknown }) => {
      const input = call.input as { op?: string; canonicalRoot?: string; relativePath?: string; bytesBase64?: string };
      const key = `${call.hostId}:${input.canonicalRoot}:${input.relativePath}`;
      if (call.method !== "fileOp") throw new Error(`unexpected ${call.method}`);
      if (input.op === "writeAtomic" && input.bytesBase64) {
        const bytes = Buffer.from(input.bytesBase64, "base64");
        const hash = createHash("sha256").update(bytes).digest("hex");
        files.set(key, { bytesBase64: input.bytesBase64, hash, size: bytes.length });
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
      return { ok: true };
    },
  };
}

async function load() {
  const host = memoryHost();
  const { bb, harness } = createFakePluginHost({
    pluginId: "agency",
    sdk: catalogSdk(),
    experimental_callHostRpc: host.call,
  });
  await plugin(bb);
  return { harness };
}

function parseStdout<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

async function cliJson(harness: Awaited<ReturnType<typeof load>>["harness"], argv: string[]) {
  const result = await harness.behavior.runCli(argv);
  return result;
}

async function requireCliOk<T>(harness: Awaited<ReturnType<typeof load>>["harness"], argv: string[]): Promise<T> {
  const result = await cliJson(harness, argv);
  expect(result.exitCode, result.stderr ?? result.stdout).toBe(0);
  const body = parseStdout<DomainEnvelope<T>>(result.stdout);
  if (!body.ok) throw new Error(`${body.error.code} ${body.error.message}`);
  return body.value;
}

describe("agency CLI allowlist", () => {
  it("rejects inherited object keys as operations", () => {
    expect(isCliOperation("constructor")).toBe(false);
    expect(isCliOperation("toString")).toBe(false);
    expect(isCliOperation("valueOf")).toBe(false);
    expect(isCliOperation("__proto__")).toBe(false);
    expect(isCliOperation("hasOwnProperty")).toBe(false);
    expect(isCliOperation("listWorkspace")).toBe(true);
    expect("constructor" in CLI_OPERATIONS).toBe(true);
    expect(Object.hasOwn(CLI_OPERATIONS, "constructor")).toBe(false);
  });

  it("does not claim execution unavailable or clone-0431 in static help", () => {
    const help = helpText();
    expect(help).toContain("prepareLaunch");
    expect(help).toContain("launch readiness");
    expect(help).not.toContain("Исполнение недоступно");
    expect(help).not.toMatch(/clone 0431/i);
    expect(CLI_OPERATIONS.prepareLaunch.summary).not.toMatch(/clone 0431/i);
    expect(CLI_OPERATIONS.prepareLaunch.summary).toContain("текущем instance");
  });

  it("keeps recipe examples valid against the same schemas", () => {
    for (const [operation, example] of Object.entries(CLI_EXAMPLES)) {
      const parsed = CLI_OPERATIONS[operation as keyof typeof CLI_OPERATIONS].input.safeParse(example);
      expect(parsed.success, `${operation}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
    }
  });

  it("omits bytes and secret values from stdout", () => {
    const redacted = redactCliValue({
      bytesBase64: "AAAA",
      secret: "value",
      secretRefs: ["OPENAI_API_KEY"],
      nested: { logBytes: "xx", token: "t" },
    });
    expect(redacted).toEqual({
      bytesBase64: { omitted: true, reason: "bounded-cli" },
      secret: { omitted: true, reason: "bounded-cli" },
      secretRefs: ["OPENAI_API_KEY"],
      nested: {
        logBytes: { omitted: true, reason: "bounded-cli" },
        token: { omitted: true, reason: "bounded-cli" },
      },
    });
  });
});

describe("agency CLI → domain", () => {
  it("refuses prototype operations, unknown commands, and silent server-fs reads", async () => {
    const { harness } = await load();
    try {
      const inherited = await cliJson(harness, ["call", "constructor", "--input-json", "{}"]);
      expect(inherited.exitCode).toBe(1);
      expect(inherited.stderr).toContain("unknown operation constructor");
      const toStringOp = await cliJson(harness, ["call", "toString", "--input-json", "{}"]);
      expect(toStringOp.exitCode).toBe(1);
      expect(toStringOp.stderr).toContain("unknown operation toString");

      const unknown = await cliJson(harness, ["call", "setCliPolicy", "--input-json", "{}"]);
      expect(unknown.exitCode).toBe(1);
      expect(unknown.stderr).toContain("unknown operation setCliPolicy");

      const malformed = await cliJson(harness, ["call", "createPolicyVersion", "--input-json", "{"]);
      expect(malformed.exitCode).toBe(1);
      expect(malformed.stderr).toContain("invalid_command");

      const extra = await cliJson(harness, [
        "call",
        "createPolicyVersion",
        "--input-json",
        JSON.stringify({ requestId: requestId(), allowedCapabilities: ["read.files"], extra: true }),
      ]);
      expect(extra.exitCode).toBe(1);

      const dir = await mkdtemp(join(tmpdir(), "agency-cli-"));
      const path = join(dir, "policy.json");
      await writeFile(
        path,
        JSON.stringify({
          requestId: requestId(),
          allowedCapabilities: ["read.files"],
          cliHostConstraints: { providerIds: [], hostIds: [] },
          secretRefs: [],
        }),
      );
      const silent = await cliJson(harness, ["policy", "create", "--input-file", path]);
      expect(silent.exitCode).toBe(1);
      expect(silent.stderr).toContain(FILE_SOURCE_REQUIRED);

      const created = await cliJson(harness, ["project", "create", "--input-json", "{}"]);
      expect(created.exitCode).toBe(1);
      expect(created.stderr).toContain("creating a BB project is unsupported");
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("runs catalog/workspace/agent/department/project/job/artifact recipes and CAS", async () => {
    const { harness } = await load();
    try {
      const schema = await cliJson(harness, ["schema", "createPolicyVersion"]);
      expect(schema.exitCode, `${schema.stderr ?? ""} ${schema.stdout}`).toBe(0);
      expect(schema.stdout).toContain("allowedCapabilities");
      expect(schema.stdout).toContain("cliHostConstraints");
      expect(schema.stdout).toContain("secretRefs");
      expect(schema.stdout).not.toMatch(/ordinary/i);
      expect(schema.stdout).toContain("полному содержимому");

      const catalog = await requireCliOk<{ policies: Array<{ id: string; label: string }> }>(harness, ["catalog"]);
      expect(catalog.policies.every((row) => "label" in row && !("allowedCapabilities" in row))).toBe(true);

      const policy = await requireCliOk<{ id: string }>(harness, [
        "policy",
        "create",
        "--input-json",
        JSON.stringify({
          requestId: requestId(),
          allowedCapabilities: ["read.files"],
          cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_mini"] },
          secretRefs: ["OPENAI_API_KEY"],
        }),
      ]);

      const agent = await requireCliOk<{ agent: { id: string; name: string; revision: number }; version: { id: string } }>(
        harness,
        [
          "agent",
          "create",
          "--input-json",
          JSON.stringify({
            requestId: requestId(),
            name: "Редактор",
            state: "active",
            version: {
              version: 1,
              role: "editor",
              instructions: "Править тексты по брифу.",
              providerId: "codex",
              model: "gpt-5.6",
              skillIds: [EXAMPLE_CATALOG_SKILL_ID],
              mcpIds: [],
              policyVersionId: policy.id,
            },
          }),
        ],
      );

      const department = await requireCliOk<{ department: { id: string; revision: number } }>(harness, [
        "department",
        "create",
        "--input-json",
        JSON.stringify({
          requestId: requestId(),
          name: "Редактура",
          leadAgentId: agent.agent.id,
          process: {
            instructions: "Черновик, затем проверка.",
            acceptance: "Есть принятая версия файла.",
            reviewPolicy: { required: true },
          },
        }),
      ]);

      const binding = await requireCliOk<{ id: string }>(harness, [
        "project",
        "bind",
        "--input-json",
        JSON.stringify({
          requestId: requestId(),
          bbProjectId: "proj_trusted",
          environmentId: "env_local01",
          hostId: "host_mini",
          canonicalRoot: ROOT,
          policyVersionId: policy.id,
          sectionId: null,
        }),
      ]);

      await requireCliOk(harness, [
        "project",
        "link-department",
        "--input-json",
        JSON.stringify({
          requestId: requestId(),
          bindingId: binding.id,
          departmentId: department.department.id,
        }),
      ]);

      const workspace = await requireCliOk<{
        policies: Array<{ id: string; allowedCapabilities: string[]; secretRefs: string[] }>;
      }>(harness, ["workspace", "--binding-id", binding.id]);
      const samePolicy = workspace.policies.find(
        (item) =>
          item.id === policy.id &&
          JSON.stringify(item.allowedCapabilities) === JSON.stringify(["read.files"]) &&
          JSON.stringify(item.secretRefs) === JSON.stringify(["OPENAI_API_KEY"]),
      );
      expect(samePolicy, "reuse policy by full payload, not catalog label").toBeTruthy();

      const job = await requireCliOk<{ id: string; revision: number }>(harness, [
        "job",
        "create",
        "--input-json",
        JSON.stringify({
          requestId: requestId(),
          key: "AG-101",
          bindingId: binding.id,
          departmentId: department.department.id,
          title: "Карточка",
          brief: "Собрать.",
          acceptance: "Текст принят.",
          parentJobId: null,
          assignedAgentId: null,
          priority: "normal",
          dueAt: null,
        }),
      ]);

      await requireCliOk(harness, [
        "job",
        "assign",
        "--input-json",
        JSON.stringify({
          requestId: requestId(),
          expectedRevision: job.revision,
          jobId: job.id,
          assignedAgentId: agent.agent.id,
        }),
      ]);

      const got = await requireCliOk<{ job: { assignedAgentId: string } }>(harness, ["job", "get", "--job-id", job.id]);
      expect(got.job.assignedAgentId).toBe(agent.agent.id);

      const stale = await cliJson(harness, [
        "agent",
        "save",
        "--input-json",
        JSON.stringify({
          requestId: requestId(),
          expectedRevision: 99,
          agentId: agent.agent.id,
          name: "Редактор",
          state: "active",
          version: {
            version: 2,
            role: "editor",
            instructions: "Править тексты по брифу.",
            providerId: "codex",
            model: "gpt-5.6",
            skillIds: [EXAMPLE_CATALOG_SKILL_ID],
            mcpIds: [],
            policyVersionId: policy.id,
          },
        }),
      ]);
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr).toContain("revision_conflict");

      const artifact = await requireCliOk<{ id: string }>(harness, [
        "artifact",
        "create",
        "--input-json",
        JSON.stringify({ requestId: requestId(), jobId: job.id }),
      ]);
      const body = "note";
      const published = await requireCliOk<{ version: number; hash: string }>(harness, [
        "artifact",
        "publish",
        "--input-json",
        JSON.stringify({
          requestId: requestId(),
          artifactId: artifact.id,
          jobId: job.id,
          relativePath: "docs/note.md",
          mime: "text/markdown",
          size: Buffer.byteLength(body),
          hash: sha256(body),
          bytesBase64: Buffer.from(body).toString("base64"),
        }),
      ]);

      const opened = await cliJson(harness, [
        "artifact",
        "open",
        "--input-json",
        JSON.stringify({ artifactId: artifact.id, jobId: job.id, version: published.version }),
      ]);
      expect(opened.exitCode).toBe(0);
      expect(opened.stdout).not.toContain(Buffer.from(body).toString("base64"));
      expect(opened.stdout).toContain("omitted");

      await requireCliOk(harness, [
        "artifact",
        "accept",
        "--input-json",
        JSON.stringify({
          requestId: requestId(),
          expectedRevision: 2,
          jobId: job.id,
          artifactId: artifact.id,
          version: published.version,
          hash: published.hash,
        }),
      ]);

      const dir = await mkdtemp(join(tmpdir(), "agency-cli-ok-"));
      const path = join(dir, "save.json");
      await writeFile(
        path,
        JSON.stringify({
          requestId: requestId(),
          expectedRevision: agent.agent.revision,
          agentId: agent.agent.id,
          name: "Редактор",
          state: "paused",
          version: {
            version: 2,
            role: "editor",
            instructions: "Править тексты по брифу.",
            providerId: "codex",
            model: "gpt-5.6",
            skillIds: [EXAMPLE_CATALOG_SKILL_ID],
            mcpIds: [],
            policyVersionId: policy.id,
          },
        }),
      );
      const saved = await requireCliOk<{ agent: { state: string } }>(harness, [
        "agent",
        "save",
        "--input-file",
        path,
        "--source",
        "server-fs",
      ]);
      expect(saved.agent.state).toBe("paused");
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("creates, reads and saves an agent with a catalog skill_64hex and rejects malformed skill ids", async () => {
    const { harness } = await load();
    try {
      const policy = await requireCliOk<{ id: string }>(harness, [
        "policy",
        "create",
        "--input-json",
        JSON.stringify({
          requestId: requestId(),
          allowedCapabilities: ["read.files"],
          cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_mini"] },
          secretRefs: [],
        }),
      ]);
      const version = {
        version: 1,
        role: "editor",
        instructions: "Править тексты по брифу.",
        providerId: "codex",
        model: "gpt-5.6",
        skillIds: [EXAMPLE_CATALOG_SKILL_ID],
        mcpIds: [],
        policyVersionId: policy.id,
      };
      for (const bad of ["skl_ru000001", "ru-text", "skill_6153a163aaaa", "agent_aaaaaaaa"]) {
        const rejected = await cliJson(harness, [
          "agent",
          "create",
          "--input-json",
          JSON.stringify({ requestId: requestId(), name: "Редактор", state: "active", version: { ...version, skillIds: [bad] } }),
        ]);
        expect(rejected.exitCode, bad).toBe(1);
        expect(rejected.stderr).toContain("invalid_command");
        expect(rejected.stderr).toMatch(/skillIds/);
      }

      const created = await requireCliOk<{ agent: { id: string; revision: number }; version: { skillIds: string[]; mcpIds: string[] } }>(
        harness,
        [
          "agent",
          "create",
          "--input-json",
          JSON.stringify({ requestId: requestId(), name: "Редактор", state: "active", version }),
        ],
      );
      expect(created.version.skillIds).toEqual([EXAMPLE_CATALOG_SKILL_ID]);
      expect(created.version.mcpIds).toEqual([]);

      const got = await requireCliOk<{ version?: { skillIds: string[] } }>(harness, [
        "agent",
        "get",
        "--agent-id",
        created.agent.id,
      ]);
      expect(got.version?.skillIds).toEqual([EXAMPLE_CATALOG_SKILL_ID]);

      const saved = await requireCliOk<{ version: { skillIds: string[]; mcpIds: string[] } }>(harness, [
        "agent",
        "save",
        "--input-json",
        JSON.stringify({
          requestId: requestId(),
          expectedRevision: created.agent.revision,
          agentId: created.agent.id,
          name: "Редактор",
          state: "active",
          version: { ...version, version: 2 },
        }),
      ]);
      expect(saved.version.skillIds).toEqual([EXAMPLE_CATALOG_SKILL_ID]);
      expect(saved.version.mcpIds).toEqual([]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
