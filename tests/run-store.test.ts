import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { compileContextSnapshot } from "../src/server/runtime/context-snapshot";
import { runLauncherAdapter } from "../src/server/runtime/context-snapshot/run-launcher-adapter";
import {
  createInternalRunStoreReads,
  createRunStore,
  RUN_LAUNCH_ADAPTER_CONTRACT,
  snapshotBodyDigest,
} from "../src/server/runtime/run-store";
import { openMigratedDatabase, type SqlDatabase } from "../src/server/db";
import { createDomainStore, type ServiceContext } from "../src/server/services";
import type { ContextSnapshot } from "../src/server/runtime/context-snapshot/types";
import type { CatalogSkillId } from "../src/shared/contracts/ids";

const AGENCY_SKILL =
  "skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff" as CatalogSkillId;

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

function openFileDb(): { db: SqlDatabase; path: string; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agy-run-"));
  tempDirs.push(dir);
  const path = join(dir, "agency.sqlite");
  const db = openMigratedDatabase(new Database(path));
  return { db, path, close: () => db.close() };
}

function reopen(path: string): SqlDatabase {
  return openMigratedDatabase(new Database(path));
}

function catalogHash(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

function seedProject(db: SqlDatabase) {
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
    canonicalRoot: "/work/SelfyStudio",
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
  const job = store.createJob(ctx, {
    requestId: requestId(),
    key: "AG-201",
    bindingId: binding.value.id,
    departmentId: department.value.department.id,
    title: "Карточка услуги",
    brief: "Собрать карточку.",
    acceptance: "Текст принят.",
    parentJobId: null,
    assignedAgentId: agent.value.agent.id,
    priority: "normal",
    dueAt: null,
  });
  if (!job.ok) throw new Error(job.error.message);
  const processVersion = store.getProcessVersion(department.value.department.processVersionId);
  if (!processVersion) throw new Error("process missing");
  return {
    store,
    ctx,
    policy: policy.value,
    agent: agent.value.agent,
    agentVersion: agent.value.version,
    department: department.value.department,
    processVersion,
    binding: binding.value,
    job: job.value,
  };
}

function projectRules(text: string, versionId = "rul_project1") {
  return {
    versionId,
    text,
    hash: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

function compileFor(
  seeded: ReturnType<typeof seedProject>,
  overrides: Partial<Parameters<typeof compileContextSnapshot>[0]> = {},
): ContextSnapshot {
  const result = compileContextSnapshot({
    binding: seeded.binding,
    job: seeded.job,
    agentVersion: seeded.agentVersion,
    processVersion: seeded.processVersion,
    bindingPolicyVersion: seeded.policy,
    agentPolicyVersion: seeded.policy,
    projectRules: projectRules("Писать только в canonicalRoot."),
    inputArtifactVersions: [],
    authorizedInputJobIds: [],
    catalogSkills: [{ id: AGENCY_SKILL, hash: catalogHash(AGENCY_SKILL), source: "plugin:agency", name: "agency" }],
    catalogMcps: [],
    coreSkillIds: [AGENCY_SKILL],
    helperSkillIds: [],
    providerLimits: {},
    handoff: null,
    ...overrides,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.snapshot;
}

function attestation(seeded: ReturnType<typeof seedProject>) {
  return {
    accessVerified: true as const,
    revisionsVerified: true as const,
    expectedJobRevision: seeded.job.revision,
    expectedBindingRevision: seeded.binding.revision,
  };
}

describe("run store persist", () => {
  it("keeps launch adapter unavailable and documents no automatic spawn retry", () => {
    expect(RUN_LAUNCH_ADAPTER_CONTRACT.executionAvailable).toBe(false);
    expect(RUN_LAUNCH_ADAPTER_CONTRACT.automaticSpawnRetry).toBe(false);
    expect(runLauncherAdapter.status).toBe("not_implemented");
    expect(runLauncherAdapter.executionAvailable).toBe(false);
  });

  it("reserves snapshot+attempt atomically, reopens, and does not set job running", () => {
    const opened = openFileDb();
    const seeded = seedProject(opened.db);
    const snapshot = compileFor(seeded);
    const reserved = createRunStore(opened.db).reservePreparedRun(seeded.ctx, {
      requestId: requestId(),
      snapshot,
      attestation: attestation(seeded),
    });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) throw new Error(reserved.error.message);
    expect(reserved.value.attempt.state).toBe("prepared");
    expect(reserved.value.attempt.threadId).toBeNull();
    expect(reserved.value.digest).toBe(snapshot.digest);
    expect(seeded.store.getJob(seeded.job.id)?.state).toBe("backlog");
    opened.close();

    const db = reopen(opened.path);
    try {
      const reads = createInternalRunStoreReads(db);
      const loaded = reads.getSnapshot(seeded.ctx, reserved.value.snapshotId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.digest).toBe(snapshot.digest);
        expect(loaded.value.snapshot.agentVersion.model).toBe("gpt-5.6");
      }
      const attempt = reads.getAttempt(seeded.ctx, reserved.value.attempt.attemptId);
      expect(attempt.ok).toBe(true);
      if (attempt.ok) {
        expect(attempt.value.jobId).toBe(seeded.job.id);
        expect(attempt.value.snapshotId).toBe(reserved.value.snapshotId);
        expect(attempt.value.digest).toBe(snapshot.digest);
        expect(attempt.value.threadId).toBeNull();
      }
      expect(createDomainStore(db).getJob(seeded.job.id)?.state).toBe("backlog");
    } finally {
      db.close();
    }
  });

  it("replays the same requestId and conflicts on a different payload", () => {
    const { db, close } = openFileDb();
    try {
      const seeded = seedProject(db);
      const snapshot = compileFor(seeded);
      const store = createRunStore(db);
      const rid = requestId();
      const first = store.reservePreparedRun(seeded.ctx, {
        requestId: rid,
        snapshot,
        attestation: attestation(seeded),
      });
      expect(first.ok).toBe(true);
      const replay = store.reservePreparedRun(seeded.ctx, {
        requestId: rid,
        snapshot,
        attestation: attestation(seeded),
      });
      expect(replay.ok).toBe(true);
      if (first.ok && replay.ok) {
        expect(replay.value.attempt.attemptId).toBe(first.value.attempt.attemptId);
        expect(replay.value.snapshotId).toBe(first.value.snapshotId);
      }
      const conflict = store.reservePreparedRun(seeded.ctx, {
        requestId: rid,
        snapshot: compileFor(seeded, { projectRules: projectRules("Другой payload для identity.") }),
        attestation: attestation(seeded),
      });
      expect(conflict.ok).toBe(false);
      if (!conflict.ok) expect(conflict.error.code).toBe("request_conflict");
    } finally {
      close();
    }
  });

  it("rejects a second active attempt and rolls back a new snapshot", () => {
    const { db, close } = openFileDb();
    try {
      const seeded = seedProject(db);
      const snapshot = compileFor(seeded);
      const store = createRunStore(db);
      const first = store.reservePreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshot,
        attestation: attestation(seeded),
      });
      expect(first.ok).toBe(true);
      const otherJob = seeded.store.createJob(seeded.ctx, {
        requestId: requestId(),
        key: "AG-202",
        bindingId: seeded.binding.id,
        departmentId: seeded.department.id,
        title: "Вторая",
        brief: "Другой бриф.",
        acceptance: "Текст принят.",
        parentJobId: null,
        assignedAgentId: seeded.agent.id,
        priority: "normal",
        dueAt: null,
      });
      if (!otherJob.ok) throw new Error(otherJob.error.message);
      const secondJobSnapshot = compileFor({ ...seeded, job: otherJob.value });
      const again = store.reservePreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshot: compileFor(seeded, { projectRules: projectRules("Другие правила проекта.") }),
        attestation: attestation(seeded),
      });
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.error.code).toBe("active_attempt_exists");
      const leftover = db
        .prepare(`SELECT count(*) AS n FROM agency_context_snapshot WHERE job_id = ?`)
        .get(seeded.job.id) as { n: number };
      expect(leftover.n).toBe(1);
      const other = store.reservePreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshot: secondJobSnapshot,
        attestation: {
          accessVerified: true,
          revisionsVerified: true,
          expectedJobRevision: otherJob.value.revision,
          expectedBindingRevision: seeded.binding.revision,
        },
      });
      expect(other.ok).toBe(true);
    } finally {
      close();
    }
  });

  it("CAS attempt state, requires thread for running, and distinguishes failed vs unknown", () => {
    const { db, close } = openFileDb();
    try {
      const seeded = seedProject(db);
      const snapshot = compileFor(seeded);
      const store = createRunStore(db);
      const reserved = store.reservePreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshot,
        attestation: attestation(seeded),
      });
      if (!reserved.ok) throw new Error(reserved.error.message);
      const stale = store.transitionAttempt(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        expectedRevision: 99,
        to: "launching",
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error.code).toBe("revision_conflict");

      const launching = store.transitionAttempt(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        expectedRevision: 1,
        to: "launching",
      });
      expect(launching.ok).toBe(true);
      const noThread = store.transitionAttempt(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        expectedRevision: 2,
        to: "running",
      });
      expect(noThread.ok).toBe(false);
      if (!noThread.ok) expect(noThread.error.code).toBe("thread_required");

      const running = store.transitionAttempt(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        expectedRevision: 2,
        to: "running",
        threadId: "thr_confirmed01",
      });
      expect(running.ok).toBe(true);
      if (running.ok) expect(running.value.threadId).toBe("thr_confirmed01");
      expect(seeded.store.getJob(seeded.job.id)?.state).toBe("backlog");

      const unknown = store.transitionAttempt(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        expectedRevision: 3,
        to: "unknown",
      });
      expect(unknown.ok).toBe(true);
      if (unknown.ok) expect(unknown.value.state).toBe("unknown");
      const retrySpawn = store.transitionAttempt(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        expectedRevision: 4,
        to: "launching",
      });
      expect(retrySpawn.ok).toBe(false);
      if (!retrySpawn.ok) expect(retrySpawn.error.code).toBe("no_automatic_spawn_retry");

      const failed = store.transitionAttempt(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        expectedRevision: 4,
        to: "failed",
      });
      expect(failed.ok).toBe(true);
      if (failed.ok) expect(failed.value.state).toBe("failed");
      expect(failed.ok && failed.value.state).not.toBe("unknown");
    } finally {
      close();
    }
  });

  it("refuses a colliding digest with a different stored body", () => {
    const { db, close } = openFileDb();
    try {
      const seeded = seedProject(db);
      const snapshot = compileFor(seeded);
      db.prepare(
        `INSERT INTO agency_context_snapshot (id, job_id, digest, snapshot_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("snp_collision01xx", seeded.job.id, snapshot.digest, JSON.stringify({ stolen: true }), "2026-09-14T00:00:00Z");
      const refused = createRunStore(db).reservePreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshot,
        attestation: attestation(seeded),
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(["snapshot_digest_conflict", "snapshot_corrupt"]).toContain(refused.error.code);
    } finally {
      close();
    }
  });

  it("does not treat the compiler as auth and fails corrupted snapshot rows", () => {
    const { db, close } = openFileDb();
    try {
      const seeded = seedProject(db);
      const snapshot = compileFor(seeded);
      const store = createRunStore(db);
      const noAttest = store.reservePreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshot,
        attestation: {
          accessVerified: false as unknown as true,
          revisionsVerified: true,
          expectedJobRevision: seeded.job.revision,
          expectedBindingRevision: seeded.binding.revision,
        },
      });
      expect(noAttest.ok).toBe(false);
      if (!noAttest.ok) expect(noAttest.error.code).toBe("attestation_required");

      const foreign: ServiceContext = { actor: { kind: "user", userId: "user_kirill" }, allowedBindingIds: [] };
      const forbidden = store.reservePreparedRun(foreign, {
        requestId: requestId(),
        snapshot,
        attestation: attestation(seeded),
      });
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) expect(forbidden.error.code).toBe("forbidden_binding");

      const reserved = store.reservePreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshot,
        attestation: attestation(seeded),
      });
      if (!reserved.ok) throw new Error(reserved.error.message);
      db.prepare(`UPDATE agency_context_snapshot SET snapshot_json = ? WHERE id = ?`).run(
        JSON.stringify({ ...snapshot, job: { ...snapshot.job, title: "tampered" } }),
        reserved.value.snapshotId,
      );
      const reads = createInternalRunStoreReads(db);
      const corrupt = reads.getSnapshot(seeded.ctx, reserved.value.snapshotId);
      expect(corrupt.ok).toBe(false);
      if (!corrupt.ok) expect(corrupt.error.code).toBe("snapshot_digest_mismatch");

      db.prepare(`UPDATE agency_context_snapshot SET snapshot_json = '{not-json' WHERE id = ?`).run(
        reserved.value.snapshotId,
      );
      const broken = reads.getSnapshot(seeded.ctx, reserved.value.snapshotId);
      expect(broken.ok).toBe(false);
      if (!broken.ok) expect(broken.error.code).toBe("snapshot_corrupt");
    } finally {
      close();
    }
  });

  it("rejects a self-consistent snapshot whose live identity does not match DB", () => {
    const { db, close } = openFileDb();
    try {
      const seeded = seedProject(db);
      const store = createRunStore(db);
      const foreignRoot = compileFor(seeded, {
        binding: { ...seeded.binding, canonicalRoot: "/tmp/stolen-root" },
      });
      const root = store.reservePreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshot: foreignRoot,
        attestation: attestation(seeded),
      });
      expect(root.ok).toBe(false);
      if (!root.ok) expect(root.error.code).toBe("live_binding_mismatch");

      const foreignModel = compileFor(seeded, {
        agentVersion: { ...seeded.agentVersion, model: "stolen-model" },
      });
      const model = store.reservePreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshot: foreignModel,
        attestation: attestation(seeded),
      });
      expect(model.ok).toBe(false);
      if (!model.ok) expect(model.error.code).toBe("live_version_mismatch");

      const foreignPolicy = compileFor(seeded, {
        bindingPolicyVersion: {
          ...seeded.policy,
          allowedCapabilities: ["read.files", "write.files"],
        },
      });
      const policy = store.reservePreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshot: foreignPolicy,
        attestation: attestation(seeded),
      });
      expect(policy.ok).toBe(false);
      if (!policy.ok) expect(policy.error.code).toBe("live_policy_mismatch");

      const schema1 = structuredClone(compileFor(seeded)) as ContextSnapshot;
      (schema1 as { schemaVersion: number }).schemaVersion = 1;
      schema1.digest = snapshotBodyDigest(schema1);
      const oldSchema = store.reservePreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshot: schema1,
        attestation: attestation(seeded),
      });
      expect(oldSchema.ok).toBe(false);
      if (!oldSchema.ok) expect(oldSchema.error.code).toBe("snapshot_corrupt");

      const attested = structuredClone(compileFor(seeded)) as ContextSnapshot;
      attested.provenance = {
        recordsVerifiedBy: "caller",
        compilerAttestsAuth: true as unknown as false,
      };
      attested.digest = snapshotBodyDigest(attested);
      const compilerAuth = store.reservePreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshot: attested,
        attestation: attestation(seeded),
      });
      expect(compilerAuth.ok).toBe(false);
      if (!compilerAuth.ok) expect(compilerAuth.error.code).toBe("compiler_not_auth");
    } finally {
      close();
    }
  });

  it("does not treat an out-of-scope job as an authorized upstream record", () => {
    const { db, close } = openFileDb();
    try {
      const seeded = seedProject(db);
      const bootstrap: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [] };
      const otherBinding = seeded.store.createProjectBinding(bootstrap, {
        requestId: requestId(),
        bbProjectId: "proj_other",
        environmentId: "env_other",
        hostId: "host_mini",
        canonicalRoot: "/tmp/other",
        policyVersionId: seeded.policy.id,
        sectionId: null,
      });
      if (!otherBinding.ok) throw new Error(otherBinding.error.message);
      const otherCtx: ServiceContext = {
        actor: { kind: "user", userId: "user_kirill" },
        allowedBindingIds: [otherBinding.value.id],
      };
      const linked = seeded.store.linkDepartment(otherCtx, {
        requestId: requestId(),
        bindingId: otherBinding.value.id,
        departmentId: seeded.department.id,
      });
      if (!linked.ok) throw new Error(linked.error.message);
      const foreignJob = seeded.store.createJob(otherCtx, {
        requestId: requestId(),
        key: "AG-209",
        bindingId: otherBinding.value.id,
        departmentId: seeded.department.id,
        title: "Чужой",
        brief: "Не наш бриф.",
        acceptance: "Текст принят.",
        parentJobId: null,
        assignedAgentId: seeded.agent.id,
        priority: "normal",
        dueAt: null,
      });
      if (!foreignJob.ok) throw new Error(foreignJob.error.message);
      const snapshot = compileFor(seeded, { authorizedInputJobIds: [foreignJob.value.id] });
      const refused = createRunStore(db).reservePreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshot,
        attestation: attestation(seeded),
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("unauthorized_record");
    } finally {
      close();
    }
  });

  it("keeps bound thread/launch ids and distinguishes omitted vs explicit null identity", () => {
    const { db, close } = openFileDb();
    try {
      const seeded = seedProject(db);
      const store = createRunStore(db);
      const reserved = store.reservePreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshot: compileFor(seeded),
        attestation: attestation(seeded),
      });
      if (!reserved.ok) throw new Error(reserved.error.message);
      const omitRid = requestId();
      const launching = store.transitionAttempt(seeded.ctx, {
        requestId: omitRid,
        attemptId: reserved.value.attempt.attemptId,
        expectedRevision: 1,
        to: "launching",
      });
      expect(launching.ok).toBe(true);
      const omitVsNull = store.transitionAttempt(seeded.ctx, {
        requestId: omitRid,
        attemptId: reserved.value.attempt.attemptId,
        expectedRevision: 1,
        to: "launching",
        threadId: null,
      });
      expect(omitVsNull.ok).toBe(false);
      if (!omitVsNull.ok) expect(omitVsNull.error.code).toBe("request_conflict");

      const running = store.transitionAttempt(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        expectedRevision: 2,
        to: "running",
        threadId: "thr_confirmed01",
        launchId: "lnc_confirmed01",
      });
      expect(running.ok).toBe(true);
      const rebind = store.transitionAttempt(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        expectedRevision: 3,
        to: "unknown",
        threadId: "thr_other00001",
      });
      expect(rebind.ok).toBe(false);
      if (!rebind.ok) expect(rebind.error.code).toBe("bind_id_immutable");
      const clear = store.transitionAttempt(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        expectedRevision: 3,
        to: "unknown",
        threadId: null,
      });
      expect(clear.ok).toBe(false);
      if (!clear.ok) expect(clear.error.code).toBe("bind_id_immutable");
      const keep = store.transitionAttempt(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        expectedRevision: 3,
        to: "unknown",
      });
      expect(keep.ok).toBe(true);
      if (keep.ok) {
        expect(keep.value.threadId).toBe("thr_confirmed01");
        expect(keep.value.launchId).toBe("lnc_confirmed01");
      }
    } finally {
      close();
    }
  });

  it("does not publish unscoped reads", () => {
    const { db, close } = openFileDb();
    try {
      const seeded = seedProject(db);
      const reserved = createRunStore(db).reservePreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshot: compileFor(seeded),
        attestation: attestation(seeded),
      });
      if (!reserved.ok) throw new Error(reserved.error.message);
      const reads = createInternalRunStoreReads(db);
      const foreign: ServiceContext = { actor: { kind: "user", userId: "user_kirill" }, allowedBindingIds: [] };
      const hidden = reads.getSnapshot(foreign, reserved.value.snapshotId);
      expect(hidden.ok).toBe(false);
      if (!hidden.ok) expect(hidden.error.code).toBe("forbidden_binding");
      const missing = reads.listAttempts(seeded.ctx, "job_missing01");
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.code).toBe("not_found");
      expect(createRunStore(db)).not.toHaveProperty("getSnapshot");
    } finally {
      close();
    }
  });
});
