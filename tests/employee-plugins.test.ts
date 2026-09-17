import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { pluginToolsFrom } from "../src/server/api/launch-rpc";
import { openMigratedDatabase } from "../src/server/db";
import { createPluginDirectory, isEmployeePluginCandidate, toPluginView } from "../src/server/integrations/plugin-directory";
import type { ContextSnapshot } from "../src/server/runtime/context-snapshot/types";
import { bindOfficialThreads } from "../src/server/runtime/isolated-sdk/bind-official-threads";
import { handshakeFromSpawnContract } from "../src/server/runtime/isolated-sdk/core-capability";
import { spawnArgsFromContract } from "../src/server/runtime/isolated-sdk/spawn-args";
import { createDomainStore, type ServiceContext } from "../src/server/services";
import { agentVersionSchema } from "../src/shared/contracts";

const skillId = "skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff";
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const listed = {
  plugins: [
    { id: "file-gateway", name: "File Gateway", version: "0.1.0", status: "running", enabled: true, capabilities: [{ kind: "skill", id: "file-gateway" }, { kind: "agent-tool", id: "bb_file_gateway" }], cliCommand: { name: "file-gateway" } },
    { id: "env-catalog", name: "Env Catalog", version: "0.2.0", status: "stopped", enabled: false, capabilities: [{ kind: "agent-tool", id: "env_get" }], cliCommand: null },
    { id: "agency", name: "Агентство", version: "0.1.0", status: "running", enabled: true, capabilities: [{ kind: "skill", id: "agency" }], cliCommand: { name: "agency" } },
    { id: "provider-codex", name: "Codex", version: "0.1.0", status: "running", enabled: true, capabilities: [], cliCommand: null },
  ],
};

describe("plugin directory", () => {
  it("maps tools, skills, command and running state", () => {
    const view = toPluginView(listed.plugins[0]);
    expect(view).toEqual({ id: "file-gateway", name: "File Gateway", description: null, version: "0.1.0", running: true, toolNames: ["bb_file_gateway"], hasSkill: true, hasInstructions: false, cliCommand: "file-gateway" });
    expect(toPluginView(listed.plugins[1]).running).toBe(false);
    expect(listed.plugins.map((plugin) => toPluginView(plugin)).filter((plugin) => isEmployeePluginCandidate(plugin)).map((plugin) => plugin.id)).toEqual(["file-gateway", "env-catalog"]);
  });

  it("reads thread instructions from the server bundle and offers instruction-only plugins", async () => {
    const { bundleAddsInstructions, createInstructionDetector } = await import("../src/server/integrations/plugin-directory");
    expect(bundleAddsInstructions("bb.agents.contributeInstructions(() => null)")).toBe(true);
    expect(bundleAddsInstructions("e.agents.configure(t => ({ tools: [], skills: [], instructions: 'x' }))")).toBe(true);
    expect(bundleAddsInstructions("e.agents.configure(t => ({ tools: [], skills: ['a'] }))")).toBe(false);
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "agency-plugin-"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "server.js"), "bb.agents.contributeInstructions(() => 'Use me')");
    const detect = createInstructionDetector();
    expect(detect(root)).toBe(true);
    expect(detect(join(root, "missing"))).toBe(false);
    const viewer = toPluginView({ id: "office-viewer", name: "Office Viewer", version: "1", status: "running", enabled: true, capabilities: [], cliCommand: null });
    expect(isEmployeePluginCandidate(viewer)).toBe(false);
    const guide = toPluginView({ id: "custom-instructions", name: "Custom instructions", version: "1", status: "running", enabled: true, capabilities: [], cliCommand: null, rootDir: root }, detect);
    expect(guide.hasInstructions).toBe(true);
    expect(isEmployeePluginCandidate(guide)).toBe(true);
  });

  it("caches the list and answers synchronously after the first read", async () => {
    let calls = 0;
    let clock = 0;
    const directory = createPluginDirectory({ listPlugins: async () => { calls += 1; return listed; }, now: () => clock, ttlMs: 1000 });
    expect(directory.runningCached("file-gateway")).toBe(false);
    expect(await directory.running("file-gateway")).toBe(true);
    expect(await directory.running("env-catalog")).toBe(false);
    expect(directory.runningCached("file-gateway")).toBe(true);
    expect(calls).toBe(1);
    clock = 2000;
    await directory.list();
    expect(calls).toBe(2);
  });

  it("gives tools of running plugins and stops a launch on a missing or disabled one", async () => {
    const tools = pluginToolsFrom(createPluginDirectory({ listPlugins: async () => listed }));
    expect(await tools(["file-gateway"])).toEqual({ ok: true, value: [{ pluginId: "file-gateway", toolNames: ["bb_file_gateway"] }] });
    const off = await tools(["env-catalog"]);
    expect(off.ok).toBe(false);
    if (!off.ok) expect(off.error.message).toContain("выключен");
    const missing = await tools(["telegram-projects"]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toContain("не установлен");
  });
});

