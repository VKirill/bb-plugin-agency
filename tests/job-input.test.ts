import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalHostFilePort } from "../src/host";
import { hashBytes } from "../src/host/guarded-fs";
import { createArtifactStorage } from "../src/server/artifacts";
import { openMigratedDatabase, type SqlDatabase } from "../src/server/db";
import {
  attachJobInput,
  createJobInputPort,
  createPrepareRun,
  unavailableHandshakePort,
} from "../src/server/runtime/prepare-run";
import { createRunStore } from "../src/server/runtime/run-store";
import { createArtifactMetadataPort, createDomainStore, type ServiceContext } from "../src/server/services";
import type { CatalogSkillId } from "../src/shared/contracts/ids";
import { createHash } from "node:crypto";

const AGENCY_SKILL =
  "skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff" as CatalogSkillId;
const HELPER_SKILL = `skill_${createHash("sha256").update("agency-artifacts").digest("hex")}` as CatalogSkillId;
const PLUGINS_AGENTS = readFileSync(join(import.meta.dirname, "fixtures", "agents-plugins.md"), "utf8");

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function requestId(): string {
  return randomUUID();
}

function openFileDb(): { db: SqlDatabase; close: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-input-")));
  tempDirs.push(dir);
  const db = openMigratedDatabase(new Database(join(dir, "agency.sqlite")));
  return { db, close: () => db.close() };
}

function bindingRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-input-root-")));
  tempDirs.push(dir);
  return dir;
}

function writeUtf8(root: string, relative: string, text: string) {
  const dest = join(root, relative);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text, "utf8");
}

async function seedWorkspace(db: SqlDatabase, root: string) {
  const store = createDomainStore(db);
  const bootstrap: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [] };
  const policy = store.createPolicyVersion(bootstrap, {
    requestId: requestId(),
    allowedCapabilities: ["read.files"],
    cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_mini"] },
    secretRefs: ["OPENAI_API_KEY"],
  });
  if (!policy.ok) throw new Error(policy.error.message);
  const agent = store.provisionAgent(bootstrap, {
    requestId: requestId(),
    name: "Редактор",
    state: "active",
    version: {
      version: 1,
      role: "editor",
      instructions: "Править тексты по брифу.",
      providerId: "codex",
      model: "gpt-5.6",
      skillIds: [AGENCY_SKILL],
      mcpIds: [],
      policyVersionId: policy.value.id,
    },
  });
  if (!agent.ok) throw new Error(agent.error.message);
  const department = store.provisionDepartment(bootstrap, {
    requestId: requestId(),
    name: "Редактура",
    leadAgentId: agent.value.agent.id,
    process: {
      instructions: "Черновик, затем проверка.",
      acceptance: "Есть принятая версия файла.",
      reviewPolicy: { required: true },
    },
  });
  if (!department.ok) throw new Error(department.error.message);
  const binding = store.createProjectBinding(bootstrap, {
    requestId: requestId(),
    bbProjectId: "proj_trusted",
    environmentId: "env_ucx7sb57rs",
    hostId: "host_mini",
    canonicalRoot: root,
    policyVersionId: policy.value.id,
    sectionId: null,
  });
  if (!binding.ok) throw new Error(binding.error.message);
  const ctx: ServiceContext = { actor: { kind: "user", userId: "user_kirill" }, allowedBindingIds: [binding.value.id] };
  const linked = store.linkDepartment(ctx, {
    requestId: requestId(),
    bindingId: binding.value.id,
    departmentId: department.value.department.id,
  });
  if (!linked.ok) throw new Error(linked.error.message);
  const source = store.createJob(ctx, {
    requestId: requestId(),
    key: "AG-1602",
    bindingId: binding.value.id,
    departmentId: department.value.department.id,
    title: "Источник",
    brief: "Опубликовать заметку.",
    acceptance: "Файл опубликован.",
    parentJobId: null,
    assignedAgentId: agent.value.agent.id,
    priority: "normal",
    dueAt: null,
  });
  if (!source.ok) throw new Error(source.error.message);
  const target = store.createJob(ctx, {
    requestId: requestId(),
    key: "AG-1603",
    bindingId: binding.value.id,
    departmentId: department.value.department.id,
    title: "Ревью",
    brief: "Проверить заметку.",
    acceptance: "Замечания записаны.",
    parentJobId: source.value.id,
    assignedAgentId: agent.value.agent.id,
    priority: "normal",
    dueAt: null,
  });
  if (!target.ok) throw new Error(target.error.message);
  return {
    store,
    ctx,
    binding: binding.value,
    policy: policy.value,
    department: department.value.department,
    agent: agent.value.agent,
    source: source.value,
    target: target.value,
  };
}

