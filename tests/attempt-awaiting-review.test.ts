import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { compileContextSnapshot } from "../src/server/runtime/context-snapshot";
import {
  applyVerifiedCompletionLifecycle,
  interpretVerifiedCompletion,
} from "../src/server/runtime/isolated-sdk";
import {
  attemptStoreFromRunStore,
  createLaunchCoordinator,
  liveIdentityFromDatabase,
  unsupportedSdkThreadVerifyPort,
  type LaunchContract,
  type SpawnOutcome,
  type SpawnPort,
} from "../src/server/runtime/launch";
import {
  ACTIVE_RUN_ATTEMPT_STATES,
  RUN_ATTEMPT_STATES,
  assertAttemptTransition,
  createInternalRunStoreReads,
  createRunStore,
} from "../src/server/runtime/run-store";
import {
  AWAITING_REVIEW_MIGRATION_ID,
  applyAgencyMigrations,
  migrations,
  newOpaqueId,
  openMigratedDatabase,
  type SqlDatabase,
} from "../src/server/db";
import { enableForeignKeys } from "../src/server/db/sql";
import { nowUtc } from "../src/server/services/context";
import { createDomainStore, type ServiceContext } from "../src/server/services";
import { RUN_ATTEMPT_STATE_VALUES } from "../src/shared/rpc-contract";
import type { AgentVersion, Job } from "../src/shared/contracts";
import type { CatalogSkillId } from "../src/shared/contracts/ids";
import type { ContextSnapshot } from "../src/server/runtime/context-snapshot/types";
import { hashBytes } from "../src/host/guarded-fs";

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

