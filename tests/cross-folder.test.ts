import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalHostFilePort } from "../src/host";
import { hashBytes } from "../src/host/guarded-fs";
import { createArtifactStorage } from "../src/server/artifacts";
import { openMigratedDatabase, type SqlDatabase } from "../src/server/db";
import { attachJobInput, loadJobInputsForPrepare } from "../src/server/runtime/prepare-run/job-input";
import { createArtifactMetadataPort, createDomainStore, type ServiceContext } from "../src/server/services";
import type { PluginFeatures } from "../src/server/services/domain-store";

const SKILL = "skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff";
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

function seed(features: PluginFeatures) {
  const db: SqlDatabase = openMigratedDatabase(new Database(join(temp("agy-cross-db-"), "agency.sqlite")));
  const flags = { ...features };
  const store = createDomainStore(db, { features: () => flags });
  const allowed: string[] = [];
  const ctx: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: allowed };
  const must = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  const policy = must(store.createPolicyVersion(ctx, { requestId: randomUUID(), allowedCapabilities: ["read.files"], cliHostConstraints: { providerIds: [], hostIds: [] }, secretRefs: [] }));
  const version = { version: 1, role: "Исполнитель", instructions: "Работать.", providerId: "claude-code", model: "sonnet", skillIds: [SKILL], mcpIds: [], policyVersionId: policy.id };
  const lead = must(store.provisionAgent(ctx, { requestId: randomUUID(), name: "Руководитель", state: "active", version }));
  const tester = must(store.provisionAgent(ctx, { requestId: randomUUID(), name: "Тестировщик", state: "active", version }));
  const department = must(store.provisionDepartment(ctx, { requestId: randomUUID(), name: "Проверка", leadAgentId: lead.agent.id, process: { instructions: "Проверять.", acceptance: "Отчёт.", reviewPolicy: { required: false } } }));
  must(store.addMembership(ctx, { requestId: randomUUID(), departmentId: department.department.id, agentId: tester.agent.id, role: "executor" }));
  const bind = (projectId: string, hostId: string, env: string) => {
    const created = must(store.createProjectBinding(ctx, { requestId: randomUUID(), bbProjectId: projectId, environmentId: env, hostId, canonicalRoot: temp(`agy-cross-${hostId}-`), policyVersionId: policy.id, sectionId: null }));
    allowed.push(created.id);
    return created;
  };
  const ovh = bind("proj_site", "host_ovh", "env_ovh");
  const job = (bindingId: string, parentJobId: string | null, assignedAgentId: string) =>
    store.createJob(ctx, { requestId: randomUUID(), bindingId, departmentId: department.department.id, title: "Задача", brief: "Бриф.", acceptance: "Критерий.", parentJobId, assignedAgentId, priority: "normal", dueAt: null });
  return { db, store, ctx, flags, must, bind, job, ovh, lead: lead.agent, tester: tester.agent, department: department.department };
}

describe("folders of one project", () => {
  it("connects a second folder of a project only with Projects & Sections", () => {
    const s = seed({ projectFolders: false, fileGateway: false });
    expect(() => s.bind("proj_site", "host_mini", "env_mini")).toThrow("Projects & Sections");
    expect(s.bind("proj_other", "host_mini", "env_other").bbProjectId).toBe("proj_other");
    s.flags.projectFolders = true;
    expect(s.bind("proj_site", "host_mini", "env_mini").hostId).toBe("host_mini");
  });

  it("places a subtask in another folder of the same project only with Projects & Sections", () => {
    const s = seed({ projectFolders: true, fileGateway: false });
    const mini = s.bind("proj_site", "host_mini", "env_mini");
    const other = s.bind("proj_other", "host_mini", "env_other");
    const parent = s.must(s.job(s.ovh.id, null, s.lead.id));
    s.flags.projectFolders = false;
    const refused = s.job(mini.id, parent.id, s.tester.id);
    expect(refused.ok || refused.error.code).toBe("integration_required");
    s.flags.projectFolders = true;
    const child = s.must(s.job(mini.id, parent.id, s.tester.id));
    expect(child.bindingId).toBe(mini.id);
    const foreign = s.job(other.id, parent.id, s.tester.id);
    expect(foreign.ok || foreign.error.code).toBe("binding_mismatch");
    // A review next to work already placed in that folder does not need the plugin again.
    s.flags.projectFolders = false;
    expect(s.job(mini.id, parent.id, s.lead.id).ok).toBe(true);
    // Jobs of one tree may depend on each other across folders.
    const sibling = s.must(s.job(s.ovh.id, parent.id, s.lead.id));
    expect(s.store.addJobDependency(s.ctx, { requestId: randomUUID(), jobId: sibling.id, dependsOnJobId: child.id }).ok).toBe(true);
  });
});