async function publishOnJob(
  db: SqlDatabase,
  seeded: Awaited<ReturnType<typeof seedWorkspace>>,
  jobId: string,
  text: string,
  relativePath = "notes/agy16-e2e2.md",
) {
  const artifact = seeded.store.createArtifact(seeded.ctx, { requestId: requestId(), jobId });
  if (!artifact.ok) throw new Error(artifact.error.message);
  const bytes = new TextEncoder().encode(text);
  const storage = createArtifactStorage({
    metadata: createArtifactMetadataPort(db, seeded.ctx),
    files: createLocalHostFilePort("host_mini"),
    previewFiles: createLocalHostFilePort("host_mini"),
    previewRoot: seeded.binding.canonicalRoot,
  });
  const published = await storage.publish({
    requestId: requestId(),
    artifactId: artifact.value.id,
    jobId,
    hostId: "host_mini",
    relativePath,
    mime: "text/markdown",
    size: bytes.byteLength,
    hash: hashBytes(bytes),
    author: { kind: "user", userId: "user_kirill" },
    bytes,
  });
  if (!published.ok) throw new Error(published.error.message);
  return published.value;
}

function catalogPort(seeded: Awaited<ReturnType<typeof seedWorkspace>>) {
  return {
    async list(asked: { projectId: string; environmentId: string; hostId: string }) {
      if (
        asked.projectId !== seeded.binding.bbProjectId ||
        asked.environmentId !== seeded.binding.environmentId ||
        asked.hostId !== seeded.binding.hostId
      ) {
        return { ok: false as const, error: { code: "catalog_scope_mismatch", message: "scope" } };
      }
      return {
        ok: true as const,
        value: [
          { id: AGENCY_SKILL, name: "agency", pluginId: "agency", source: "plugin:agency" },
          { id: HELPER_SKILL, name: "agency-artifacts", pluginId: "agency-artifacts", source: "plugin:agency-artifacts" },
        ],
      };
    },
    async listFiles(id: string) {
      if (id === AGENCY_SKILL) return { ok: true as const, value: ["SKILL.md", "notes.md"] };
      return { ok: true as const, value: ["SKILL.md", "templates.md"] };
    },
    async getContent(id: string, path: string) {
      const files: Record<string, Record<string, string>> = {
        [AGENCY_SKILL]: {
          "SKILL.md": "# Agency\nSee [notes](notes.md).",
          "notes.md": "notes",
        },
        [HELPER_SKILL]: {
          "SKILL.md": "# Helper\nUse [tpl](templates.md).",
          "templates.md": "tpl",
        },
      };
      const content = files[id]?.[path];
      if (content === undefined) return { ok: false as const, error: { code: "skill_file_missing", message: path } };
      return { ok: true as const, value: content };
    },
  };
}