function openFileDb() {
  const dir = mkdtempSync(join(tmpdir(), "agy-await-"));
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

/** Original CREATE TABLE columns. Upgrade fixtures seed pre-awaiting_review DBs; do not use current repository INSERT. */
function insertLegacyAgentSeed(db: SqlDatabase, policyVersionId: string, updatedAt: string): AgentVersion {
  const agentId = newOpaqueId("agent");
  const versionId = newOpaqueId("agentVersion");
  const version: AgentVersion = {
    id: versionId,
    agentId,
    version: 1,
    role: "editor",
    instructions: "Править тексты по брифу.",
    providerId: "codex",
    model: "gpt-5.6",
    skillIds: [AGENCY_SKILL],
    mcpIds: [],
    policyVersionId,
  };
  db.prepare(
    `INSERT INTO agency_agent (id, name, state, current_version_id, revision, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(agentId, "Редактор", "active", versionId, 1, updatedAt);
  db.prepare(
    `INSERT INTO agency_agent_version
      (id, agent_id, version, role, instructions, provider_id, model, skill_ids, mcp_ids, policy_version_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    version.id,
    version.agentId,
    version.version,
    version.role,
    version.instructions,
    version.providerId,
    version.model,
    JSON.stringify(version.skillIds),
    JSON.stringify(version.mcpIds),
    version.policyVersionId,
  );
  return version;
}

/** Original agency_job CREATE TABLE columns. Upgrade fixtures seed pre-team DBs; do not use current repository INSERT. */
function insertLegacyJobSeed(
  db: SqlDatabase,
  input: {
    bindingId: string;
    departmentId: string;
    assignedAgentId: string;
    updatedAt: string;
  },
): Job {
  const job: Job = {
    id: newOpaqueId("job"),
    key: "AG-1602",
    bindingId: input.bindingId,
    departmentId: input.departmentId,
    title: "Карточка",
    brief: "Собрать карточку.",
    acceptance: "Текст принят.",
    state: "running",
    parentJobId: null,
    assignedAgentId: input.assignedAgentId,
    reviewerAgentIds: [],
    observerAgentIds: [],
    priority: "normal",
    dueAt: null,
    revision: 3,
    updatedAt: input.updatedAt,
  };
  db.prepare(
    `INSERT INTO agency_job
      (id, key, binding_id, department_id, title, brief, acceptance, state, parent_job_id,
       assigned_agent_id, priority, due_at, revision, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'backlog', ?, ?, ?, ?, 1, ?)`,
  ).run(
    job.id,
    job.key,
    job.bindingId,
    job.departmentId,
    job.title,
    job.brief,
    job.acceptance,
    job.parentJobId,
    job.assignedAgentId,
    job.priority,
    job.dueAt,
    job.updatedAt,
  );
  db.prepare(
    `INSERT INTO agency_job_facts (job_id, thread_bound, confirmed_continuation, open_questions)
     VALUES (?, 1, 0, 0)`,
  ).run(job.id);
  db.prepare(`UPDATE agency_job SET state = 'queued', revision = 2, updated_at = ? WHERE id = ?`).run(job.updatedAt, job.id);
  db.prepare(`UPDATE agency_job SET state = 'running', revision = 3, updated_at = ? WHERE id = ?`).run(job.updatedAt, job.id);
  return job;
}

async function seedRunningJob(db: SqlDatabase) {
  const store = createDomainStore(db);
  const bootstrap: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [] };
  const policy = store.createPolicyVersion(bootstrap, {
    requestId: requestId(),
    allowedCapabilities: ["read.files"],
    cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_mini"] },
    secretRefs: ["OPENAI_API_KEY"],
  });
  if (!policy.ok) throw new Error(policy.error.message);
  const agentVersion = insertLegacyAgentSeed(db, policy.value.id, nowUtc(bootstrap));
  const department = store.provisionDepartment(bootstrap, {
    requestId: requestId(),
    name: "Редактура",
    leadAgentId: agentVersion.agentId,
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
    canonicalRoot: "/tmp/agy-await-root",
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
  const job = insertLegacyJobSeed(db, {
    bindingId: binding.value.id,
    departmentId: department.value.department.id,
    assignedAgentId: agentVersion.agentId,
    updatedAt: nowUtc(ctx),
  });
  const processVersion = store.getProcessVersion(department.value.department.processVersionId);
  if (!processVersion) throw new Error("process missing");
  return {
    store,
    ctx,
    policy: policy.value,
    agentVersion,
    processVersion,
    binding: binding.value,
    job,
  };
}

function compileFor(seeded: Awaited<ReturnType<typeof seedRunningJob>>): ContextSnapshot {
  const result = compileContextSnapshot({
    binding: seeded.binding,
    job: seeded.job,
    agentVersion: seeded.agentVersion,
    processVersion: seeded.processVersion,
    bindingPolicyVersion: seeded.policy,
    agentPolicyVersion: seeded.policy,
    projectRules: {
      versionId: "rul_project1",
      text: "Писать только в canonicalRoot.",
      hash: createHash("sha256").update("Писать только в canonicalRoot.", "utf8").digest("hex"),
    },
    inputArtifactVersions: [],
    authorizedInputJobIds: [],
    catalogSkills: [{ id: AGENCY_SKILL, hash: catalogHash(AGENCY_SKILL), source: "plugin:agency", name: "agency" }],
    catalogMcps: [],
    coreSkillIds: [AGENCY_SKILL],
    helperSkillIds: [],
    providerLimits: {},
    handoff: null,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.snapshot;
}

function publishVersion(seeded: Awaited<ReturnType<typeof seedRunningJob>>, bytes: Uint8Array) {
  const artifact = seeded.store.createArtifact(seeded.ctx, {
    requestId: requestId(),
    jobId: seeded.job.id,
  });
  if (!artifact.ok) throw new Error(artifact.error.message);
  const hash = hashBytes(bytes);
  const published = seeded.store.publishArtifactVersion(seeded.ctx, {
    requestId: requestId(),
    artifactId: artifact.value.id,
    jobId: seeded.job.id,
    hostId: "host_mini",
    relativePath: "notes/watch.md",
    mime: "text/markdown",
    size: bytes.byteLength,
    hash,
    author: { kind: "system" },
  });
  if (!published.ok) throw new Error(published.error.message);
  return published.value;
}

function attestation(seeded: Awaited<ReturnType<typeof seedRunningJob>>) {
  return {
    accessVerified: true as const,
    revisionsVerified: true as const,
    expectedJobRevision: seeded.store.getJob(seeded.job.id)!.revision,
    expectedBindingRevision: seeded.binding.revision,
  };
}

export async function seedRunningAttempt(db: SqlDatabase) {
  const seeded = await seedRunningJob(db);
  const snapshot = compileFor(seeded);
  const runs = createRunStore(db);
  const reads = createInternalRunStoreReads(db);
  const reserved = runs.reservePreparedRun(seeded.ctx, {
    requestId: requestId(),
    snapshot,
    attestation: attestation(seeded),
  });
  if (!reserved.ok) throw new Error(reserved.error.message);
  const launching = runs.transitionAttempt(seeded.ctx, {
    requestId: requestId(),
    attemptId: reserved.value.attempt.attemptId,
    expectedRevision: reserved.value.attempt.revision,
    to: "launching",
    launchId: randomUUID(),
  });
  if (!launching.ok) throw new Error(launching.error.message);
  const running = runs.transitionAttempt(seeded.ctx, {
    requestId: requestId(),
    attemptId: launching.value.attemptId,
    expectedRevision: launching.value.revision,
    to: "running",
    threadId: "thr_ag1602idle01",
  });
  if (!running.ok) throw new Error(running.error.message);
  const receipt = runs.recordLaunchReceipt(seeded.ctx, {
    requestId: requestId(),
    receipt: {
      launchId: launching.value.launchId!,
      attemptId: running.value.attemptId,
      jobId: running.value.jobId,
      snapshotId: running.value.snapshotId,
      digest: running.value.digest,
      threadId: running.value.threadId,
      spawnKind: "confirmed",
      persistErrorCode: null,
      persistErrorMessage: null,
      jobBindState: "applied",
      needsReconciliation: false,
      parentRequestId: requestId(),
    },
  });
  if (!receipt.ok) throw new Error(receipt.error.message);
  return {
    seeded,
    snapshot,
    reserved: reserved.value,
    runs,
    reads,
    attempt: running.value,
    receipt: receipt.value,
  };
}

const testReady = {
  assess: () => ({
    executionAvailable: true,
    isolationReady: true,
    isolatedSpawnFields: true,
    reason: "test-only readiness; product execution stays unavailable",
  }),
};

function spawnPort(impl: (request: LaunchContract) => Promise<SpawnOutcome> | SpawnOutcome): SpawnPort & {
  calls: LaunchContract[];
} {
  const calls: LaunchContract[] = [];
  return {
    supported: true,
    calls,
    async spawn(request) {
      calls.push(request);
      return impl(request);
    },
  };
}

describe("awaiting_review lifecycle", () => {
  it("keeps public enum aligned with store states", () => {
    expect([...RUN_ATTEMPT_STATE_VALUES]).toEqual([...RUN_ATTEMPT_STATES]);
    expect(ACTIVE_RUN_ATTEMPT_STATES).toContain("awaiting_review");
    expect(ACTIVE_RUN_ATTEMPT_STATES).toContain("unknown");
  });

  it("blocks spawn retry from unknown and reopen from awaiting_review", () => {
    const unknownRetry = assertAttemptTransition("unknown", "launching");
    expect(unknownRetry.ok).toBe(false);
    if (!unknownRetry.ok) expect(unknownRetry.error.code).toBe("no_automatic_spawn_retry");
    expect(assertAttemptTransition("awaiting_review", "launching").ok).toBe(false);
    expect(assertAttemptTransition("awaiting_review", "running").ok).toBe(false);
    expect(assertAttemptTransition("awaiting_review", "succeeded").ok).toBe(true);
    expect(assertAttemptTransition("running", "awaiting_review").ok).toBe(true);
  });

  it("moves running+job.review+idle+hash to awaiting_review, is idempotent after reopen, and blocks reserve/spawn", async () => {
    const opened = openFileDb();
    const live = await seedRunningAttempt(opened.db);
    const bytes = new TextEncoder().encode("published-body\n");
    const version = publishVersion(live.seeded, bytes);
    const reading = interpretVerifiedCompletion({
      threadStatus: "idle",
      publishedVerified: true,
      acceptedVerified: false,
    });
    const first = applyVerifiedCompletionLifecycle({
      store: live.seeded.store,
      runs: live.runs,
      reads: live.reads,
      ctx: live.seeded.ctx,
      jobId: live.seeded.job.id,
      launchId: live.receipt.launchId,
      reading,
      publishedHash: version.hash,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.runSucceeded).toBe(false);
    expect(first.value.jobState).toBe("review");
    expect(first.value.attemptState).toBe("awaiting_review");
    expect(first.value.attemptReviewApplied).toBe(true);
    const afterFirst = live.reads.getAttempt(live.seeded.ctx, live.attempt.attemptId);
    expect(afterFirst.ok && afterFirst.value.revision).toBe(live.attempt.revision + 1);

    const second = applyVerifiedCompletionLifecycle({
      store: live.seeded.store,
      runs: live.runs,
      reads: live.reads,
      ctx: live.seeded.ctx,
      jobId: live.seeded.job.id,
      launchId: live.receipt.launchId,
      reading,
      publishedHash: version.hash,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error.message);
    expect(second.value.attemptReviewApplied).toBe(false);
    expect(second.value.attemptState).toBe("awaiting_review");
    expect(second.value.reviewApplied).toBe(false);
    const afterSecond = live.reads.getAttempt(live.seeded.ctx, live.attempt.attemptId);
    expect(afterSecond.ok && afterSecond.value.revision).toBe(afterFirst.ok && afterFirst.value.revision);

    opened.close();
    const db = reopen(opened.path);
    try {
      const seeded = { ...live.seeded, store: createDomainStore(db), ctx: live.seeded.ctx };
      const runs = createRunStore(db);
      const reads = createInternalRunStoreReads(db);
      const reopened = applyVerifiedCompletionLifecycle({
        store: seeded.store,
        runs,
        reads,
        ctx: seeded.ctx,
        jobId: live.seeded.job.id,
        launchId: live.receipt.launchId,
        reading,
        publishedHash: version.hash,
      });
      expect(reopened.ok).toBe(true);
      if (!reopened.ok) throw new Error(reopened.error.message);
      expect(reopened.value.attemptState).toBe("awaiting_review");
      expect(reopened.value.attemptReviewApplied).toBe(false);
      const latest = reads.getAttempt(seeded.ctx, live.attempt.attemptId);
      expect(latest.ok && latest.value.revision).toBe(afterFirst.ok && afterFirst.value.revision);
      expect(seeded.store.getJob(live.seeded.job.id)?.state).toBe("review");

      const currentJob = seeded.store.getJob(live.seeded.job.id);
      if (!currentJob) throw new Error("job missing after reopen");
      const again = runs.reservePreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshot: compileFor({ ...live.seeded, store: seeded.store, job: currentJob }),
        attestation: {
          accessVerified: true,
          revisionsVerified: true,
          expectedJobRevision: currentJob.revision,
          expectedBindingRevision: live.seeded.binding.revision,
        },
      });
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.error.code).toBe("active_attempt_exists");

      const spawn = spawnPort(() => ({ kind: "confirmed", threadId: "thr_must_not_spawn" }));
      const coordinator = createLaunchCoordinator({
        store: attemptStoreFromRunStore(runs, reads),
        liveIdentity: liveIdentityFromDatabase(db),
        readiness: testReady,
        spawn,
        threadVerify: unsupportedSdkThreadVerifyPort(),
        jobRunning: { onConfirmedBind: async () => ({ ok: true, value: true }) },
      });
      const replay = await coordinator.launchPreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshotId: live.reserved.snapshotId,
        digest: live.reserved.digest,
        attemptId: live.attempt.attemptId,
        attestation: {
          accessVerified: true,
          revisionsVerified: true,
          expectedJobRevision: seeded.store.getJob(live.seeded.job.id)!.revision,
          expectedBindingRevision: live.seeded.binding.revision,
        },
      });
      expect(replay.ok).toBe(true);
      if (!replay.ok) throw new Error(replay.error.message);
      expect(replay.value.attempt.state).toBe("awaiting_review");
      expect(spawn.calls).toHaveLength(0);
      db.prepare("DELETE FROM agency_launch_receipt WHERE attempt_id = ?").run(live.attempt.attemptId);
      const blocked = await coordinator.launchPreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshotId: live.reserved.snapshotId,
        digest: live.reserved.digest,
        attemptId: live.attempt.attemptId,
        attestation: {
          accessVerified: true,
          revisionsVerified: true,
          expectedJobRevision: seeded.store.getJob(live.seeded.job.id)!.revision,
          expectedBindingRevision: live.seeded.binding.revision,
        },
      });
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.error.code).toBe("spawn_not_allowed");
      expect(spawn.calls).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("does not leave running when artifact or idle is missing", async () => {
    const opened = openFileDb();
    try {
      const live = await seedRunningAttempt(opened.db);
      const idleNoHash = applyVerifiedCompletionLifecycle({
        store: live.seeded.store,
        runs: live.runs,
        reads: live.reads,
        ctx: live.seeded.ctx,
        jobId: live.seeded.job.id,
        launchId: live.receipt.launchId,
        reading: interpretVerifiedCompletion({
          threadStatus: "idle",
          publishedVerified: false,
          acceptedVerified: false,
        }),
        publishedHash: null,
      });
      expect(idleNoHash.ok && idleNoHash.value.attemptState).toBe("running");
      expect(idleNoHash.ok && idleNoHash.value.jobState).toBe("running");

      const bytes = new TextEncoder().encode("published-body\n");
      const version = publishVersion(live.seeded, bytes);
      const busy = applyVerifiedCompletionLifecycle({
        store: live.seeded.store,
        runs: live.runs,
        reads: live.reads,
        ctx: live.seeded.ctx,
        jobId: live.seeded.job.id,
        launchId: live.receipt.launchId,
        reading: interpretVerifiedCompletion({
          threadStatus: "running",
          publishedVerified: true,
          acceptedVerified: false,
        }),
        publishedHash: version.hash,
      });
      expect(busy.ok && busy.value.attemptState).toBe("running");
      expect(live.seeded.store.getJob(live.seeded.job.id)?.state).toBe("running");
    } finally {
      opened.close();
    }
  });

  it("does not spawn when attempt is unknown", async () => {
    const opened = openFileDb();
    try {
      const live = await seedRunningAttempt(opened.db);
      const unknown = live.runs.transitionAttempt(live.seeded.ctx, {
        requestId: requestId(),
        attemptId: live.attempt.attemptId,
        expectedRevision: live.attempt.revision,
        to: "unknown",
      });
      expect(unknown.ok).toBe(true);
      const retry = live.runs.transitionAttempt(live.seeded.ctx, {
        requestId: requestId(),
        attemptId: live.attempt.attemptId,
        expectedRevision: unknown.ok ? unknown.value.revision : 0,
        to: "launching",
      });
      expect(retry.ok).toBe(false);
      if (!retry.ok) expect(retry.error.code).toBe("no_automatic_spawn_retry");

      const spawn = spawnPort(() => ({ kind: "confirmed", threadId: "thr_unknown_retry" }));
      const launched = await createLaunchCoordinator({
        store: attemptStoreFromRunStore(live.runs, live.reads),
        liveIdentity: liveIdentityFromDatabase(opened.db),
        readiness: testReady,
        spawn,
        threadVerify: unsupportedSdkThreadVerifyPort(),
        jobRunning: { onConfirmedBind: async () => ({ ok: true, value: true }) },
      }).launchPreparedRun(live.seeded.ctx, {
        requestId: requestId(),
        snapshotId: live.reserved.snapshotId,
        digest: live.reserved.digest,
        attemptId: live.attempt.attemptId,
        attestation: attestation(live.seeded),
      });
      expect(launched.ok).toBe(true);
      if (!launched.ok) throw new Error(launched.error.message);
      expect(launched.value.attempt.state).toBe("unknown");
      expect(spawn.calls).toHaveLength(0);
      opened.db.prepare("DELETE FROM agency_launch_receipt WHERE attempt_id = ?").run(live.attempt.attemptId);
      const blocked = await createLaunchCoordinator({
        store: attemptStoreFromRunStore(live.runs, live.reads),
        liveIdentity: liveIdentityFromDatabase(opened.db),
        readiness: testReady,
        spawn,
        threadVerify: unsupportedSdkThreadVerifyPort(),
        jobRunning: { onConfirmedBind: async () => ({ ok: true, value: true }) },
      }).launchPreparedRun(live.seeded.ctx, {
        requestId: requestId(),
        snapshotId: live.reserved.snapshotId,
        digest: live.reserved.digest,
        attemptId: live.attempt.attemptId,
        attestation: attestation(live.seeded),
      });
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.error.code).toBe("spawn_not_allowed");
      expect(spawn.calls).toHaveLength(0);
    } finally {
      opened.close();
    }
  });

  it("upgrades a populated pre-awaiting_review database without rewriting ids or revisions", async () => {
    expect(migrations[AWAITING_REVIEW_MIGRATION_ID]).toContain("awaiting_review");
    expect(migrations[AWAITING_REVIEW_MIGRATION_ID - 1]).not.toContain("awaiting_review");

    const dir = mkdtempSync(join(tmpdir(), "agy-upgrade-"));
    tempDirs.push(dir);
    const path = join(dir, "agency.sqlite");
    const oldDb = new Database(path);
    enableForeignKeys(oldDb);
    applyAgencyMigrations(oldDb, { throughId: AWAITING_REVIEW_MIGRATION_ID - 1 });
    const live = await seedRunningAttempt(oldDb);
    const attemptBefore = oldDb.prepare("SELECT * FROM agency_run_attempt WHERE id = ?").get(live.attempt.attemptId) as Record<
      string,
      unknown
    >;
    const receiptBefore = oldDb.prepare("SELECT * FROM agency_launch_receipt WHERE launch_id = ?").get(live.receipt.launchId) as Record<
      string,
      unknown
    >;
    const snapshotBefore = oldDb
      .prepare("SELECT * FROM agency_context_snapshot WHERE id = ?")
      .get(live.reserved.snapshotId) as Record<string, unknown>;
    const jobBefore = oldDb.prepare("SELECT id, revision, state FROM agency_job WHERE id = ?").get(live.seeded.job.id) as Record<
      string,
      unknown
    >;
    expect(attemptBefore.state).toBe("running");
    expect(attemptBefore.thread_id).toBe("thr_ag1602idle01");
    expect(receiptBefore.attempt_id).toBe(attemptBefore.id);
    expect(receiptBefore.snapshot_id).toBe(snapshotBefore.id);
    expect(receiptBefore.job_id).toBe(jobBefore.id);
    const migrationsBefore = oldDb.prepare("SELECT id, hash FROM _bb_migrations ORDER BY id").all();
    expect(migrationsBefore).toHaveLength(AWAITING_REVIEW_MIGRATION_ID);

    applyAgencyMigrations(oldDb, { throughId: AWAITING_REVIEW_MIGRATION_ID });
    const attemptAfter = oldDb.prepare("SELECT * FROM agency_run_attempt WHERE id = ?").get(live.attempt.attemptId) as Record<
      string,
      unknown
    >;
    const receiptAfter = oldDb.prepare("SELECT * FROM agency_launch_receipt WHERE launch_id = ?").get(live.receipt.launchId) as Record<
      string,
      unknown
    >;
    expect(attemptAfter).toEqual(attemptBefore);
    expect(receiptAfter).toEqual(receiptBefore);
    expect(oldDb.prepare("SELECT COUNT(*) AS n FROM agency_run_attempt").get() as { n: number }).toEqual({ n: 1 });
    expect(oldDb.prepare("SELECT COUNT(*) AS n FROM agency_launch_receipt").get() as { n: number }).toEqual({ n: 1 });
    const schema = oldDb
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agency_run_attempt'")
      .get() as { sql: string };
    expect(schema.sql).toContain("awaiting_review");
    const index = oldDb
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'agency_run_attempt_one_active_idx'")
      .get() as { sql: string };
    expect(index.sql).toContain("awaiting_review");
    const migrationsAfterReview = oldDb.prepare("SELECT id, hash FROM _bb_migrations ORDER BY id").all();
    expect(migrationsAfterReview).toHaveLength(AWAITING_REVIEW_MIGRATION_ID + 1);
    applyAgencyMigrations(oldDb);
    const migrationsAfter = oldDb.prepare("SELECT id, hash FROM _bb_migrations ORDER BY id").all();
    expect(migrationsAfter).toHaveLength(migrations.length);
    const jobColumns = (
      oldDb.prepare("PRAGMA table_info(agency_job)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(jobColumns).toEqual(expect.arrayContaining(["reviewer_agent_ids", "observer_agent_ids"]));
    const teamAfter = oldDb
      .prepare("SELECT reviewer_agent_ids, observer_agent_ids FROM agency_job WHERE id = ?")
      .get(live.seeded.job.id) as { reviewer_agent_ids: string; observer_agent_ids: string };
    expect(teamAfter).toEqual({ reviewer_agent_ids: "[]", observer_agent_ids: "[]" });
    applyAgencyMigrations(oldDb);
    expect(oldDb.prepare("SELECT id, hash FROM _bb_migrations ORDER BY id").all()).toEqual(migrationsAfter);
    expect(oldDb.prepare("SELECT * FROM agency_run_attempt WHERE id = ?").get(live.attempt.attemptId)).toEqual(attemptBefore);
    oldDb.close();

    const reopened = openMigratedDatabase(new Database(path));
    try {
      applyAgencyMigrations(reopened);
      expect(reopened.prepare("SELECT id, hash FROM _bb_migrations ORDER BY id").all()).toEqual(migrationsAfter);
      const reads = createInternalRunStoreReads(reopened);
      const store = createDomainStore(reopened);
      const ctx = live.seeded.ctx;
      const loaded = reads.getAttempt(ctx, live.attempt.attemptId);
      expect(loaded.ok && loaded.value.revision).toBe(live.attempt.revision);
      expect(loaded.ok && loaded.value.state).toBe("running");
      expect(loaded.ok && loaded.value.threadId).toBe("thr_ag1602idle01");
      const receipt = reads.getLaunchReceipt(ctx, live.receipt.launchId);
      expect(receipt.ok && receipt.value.attemptId).toBe(live.attempt.attemptId);
      const bytes = new TextEncoder().encode("published-body\n");
      const version = publishVersion({ ...live.seeded, store }, bytes);
      const applied = applyVerifiedCompletionLifecycle({
        store,
        runs: createRunStore(reopened),
        reads,
        ctx,
        jobId: live.seeded.job.id,
        launchId: live.receipt.launchId,
        reading: interpretVerifiedCompletion({
          threadStatus: "idle",
          publishedVerified: true,
          acceptedVerified: false,
        }),
        publishedHash: version.hash,
      });
      expect(applied.ok).toBe(true);
      if (!applied.ok) throw new Error(applied.error.message);
      expect(applied.value.attemptState).toBe("awaiting_review");
      expect(applied.value.runSucceeded).toBe(false);
      const after = reads.getAttempt(ctx, live.attempt.attemptId);
      expect(after.ok && after.value.attemptId).toBe(live.attempt.attemptId);
      expect(after.ok && after.value.revision).toBe(live.attempt.revision + 1);
    } finally {
      reopened.close();
    }
  });

  it("moves awaiting_review to succeeded only with accepted current + job done + attempt evidence", async () => {
    const opened = openFileDb();
    try {
      const live = await seedRunningAttempt(opened.db);
      const bytes = new TextEncoder().encode("accepted-body\n");
      const version = publishVersion(live.seeded, bytes);
      const reviewed = applyVerifiedCompletionLifecycle({
        store: live.seeded.store,
        runs: live.runs,
        reads: live.reads,
        ctx: live.seeded.ctx,
        jobId: live.seeded.job.id,
        launchId: live.receipt.launchId,
        reading: interpretVerifiedCompletion({
          threadStatus: "idle",
          publishedVerified: true,
          acceptedVerified: false,
        }),
        publishedHash: version.hash,
      });
      expect(reviewed.ok && reviewed.value.attemptState).toBe("awaiting_review");

      const idleAccepted = applyVerifiedCompletionLifecycle({
        store: live.seeded.store,
        runs: live.runs,
        reads: live.reads,
        ctx: live.seeded.ctx,
        jobId: live.seeded.job.id,
        launchId: live.receipt.launchId,
        reading: interpretVerifiedCompletion({
          threadStatus: "idle",
          publishedVerified: true,
          acceptedVerified: true,
        }),
        publishedHash: version.hash,
      });
      expect(idleAccepted.ok && idleAccepted.value.attemptState).toBe("awaiting_review");

      opened.db.prepare(`UPDATE agency_job SET state = 'done' WHERE id = ?`).run(live.seeded.job.id);
      const doneNoAccept = applyVerifiedCompletionLifecycle({
        store: live.seeded.store,
        runs: live.runs,
        reads: live.reads,
        ctx: live.seeded.ctx,
        jobId: live.seeded.job.id,
        launchId: live.receipt.launchId,
        reading: interpretVerifiedCompletion({
          threadStatus: "idle",
          publishedVerified: true,
          acceptedVerified: false,
        }),
        publishedHash: version.hash,
      });
      expect(doneNoAccept.ok && doneNoAccept.value.attemptState).toBe("awaiting_review");

      const mismatch = applyVerifiedCompletionLifecycle({
        store: live.seeded.store,
        runs: live.runs,
        reads: live.reads,
        ctx: live.seeded.ctx,
        jobId: live.seeded.job.id,
        launchId: live.receipt.launchId,
        reading: interpretVerifiedCompletion({
          threadStatus: "idle",
          publishedVerified: false,
          acceptedVerified: true,
        }),
        publishedHash: "ff".repeat(32),
      });
      expect(mismatch.ok && mismatch.value.attemptState).toBe("awaiting_review");

      const accepted = live.seeded.store.acceptArtifactVersion(live.seeded.ctx, {
        requestId: requestId(),
        expectedRevision: live.seeded.store.getJob(live.seeded.job.id)!.revision,
        jobId: live.seeded.job.id,
        artifactId: version.artifactId,
        version: version.version,
        hash: version.hash,
      });
      expect(accepted.ok).toBe(true);
      const first = applyVerifiedCompletionLifecycle({
        store: live.seeded.store,
        runs: live.runs,
        reads: live.reads,
        ctx: live.seeded.ctx,
        jobId: live.seeded.job.id,
        launchId: live.receipt.launchId,
        reading: interpretVerifiedCompletion({
          threadStatus: "error",
          publishedVerified: true,
          acceptedVerified: true,
        }),
        publishedHash: version.hash,
      });
      expect(first.ok && first.value.attemptState).toBe("succeeded");
      expect(first.ok && first.value.runSucceeded).toBe(false);
      expect(first.ok && first.value.attemptAcceptedApplied).toBe(true);
      const replay = applyVerifiedCompletionLifecycle({
        store: live.seeded.store,
        runs: live.runs,
        reads: live.reads,
        ctx: live.seeded.ctx,
        jobId: live.seeded.job.id,
        launchId: live.receipt.launchId,
        reading: interpretVerifiedCompletion({
          threadStatus: "idle",
          publishedVerified: true,
          acceptedVerified: true,
        }),
        publishedHash: version.hash,
      });
      expect(replay.ok && replay.value.attemptState).toBe("succeeded");
      expect(replay.ok && replay.value.attemptAcceptedApplied).toBe(false);
    } finally {
      opened.close();
    }
  });
});