describe("employee plugins in the profile", () => {
  it("validates plugin ids and stores them only on versions that have them", () => {
    const body = { id: "avr_writer01", agentId: "agt_writer01", version: 1, role: "Автор", instructions: "Пиши", providerId: "claude-code", model: "sonnet", skillIds: [skillId], mcpIds: [], policyVersionId: "pol_00000001" };
    expect(agentVersionSchema.safeParse({ ...body, pluginIds: ["file-gateway"] }).success).toBe(true);
    expect(agentVersionSchema.safeParse({ ...body, pluginIds: ["File Gateway"] }).success).toBe(false);
    expect(agentVersionSchema.safeParse({ ...body, pluginIds: ["a", "a"] }).success).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), "agy-plugins-"));
    dirs.push(dir);
    const db = openMigratedDatabase(new Database(join(dir, "agency.sqlite")));
    try {
      const store = createDomainStore(db);
      const ctx: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [] };
      const policy = store.createPolicyVersion(ctx, { requestId: randomUUID(), allowedCapabilities: ["read.files"], cliHostConstraints: { providerIds: [], hostIds: [] }, secretRefs: [] });
      if (!policy.ok) throw new Error(policy.error.message);
      const version = { version: 1, role: "Автор", instructions: "Пиши", providerId: "claude-code", model: "sonnet", skillIds: [skillId], mcpIds: [], policyVersionId: policy.value.id };
      const agent = store.provisionAgent(ctx, { requestId: randomUUID(), name: "Автор", state: "active", version });
      if (!agent.ok) throw new Error(agent.error.message);
      expect(agent.value.version.pluginIds).toBeUndefined();

      const saved = store.saveAgentProfile(ctx, { requestId: randomUUID(), expectedRevision: agent.value.agent.revision, agentId: agent.value.agent.id, name: "Автор", state: "active", version: { ...version, version: 2, pluginIds: ["file-gateway"] } });
      if (!saved.ok) throw new Error(saved.error.message);
      expect(saved.value.version.id).not.toBe(agent.value.version.id);
      expect(store.getAgentVersion(saved.value.version.id)?.pluginIds).toEqual(["file-gateway"]);

      const same = store.saveAgentProfile(ctx, { requestId: randomUUID(), expectedRevision: saved.value.agent.revision, agentId: agent.value.agent.id, name: "Автор", state: "active", version: { ...version, version: 3, pluginIds: ["file-gateway"] } });
      if (!same.ok) throw new Error(same.error.message);
      expect(same.value.version.id).toBe(saved.value.version.id);
    } finally {
      db.close();
    }
  });
});

describe("plugin allowlists in the spawn", () => {
  const contract = {
    snapshotId: "snp_aaaaaaaaaaaaaaaaaaaaaaaa",
    digest: "d".repeat(64),
    attemptId: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
    launchId: "11111111-1111-4111-8111-111111111111",
    providerId: "claude-code",
    model: "sonnet",
    skillIds: [skillId],
    mcpIds: [] as string[],
    hostId: "host_mini",
    canonicalRoot: "/tmp/agency-root",
    environmentId: "env_1",
    bbProjectId: "proj_trusted",
  };
  const snapshot = (over: Partial<ContextSnapshot> = {}) =>
    ({
      schemaVersion: 2,
      digest: "d".repeat(64),
      prompt: { digest: "p".repeat(64), levels: { platform: "p", agency: "a", project: "pr", department: "d", agent: "ag", job: "Бриф.", handoff: "" } },
      binding: { id: "bnd_aaaaaaaa", hostId: "host_mini", canonicalRoot: "/tmp/agency-root", revision: 1, bbProjectId: "proj_trusted", environmentId: "env_1", policyVersionId: "pol_aaaaaaaa" },
      ...over,
    }) as ContextSnapshot;

  it("sends nothing extra without plugins and the allowlists with them", async () => {
    const plain = spawnArgsFromContract(contract, snapshot(), "job_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(plain.ok && "instructionPluginIds" in plain.value).toBe(false);

    const built = spawnArgsFromContract(contract, snapshot({ plugins: { ids: ["file-gateway"], toolNames: ["bb_file_gateway"] } }), "job_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value).toMatchObject({ instructionPluginIds: ["file-gateway"], dynamicToolNames: ["bb_file_gateway"], allowBridgeToolProxy: true });

    const instructionsOnly = spawnArgsFromContract(contract, snapshot({ plugins: { ids: ["project-folders"], toolNames: [] } }), "job_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(instructionsOnly.ok && instructionsOnly.value.dynamicToolNames).toBeFalsy();
    expect(instructionsOnly.ok && instructionsOnly.value.allowBridgeToolProxy).toBeFalsy();

    const spawned: Record<string, unknown>[] = [];
    const threads = { spawn: async (args: Record<string, unknown>) => { spawned.push(args); return { id: "thr_1" }; }, get: async () => ({ id: "thr_1" }), list: async () => ({ threads: [] }) };
    await bindOfficialThreads(threads as never).spawn(built.value);
    expect(spawned[0]).toMatchObject({ instructionPluginIds: ["file-gateway"], dynamicToolNames: ["bb_file_gateway"], allowBridgeToolProxy: true });
  });

  it("reads plugin delivery support from the core spawn contract", () => {
    const base = {
      protocol: "bb-experimental-thread-spawn-contract-v1",
      appVersion: "0.43.1",
      fingerprint: "a".repeat(64),
      createThreadRequestKeys: ["experimental_callerLaunchId", "experimental_callerAttemptId", "experimental_callerJobId", "isolatedSkillDelivery", "skillIds", "originPluginId"],
      threadListQueryKeys: ["experimental_callerLaunchId", "originPluginId", "includeHidden"],
      threadResponseKeys: ["experimental_callerLaunchId", "experimental_callerAttemptId", "experimental_callerJobId"],
      persist: { table: "thread_caller_launches", unique: ["origin_plugin_id", "caller_launch_id"] },
      policies: { forkDoesNotInheritCallerIdentity: true, hiddenVisibilitySupported: true },
    };
    expect(handshakeFromSpawnContract(base).extensions).toEqual({ contextAllowlists: false, permissionMode: false });
    const newer = { ...base, createThreadRequestKeys: [...base.createThreadRequestKeys, "dynamicToolNames", "instructionPluginIds", "allowBridgeToolProxy", "permissionMode"] };
    expect(handshakeFromSpawnContract(newer).extensions).toEqual({ contextAllowlists: true, permissionMode: true });
  });
});