describe("employee workplace", () => {
  it("needs File Gateway, routes subtasks to the workplace and keeps other folders out", () => {
    const s = seed({ projectFolders: false, fileGateway: false });
    const desk = s.bind("proj_desk", "host_mini", "env_desk");
    const set = (bindingId: string | null) => s.store.updateAgent(s.ctx, { requestId: randomUUID(), agentId: s.tester.id, expectedRevision: s.store.getAgent(s.tester.id)!.revision, workplaceBindingId: bindingId });
    const refused = set(desk.id);
    expect(refused.ok || refused.error.code).toBe("integration_required");
    s.flags.fileGateway = true;
    expect(s.must(set(desk.id)).workplaceBindingId).toBe(desk.id);

    const parent = s.must(s.job(s.ovh.id, null, s.lead.id));
    const inFolder = s.job(s.ovh.id, parent.id, s.tester.id);
    expect(inFolder.ok || inFolder.error.code).toBe("workplace_binding_required");
    const atDesk = s.must(s.job(desk.id, parent.id, s.tester.id));
    expect(atDesk.bindingId).toBe(desk.id);

    // Without the plugin the workplace is ignored and can still be cleared.
    s.flags.fileGateway = false;
    expect(s.job(s.ovh.id, parent.id, s.tester.id).ok).toBe(true);
    expect(s.must(set(null)).workplaceBindingId).toBeUndefined();
  });

  it("does not auto-assign an employee whose workplace is elsewhere", () => {
    const s = seed({ projectFolders: false, fileGateway: true });
    const desk = s.bind("proj_desk", "host_mini", "env_desk");
    s.must(s.store.updateAgent(s.ctx, { requestId: randomUUID(), agentId: s.tester.id, expectedRevision: s.store.getAgent(s.tester.id)!.revision, workplaceBindingId: desk.id }));
    const auto = s.store.createJob(s.ctx, { requestId: randomUUID(), bindingId: s.ovh.id, departmentId: s.department.id, title: "Авто", brief: "Бриф.", acceptance: "Критерий.", parentJobId: null, assignedAgentId: null, assignment: "executor", priority: "normal", dueAt: null });
    expect(auto.ok || auto.error.code).toBe("no_member_for_assignment");
  });
});