describe("attachJobInput", () => {
  it("rejects foreign binding, wrong version/hash/missing, and does not treat parentJobId as a grant", async () => {
    const opened = openFileDb();
    const root = bindingRoot();
    writeUtf8(root, ".bb/AGENTS.md", PLUGINS_AGENTS);
    const seeded = await seedWorkspace(opened.db, root);
    const published = await publishOnJob(opened.db, seeded, seeded.source.id, "# published not accepted\n");
    const files = createLocalHostFilePort("host_mini");

    const foreignRoot = bindingRoot();
    const foreignBinding = seeded.store.createProjectBinding(
      { actor: { kind: "system" }, allowedBindingIds: [] },
      {
        requestId: requestId(),
        bbProjectId: "proj_otherxx",
        environmentId: "env_ucx7sb57rs",
        hostId: "host_mini",
        canonicalRoot: foreignRoot,
        policyVersionId: seeded.policy.id,
        sectionId: null,
      },
    );
    if (!foreignBinding.ok) throw new Error(foreignBinding.error.message);
    const foreignCtx: ServiceContext = {
      actor: { kind: "user", userId: "user_kirill" },
      allowedBindingIds: [seeded.binding.id, foreignBinding.value.id],
    };
    const linked = seeded.store.linkDepartment(foreignCtx, {
      requestId: requestId(),
      bindingId: foreignBinding.value.id,
      departmentId: seeded.department.id,
    });
    if (!linked.ok) throw new Error(linked.error.message);
    const foreignJob = seeded.store.createJob(foreignCtx, {
      requestId: requestId(),
      key: "AG-1699",
      bindingId: foreignBinding.value.id,
      departmentId: seeded.department.id,
      title: "Чужой",
      brief: "Вне scope.",
      acceptance: "Нет.",
      parentJobId: null,
      assignedAgentId: seeded.agent.id,
      priority: "normal",
      dueAt: null,
    });
    if (!foreignJob.ok) throw new Error(foreignJob.error.message);

    const foreign = await attachJobInput({ store: seeded.store, db: opened.db, files }, foreignCtx, {
      requestId: requestId(),
      expectedRevision: seeded.target.revision,
      targetJobId: seeded.target.id,
      sourceJobId: foreignJob.value.id,
      artifactId: published.artifactId,
      version: published.version,
      hash: published.hash,
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe("foreign_scope");

    const wrongHash = await attachJobInput({ store: seeded.store, db: opened.db, files }, seeded.ctx, {
      requestId: requestId(),
      expectedRevision: seeded.target.revision,
      targetJobId: seeded.target.id,
      sourceJobId: seeded.source.id,
      artifactId: published.artifactId,
      version: published.version,
      hash: "ab".repeat(32),
    });
    expect(wrongHash.ok).toBe(false);
    if (!wrongHash.ok) expect(wrongHash.error.code).toBe("artifact_hash_mismatch");

    const wrongVersion = await attachJobInput({ store: seeded.store, db: opened.db, files }, seeded.ctx, {
      requestId: requestId(),
      expectedRevision: seeded.target.revision,
      targetJobId: seeded.target.id,
      sourceJobId: seeded.source.id,
      artifactId: published.artifactId,
      version: 9,
      hash: published.hash,
    });
    expect(wrongVersion.ok).toBe(false);
    if (!wrongVersion.ok) expect(wrongVersion.error.code).toBe("not_found");

    const missing = await attachJobInput({ store: seeded.store, db: opened.db, files }, seeded.ctx, {
      requestId: requestId(),
      expectedRevision: seeded.target.revision,
      targetJobId: seeded.target.id,
      sourceJobId: seeded.source.id,
      artifactId: "art_missing0001xxxx",
      version: 1,
      hash: published.hash,
    });
    expect(missing.ok).toBe(false);

    const loaded = await createJobInputPort({ store: seeded.store, db: opened.db, files }).loadForPrepare(
      seeded.ctx,
      seeded.target.id,
    );
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.value.inputArtifactVersions).toEqual([]);
    expect(loaded.value.authorizedInputJobIds).toEqual([seeded.target.id]);
    expect(loaded.value.handoff).toBeNull();
    expect(seeded.target.parentJobId).toBe(seeded.source.id);
    opened.close();
  });

  it("is requestId-idempotent, pins the published version, and prepare snapshot lists exact authorized jobs", async () => {
    const opened = openFileDb();
    const root = bindingRoot();
    writeUtf8(root, ".bb/AGENTS.md", PLUGINS_AGENTS);
    const seeded = await seedWorkspace(opened.db, root);
    const published = await publishOnJob(opened.db, seeded, seeded.source.id, "# published AG-1602\n");
    const files = createLocalHostFilePort("host_mini");
    const attachId = requestId();
    const command = {
      requestId: attachId,
      expectedRevision: seeded.target.revision,
      targetJobId: seeded.target.id,
      sourceJobId: seeded.source.id,
      artifactId: published.artifactId,
      version: published.version,
      hash: published.hash,
    };
    const first = await attachJobInput({ store: seeded.store, db: opened.db, files }, seeded.ctx, command);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.publishedVerified).toBe(true);
    expect(first.value.accepted).toBe(false);
    expect(first.value.hostId).toBe("host_mini");
    const retry = await attachJobInput({ store: seeded.store, db: opened.db, files }, seeded.ctx, command);
    expect(retry).toEqual(first);

    const conflict = await attachJobInput({ store: seeded.store, db: opened.db, files }, seeded.ctx, {
      ...command,
      requestId: requestId(),
      hash: "cd".repeat(32),
    });
    expect(conflict.ok).toBe(false);

    const prepared = await createPrepareRun({
      store: seeded.store,
      files,
      catalog: catalogPort(seeded),
      handshake: unavailableHandshakePort(),
      runs: createRunStore(opened.db),
      jobInputs: createJobInputPort({ store: seeded.store, db: opened.db, files }),
      server: {
        applicable: [{ sourceId: "binding", relativePath: ".bb/AGENTS.md" }],
        catalogRoles: {
          core: { id: AGENCY_SKILL, source: "plugin:agency" },
          helpers: [{ id: HELPER_SKILL, source: "plugin:agency-artifacts" }],
        },
      },
    }).prepare(seeded.ctx, {
      requestId: requestId(),
      jobId: seeded.target.id,
      expectedRevision: seeded.target.revision,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.snapshot.inputArtifacts).toEqual([
      {
        artifactId: published.artifactId,
        version: published.version,
        hash: published.hash,
        jobId: seeded.source.id,
        hostId: "host_mini",
        relativePath: published.relativePath,
      },
    ]);
    expect(prepared.value.snapshot.authorizedInputJobIds).toEqual([seeded.source.id, seeded.target.id].sort());
    expect(prepared.value.snapshot.handoff).toBeNull();
    opened.close();
  });

  it("optional handoff keeps acceptedArtifacts empty for a published-only pin", async () => {
    const opened = openFileDb();
    const root = bindingRoot();
    writeUtf8(root, ".bb/AGENTS.md", PLUGINS_AGENTS);
    const seeded = await seedWorkspace(opened.db, root);
    const published = await publishOnJob(opened.db, seeded, seeded.source.id, "# still published\n");
    const files = createLocalHostFilePort("host_mini");
    const sourcePrepared = await createPrepareRun({
      store: seeded.store,
      files,
      catalog: catalogPort(seeded),
      handshake: unavailableHandshakePort(),
      runs: createRunStore(opened.db),
      server: {
        applicable: [{ sourceId: "binding", relativePath: ".bb/AGENTS.md" }],
        catalogRoles: {
          core: { id: AGENCY_SKILL, source: "plugin:agency" },
          helpers: [{ id: HELPER_SKILL, source: "plugin:agency-artifacts" }],
        },
      },
    }).prepare(seeded.ctx, {
      requestId: requestId(),
      jobId: seeded.source.id,
      expectedRevision: seeded.source.revision,
    });
    expect(sourcePrepared.ok).toBe(true);
    if (!sourcePrepared.ok) throw new Error(sourcePrepared.error.message);

    const attached = await attachJobInput({ store: seeded.store, db: opened.db, files }, seeded.ctx, {
      requestId: requestId(),
      expectedRevision: seeded.target.revision,
      targetJobId: seeded.target.id,
      sourceJobId: seeded.source.id,
      artifactId: published.artifactId,
      version: published.version,
      hash: published.hash,
      handoff: {
        priorAttemptId: sourcePrepared.value.reserved.attempt.attemptId,
        sourceSnapshotDigest: sourcePrepared.value.reserved.digest,
        reason: "reviewer needs the published note",
        questions: ["Is the note complete?"],
      },
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) throw new Error(attached.error.message);
    expect(attached.value.accepted).toBe(false);

    const loaded = await createJobInputPort({ store: seeded.store, db: opened.db, files }).loadForPrepare(
      seeded.ctx,
      seeded.target.id,
    );
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.value.handoff).not.toBeNull();
    expect(loaded.value.handoff?.acceptedArtifacts).toEqual([]);
    expect(loaded.value.handoff?.priorRunAttemptId).toBe(sourcePrepared.value.reserved.attempt.attemptId);
    opened.close();
  });
});