describe("input from another machine", () => {
  it.each(["sequential", "concurrent", "corrupt", "unreadable", "write_error"] as const)("handles shared pinned inputs: %s", async (mode) => {
    const s = seed({ projectFolders: true, fileGateway: true });
    const mini = s.bind("proj_site", "host_mini", "env_mini");
    const parent = s.must(s.job(s.ovh.id, null, s.lead.id));
    const children = [0, 1].map(() => s.must(s.job(mini.id, parent.id, s.tester.id)));
    const sourceFiles = createLocalHostFilePort("host_ovh");
    const targetFiles = createLocalHostFilePort("host_mini");
    const artifact = s.must(s.store.createArtifact(s.ctx, { requestId: randomUUID(), jobId: parent.id }));
    const bytes = new TextEncoder().encode("# Shared normative input\n");
    const hash = hashBytes(bytes);
    const storage = createArtifactStorage({ metadata: createArtifactMetadataPort(s.db, s.ctx), files: sourceFiles, previewFiles: sourceFiles, previewRoot: s.ovh.canonicalRoot });
    s.must(await storage.publish({ requestId: randomUUID(), artifactId: artifact.id, jobId: parent.id, hostId: "host_ovh", relativePath: "input.md", mime: "text/markdown", size: bytes.byteLength, hash, author: { kind: "system" }, bytes }));
    const attach = (index: number, files = targetFiles) => attachJobInput({ store: s.store, db: s.db, files: sourceFiles, targetFiles: files }, s.ctx, {
      requestId: randomUUID(), targetJobId: children[index]!.id, expectedRevision: children[index]!.revision,
      sourceJobId: parent.id, artifactId: artifact.id, version: 1, hash,
    });
    if (mode === "concurrent") {
      const results = await Promise.all([attach(0), attach(1)]);
      expect(results.map(result => result.ok)).toEqual([true, true]);
    } else {
      const first = s.must(await attach(0));
      const path = join(mini.canonicalRoot, first.relativePath);
      if (mode === "corrupt") writeFileSync(path, "different bytes");
      const files = mode === "unreadable" ? { ...targetFiles, read: async () => ({ ok: false as const, error: { code: "host_file_error", message: "denied" } }) }
        : mode === "write_error" ? { ...targetFiles, writeAtomic: async () => ({ ok: false as const, error: { code: "path_escape", message: "unsafe path" } }) } : targetFiles;
      const second = await attach(1, files);
      if (mode === "sequential") expect(second.ok).toBe(true);
      else {
        expect(second.ok || second.error.code).toBe(mode === "corrupt" ? "artifact_hash_mismatch" : mode === "unreadable" ? "host_file_error" : "path_escape");
        expect(s.db.prepare("SELECT 1 FROM agency_job_input_ref WHERE target_job_id = ?").get(children[1]!.id)).toBeUndefined();
      }
      expect(readFileSync(path, "utf8")).toBe(mode === "corrupt" ? "different bytes" : new TextDecoder().decode(bytes));
    }
    if (mode === "sequential" || mode === "concurrent") {
      expect(s.db.prepare("SELECT reason FROM agency_trace WHERE step = 'input.copy' ORDER BY reason").all()).toEqual([{ reason: "created" }, { reason: "verified_existing" }]);
      for (const child of children) expect((await loadJobInputsForPrepare({ store: s.store, db: s.db, files: targetFiles }, s.ctx, child.id)).ok).toBe(true);
    }
    s.db.close();
  });

  it("copies the pinned version next to the subtask and verifies the copy at prepare", async () => {
    const s = seed({ projectFolders: true, fileGateway: true });
    const mini = s.bind("proj_site", "host_mini", "env_mini");
    const parent = s.must(s.job(s.ovh.id, null, s.lead.id));
    const child = s.must(s.job(mini.id, parent.id, s.tester.id));
    const ovhFiles = createLocalHostFilePort("host_ovh");
    const miniFiles = createLocalHostFilePort("host_mini");
    const artifact = s.must(s.store.createArtifact(s.ctx, { requestId: randomUUID(), jobId: parent.id }));
    const bytes = new TextEncoder().encode("# Сборка\nhttps://example.test\n");
    const storage = createArtifactStorage({ metadata: createArtifactMetadataPort(s.db, s.ctx), files: ovhFiles, previewFiles: ovhFiles, previewRoot: s.ovh.canonicalRoot });
    const published = await storage.publish({ requestId: randomUUID(), artifactId: artifact.id, jobId: parent.id, hostId: "host_ovh", relativePath: "build.md", mime: "text/markdown", size: bytes.byteLength, hash: hashBytes(bytes), author: { kind: "system" }, bytes });
    if (!published.ok) throw new Error(published.error.message);

    const attached = await attachJobInput({ store: s.store, db: s.db, files: ovhFiles, targetFiles: miniFiles }, s.ctx, { requestId: randomUUID(), targetJobId: child.id, expectedRevision: child.revision, sourceJobId: parent.id, artifactId: artifact.id, version: 1, hash: hashBytes(bytes) });
    if (!attached.ok) throw new Error(attached.error.message);
    expect(attached.value.hostId).toBe("host_mini");
    expect(readFileSync(join(mini.canonicalRoot, attached.value.relativePath), "utf8")).toContain("# Сборка");

    const loaded = await loadJobInputsForPrepare({ store: s.store, db: s.db, files: miniFiles }, s.ctx, child.id);
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.value.inputArtifactVersions[0]).toMatchObject({ hostId: "host_mini", relativePath: attached.value.relativePath, hash: hashBytes(bytes) });

    // An unrelated job in another folder is still refused.
    const stranger = s.must(s.job(mini.id, null, s.tester.id));
    const foreign = await attachJobInput({ store: s.store, db: s.db, files: ovhFiles, targetFiles: miniFiles }, s.ctx, { requestId: randomUUID(), targetJobId: stranger.id, expectedRevision: stranger.revision, sourceJobId: parent.id, artifactId: artifact.id, version: 1, hash: hashBytes(bytes) });
    expect(foreign.ok || foreign.error.code).toBe("foreign_scope");
  });
});

describe("placement in the job prompt layer", () => {
  it("lists other project folders and workplaces for the lead and the main job's folder for the subtask", () => {
    const s = seed({ projectFolders: true, fileGateway: true });
    const mini = s.bind("proj_site", "host_mini", "env_mini");
    s.must(s.store.updateAgent(s.ctx, { requestId: randomUUID(), agentId: s.tester.id, expectedRevision: s.store.getAgent(s.tester.id)!.revision, workplaceBindingId: mini.id }));
    const parent = s.must(s.job(s.ovh.id, null, s.lead.id));
    const leadView = s.store.placementForLaunch(parent);
    expect(leadView?.projectFolders).toEqual([{ bindingId: mini.id, hostId: "host_mini", root: mini.canonicalRoot }]);
    expect(leadView?.workplaces.map((row) => [row.name, row.bindingId])).toEqual([["Тестировщик", mini.id]]);
    expect(leadView?.parentFolder).toBeNull();

    const child = s.must(s.job(mini.id, parent.id, s.tester.id));
    expect(s.store.placementForLaunch(child)?.parentFolder).toEqual({ jobKey: parent.key, bindingId: s.ovh.id, hostId: "host_ovh", root: s.ovh.canonicalRoot });

    s.flags.projectFolders = false;
    s.flags.fileGateway = false;
    expect(s.store.placementForLaunch(parent)).toBeNull();
  });
});

describe("input copy size", () => {
  it("fits every version that can be published: no chunked copy is needed", async () => {
    const { INPUT_COPY_MAX_BYTES } = await import("../src/server/runtime/prepare-run/job-input");
    const { ARTIFACT_UPLOAD_MAX_BASE64 } = await import("../src/shared/rpc-contract");
    expect(Math.floor(ARTIFACT_UPLOAD_MAX_BASE64 / 4) * 3).toBeLessThanOrEqual(INPUT_COPY_MAX_BYTES);
  });
});
