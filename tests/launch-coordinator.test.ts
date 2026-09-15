import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { fail, ok } from "../src/domain";
import { compileContextSnapshot } from "../src/server/runtime/context-snapshot";
import {
  attemptStoreFromRunStore,
  createLaunchCoordinator,
  deployedSdkHasIsolatedSpawnFields,
  LAUNCH_COORDINATOR_STATUS,
  launchContractFromSnapshot,
  launchOpRequestId,
  liveIdentityFromDatabase,
  unavailableReadinessPort,
  unsupportedSdkSpawnPort,
  unsupportedSdkThreadVerifyPort,
  type AttemptStorePort,
  type JobRunningPort,
  type LaunchContract,
  type SpawnOutcome,
  type SpawnPort,
  type ThreadVerifyPort,
} from "../src/server/runtime/launch";
import { createInternalRunStoreReads, createRunStore } from "../src/server/runtime/run-store";
import { openMigratedDatabase, type SqlDatabase } from "../src/server/db";
import { createDomainStore, type ServiceContext } from "../src/server/services";
import { requestIdSchema } from "../src/shared/contracts";
import type { CatalogSkillId } from "../src/shared/contracts/ids";
import type { ContextSnapshot } from "../src/server/runtime/context-snapshot/types";

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
  const dir = mkdtempSync(join(tmpdir(), "agy-launch-"));
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
    canonicalRoot: "/Users/vechkasov/Documents/SelfyStudio",
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
    key: "AG-301",
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
    ctx,
    policy: policy.value,
    agentVersion: agent.value.version,
    department: department.value.department,
    processVersion,
    binding: binding.value,
    job: job.value,
  };
}

function compileFor(seeded: ReturnType<typeof seedProject>): ContextSnapshot {
  const text = "Писать только в canonicalRoot.";
  const result = compileContextSnapshot({
    binding: seeded.binding,
    job: seeded.job,
    agentVersion: seeded.agentVersion,
    processVersion: seeded.processVersion,
    bindingPolicyVersion: seeded.policy,
    agentPolicyVersion: seeded.policy,
    projectRules: { versionId: "rul_project1", text, hash: createHash("sha256").update(text, "utf8").digest("hex") },
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

function jobOk(): JobRunningPort {
  return { onConfirmedBind: async () => ok(true) };
}

function snapshotLink(seeded: ReturnType<typeof seedProject>) {
  return {
    hostId: seeded.binding.hostId,
    environmentId: seeded.binding.environmentId,
    canonicalRoot: seeded.binding.canonicalRoot,
    bbProjectId: seeded.binding.bbProjectId,
    providerId: seeded.agentVersion.providerId,
  };
}

function lookupVerify(
  rows: Array<{
    launchId: string;
    threadId: string;
    attemptId?: string;
    hostId: string;
    environmentId: string;
    canonicalRoot: string;
    bbProjectId: string;
    providerId?: string;
  }>,
): ThreadVerifyPort {
  return {
    supported: true,
    async verifyConfirmedThread(receipt, snapshot) {
      const row = rows.find((item) => item.launchId === receipt.launchId);
      if (!row) {
        return { kind: "rejected", code: "thread_not_found", message: "provider has no thread for this launchId" };
      }
      if (receipt.threadId && receipt.threadId !== row.threadId) {
        return { kind: "rejected", code: "thread_mismatch", message: "hint thread is not the provider thread" };
      }
      if (row.attemptId && row.attemptId !== receipt.attemptId) {
        return { kind: "rejected", code: "attempt_mismatch", message: "provider launch is not this attempt" };
      }
      if (
        row.hostId !== snapshot.binding.hostId ||
        row.environmentId !== snapshot.binding.environmentId ||
        row.canonicalRoot !== snapshot.binding.canonicalRoot ||
        row.bbProjectId !== snapshot.binding.bbProjectId
      ) {
        return { kind: "rejected", code: "live_binding_mismatch", message: "provider thread linkage does not match stored snapshot" };
      }
      return {
        kind: "confirmed",
        identity: {
          threadId: row.threadId,
          launchId: row.launchId,
          attemptId: row.attemptId ?? receipt.attemptId,
          hostId: row.hostId,
          environmentId: row.environmentId,
          canonicalRoot: row.canonicalRoot,
          bbProjectId: row.bbProjectId,
          providerId: row.providerId ?? snapshot.agentVersion.providerId,
        },
      };
    },
  };
}

function reserveLaunch(db: SqlDatabase) {
  const seeded = seedProject(db);
  const snapshot = compileFor(seeded);
  const writes = createRunStore(db);
  const reads = createInternalRunStoreReads(db);
  const reserved = writes.reservePreparedRun(seeded.ctx, {
    requestId: requestId(),
    snapshot,
    attestation: attestation(seeded),
  });
  if (!reserved.ok) throw new Error(reserved.error.message);
  return { seeded, writes, reads, reserved };
}

function attestation(seeded: ReturnType<typeof seedProject>) {
  return {
    accessVerified: true as const,
    revisionsVerified: true as const,
    expectedJobRevision: seeded.job.revision,
    expectedBindingRevision: seeded.binding.revision,
  };
}

function wrapStore(
  base: AttemptStorePort,
  opts: { failTransitionTo?: readonly string[]; failReceiptAfter?: number; failReceiptAlways?: boolean } = {},
): AttemptStorePort {
  let receiptWrites = 0;
  return {
    ...base,
    transition(ctx, input) {
      if (opts.failTransitionTo?.includes(input.to)) {
        return fail("persist_failed", `refusing persist to ${input.to}`);
      }
      return base.transition(ctx, input);
    },
    putReceipt(ctx, receipt) {
      receiptWrites += 1;
      if (opts.failReceiptAlways || (opts.failReceiptAfter !== undefined && receiptWrites > opts.failReceiptAfter)) {
        return fail("sqlite_unavailable", "receipt write refused");
      }
      return base.putReceipt(ctx, receipt);
    },
  };
}

describe("launch coordinator", () => {
  it("keeps execution unavailable and uses UUID v5 operation ids", () => {
    expect(LAUNCH_COORDINATOR_STATUS.executionAvailable).toBe(false);
    expect(deployedSdkHasIsolatedSpawnFields()).toBe(false);
    const parent = requestId();
    const cas = launchOpRequestId(parent, "cas-launching");
    expect(requestIdSchema.safeParse(cas).success).toBe(true);
    expect(cas).not.toBe(`${parent}:cas-launching`);
    expect(unsupportedSdkSpawnPort().supported).toBe(false);
    const missing = launchContractFromSnapshot(
      { agentVersion: { model: "" }, binding: {} } as never,
      { snapshotId: "s", attemptId: "a", launchId: "l" },
    );
    expect(missing.ok).toBe(false);
  });

  it("CAS launching on real run-store and binds a confirmed thread", async () => {
    const opened = openFileDb();
    const seeded = seedProject(opened.db);
    const snapshot = compileFor(seeded);
    const writes = createRunStore(opened.db);
    const reads = createInternalRunStoreReads(opened.db);
    const reserved = writes.reservePreparedRun(seeded.ctx, {
      requestId: requestId(),
      snapshot,
      attestation: {
        accessVerified: true,
        revisionsVerified: true,
        expectedJobRevision: seeded.job.revision,
        expectedBindingRevision: seeded.binding.revision,
      },
    });
    if (!reserved.ok) throw new Error(reserved.error.message);
    const spawn = spawnPort(() => ({ kind: "confirmed", threadId: "thr_confirmed01" }));
    const coordinator = createLaunchCoordinator({
      store: attemptStoreFromRunStore(writes, reads),
      liveIdentity: liveIdentityFromDatabase(opened.db),
      readiness: testReady,
      spawn,
      threadVerify: unsupportedSdkThreadVerifyPort(),
      jobRunning: jobOk(),
    });
    const result = await coordinator.launchPreparedRun(seeded.ctx, {
      requestId: requestId(),
      snapshotId: reserved.value.snapshotId,
      digest: reserved.value.digest,
      attemptId: reserved.value.attempt.attemptId,
      attestation: {
        accessVerified: true,
        revisionsVerified: true,
        expectedJobRevision: seeded.job.revision,
        expectedBindingRevision: seeded.binding.revision,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "running") throw new Error("expected running");
    expect(result.value.attempt.threadId).toBe("thr_confirmed01");
    expect(result.value.receipt.threadId).toBe("thr_confirmed01");
    expect(result.value.receipt.persisted).toBe(true);
    expect(spawn.calls[0]?.model).toBe("gpt-5.6");
    opened.close();

    const db = reopen(opened.path);
    try {
      const again = createInternalRunStoreReads(db).getLaunchReceipt(seeded.ctx, result.value.receipt.launchId);
      expect(again.ok).toBe(true);
      if (again.ok) expect(again.value.threadId).toBe("thr_confirmed01");
    } finally {
      db.close();
    }
  });

  it("does not call spawn when readiness is unavailable", async () => {
    const { db, close } = openFileDb();
    try {
      const seeded = seedProject(db);
      const snapshot = compileFor(seeded);
      const writes = createRunStore(db);
      const reads = createInternalRunStoreReads(db);
      const reserved = writes.reservePreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshot,
        attestation: {
          accessVerified: true,
          revisionsVerified: true,
          expectedJobRevision: seeded.job.revision,
          expectedBindingRevision: seeded.binding.revision,
        },
      });
      if (!reserved.ok) throw new Error(reserved.error.message);
      const spawn = spawnPort(() => {
        throw new Error("must not spawn");
      });
      const result = await createLaunchCoordinator({
        store: attemptStoreFromRunStore(writes, reads),
        liveIdentity: liveIdentityFromDatabase(db),
        readiness: unavailableReadinessPort(),
        spawn,
        threadVerify: unsupportedSdkThreadVerifyPort(),
        jobRunning: jobOk(),
      }).launchPreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshotId: reserved.value.snapshotId,
        digest: reserved.value.digest,
        attemptId: reserved.value.attempt.attemptId,
        attestation: {
          accessVerified: true,
          revisionsVerified: true,
          expectedJobRevision: seeded.job.revision,
          expectedBindingRevision: seeded.binding.revision,
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("capability_unavailable");
      expect(spawn.calls).toHaveLength(0);
    } finally {
      close();
    }
  });

  it("keeps confirmed thread on the receipt when persist running fails, then recovers after reopen", async () => {
    const opened = openFileDb();
    const seeded = seedProject(opened.db);
    const snapshot = compileFor(seeded);
    const writes = createRunStore(opened.db);
    const reads = createInternalRunStoreReads(opened.db);
    const reserved = writes.reservePreparedRun(seeded.ctx, {
      requestId: requestId(),
      snapshot,
      attestation: {
        accessVerified: true,
        revisionsVerified: true,
        expectedJobRevision: seeded.job.revision,
        expectedBindingRevision: seeded.binding.revision,
      },
    });
    if (!reserved.ok) throw new Error(reserved.error.message);
    const base = attemptStoreFromRunStore(writes, reads);
    const launchRequestId = requestId();
    const result = await createLaunchCoordinator({
      store: wrapStore(base, { failTransitionTo: ["running"] }),
      liveIdentity: liveIdentityFromDatabase(opened.db),
      readiness: testReady,
      spawn: spawnPort(() => ({ kind: "confirmed", threadId: "thr_orphan01" })),
      threadVerify: unsupportedSdkThreadVerifyPort(),
      jobRunning: jobOk(),
    }).launchPreparedRun(seeded.ctx, {
      requestId: launchRequestId,
      snapshotId: reserved.value.snapshotId,
      digest: reserved.value.digest,
      attemptId: reserved.value.attempt.attemptId,
      attestation: {
        accessVerified: true,
        revisionsVerified: true,
        expectedJobRevision: seeded.job.revision,
        expectedBindingRevision: seeded.binding.revision,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "unknown") throw new Error("expected persist_after_spawn");
    expect(result.value.code).toBe("persist_after_spawn");
    expect(result.value.receipt.threadId).toBe("thr_orphan01");
    expect(result.value.receipt.persisted).toBe(true);
    opened.close();

    const db = reopen(opened.path);
    try {
      const writes2 = createRunStore(db);
      const reads2 = createInternalRunStoreReads(db);
      const stored = reads2.getLaunchReceipt(seeded.ctx, result.value.receipt.launchId);
      expect(stored.ok).toBe(true);
      if (stored.ok) expect(stored.value.threadId).toBe("thr_orphan01");
      const noLookup = await createLaunchCoordinator({
        store: attemptStoreFromRunStore(writes2, reads2),
        liveIdentity: liveIdentityFromDatabase(db),
        readiness: testReady,
        spawn: spawnPort(() => {
          throw new Error("must not respawn");
        }),
        threadVerify: unsupportedSdkThreadVerifyPort(),
        jobRunning: jobOk(),
      }).launchPreparedRun(seeded.ctx, {
        requestId: launchRequestId,
        snapshotId: reserved.value.snapshotId,
        digest: reserved.value.digest,
        attemptId: reserved.value.attempt.attemptId,
        attestation: attestation(seeded),
      });
      expect(noLookup.ok).toBe(true);
      if (!noLookup.ok || noLookup.value.kind === "running") throw new Error("lookup unavailable must not bind");
      expect(noLookup.value.kind).toBe("needs_reconciliation");
      if (noLookup.value.kind === "needs_reconciliation") {
        expect(noLookup.value.code).toBe("thread_verify_unavailable");
      }
      const recovered = await createLaunchCoordinator({
        store: attemptStoreFromRunStore(writes2, reads2),
        liveIdentity: liveIdentityFromDatabase(db),
        readiness: testReady,
        spawn: spawnPort(() => {
          throw new Error("must not respawn");
        }),
        threadVerify: lookupVerify([
          {
            launchId: result.value.receipt.launchId,
            threadId: "thr_orphan01",
            attemptId: reserved.value.attempt.attemptId,
            ...snapshotLink(seeded),
          },
        ]),
        jobRunning: jobOk(),
      }).reconcileLaunch(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        launchId: result.value.receipt.launchId,
      });
      expect(recovered.ok).toBe(true);
      if (!recovered.ok || recovered.value.kind !== "running") throw new Error("expected verified bind");
      expect(recovered.value.attempt.threadId).toBe("thr_orphan01");
      expect(recovered.value.jobStateApplied).toBe(true);
    } finally {
      db.close();
    }
  });

  it("repairs a failed or thrown job callback without spawning", async () => {
    const { db, close } = openFileDb();
    try {
      const seeded = seedProject(db);
      const snapshot = compileFor(seeded);
      const writes = createRunStore(db);
      const reads = createInternalRunStoreReads(db);
      const reserved = writes.reservePreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshot,
        attestation: {
          accessVerified: true,
          revisionsVerified: true,
          expectedJobRevision: seeded.job.revision,
          expectedBindingRevision: seeded.binding.revision,
        },
      });
      if (!reserved.ok) throw new Error(reserved.error.message);
      let calls = 0;
      const jobRunning: JobRunningPort = {
        async onConfirmedBind() {
          calls += 1;
          if (calls === 1) return fail("job_callback_failed", "first bind rejected");
          if (calls === 2) throw new Error("boom");
          return ok(true);
        },
      };
      const spawn = spawnPort(() => ({ kind: "confirmed", threadId: "thr_job01" }));
      const coordinator = createLaunchCoordinator({
        store: attemptStoreFromRunStore(writes, reads),
        liveIdentity: liveIdentityFromDatabase(db),
        readiness: testReady,
        spawn,
        threadVerify: unsupportedSdkThreadVerifyPort(),
        jobRunning,
      });
      const first = await coordinator.launchPreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshotId: reserved.value.snapshotId,
        digest: reserved.value.digest,
        attemptId: reserved.value.attempt.attemptId,
        attestation: {
          accessVerified: true,
          revisionsVerified: true,
          expectedJobRevision: seeded.job.revision,
          expectedBindingRevision: seeded.binding.revision,
        },
      });
      expect(first.ok).toBe(true);
      if (!first.ok || first.value.kind !== "running") throw new Error("expected running with failed callback");
      expect(first.value.jobStateApplied).toBe(false);
      expect(first.value.receipt.jobBindState).toBe("needs_repair");
      expect(spawn.calls).toHaveLength(1);

      const thrown = await coordinator.reconcileLaunch(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        launchId: first.value.receipt.launchId,
      });
      expect(thrown.ok).toBe(true);
      if (!thrown.ok || thrown.value.kind !== "running") throw new Error("expected repair after throw");
      expect(thrown.value.jobStateApplied).toBe(false);

      const repaired = await coordinator.reconcileLaunch(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        launchId: first.value.receipt.launchId,
      });
      expect(repaired.ok).toBe(true);
      if (!repaired.ok || repaired.value.kind !== "running") throw new Error("expected applied repair");
      expect(repaired.value.jobStateApplied).toBe(true);
      expect(spawn.calls).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("treats cancel-during-spawn as orphan reconciliation, not success canceled", async () => {
    const { db, close } = openFileDb();
    try {
      const seeded = seedProject(db);
      const snapshot = compileFor(seeded);
      const writes = createRunStore(db);
      const reads = createInternalRunStoreReads(db);
      const reserved = writes.reservePreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshot,
        attestation: {
          accessVerified: true,
          revisionsVerified: true,
          expectedJobRevision: seeded.job.revision,
          expectedBindingRevision: seeded.binding.revision,
        },
      });
      if (!reserved.ok) throw new Error(reserved.error.message);
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const spawn = spawnPort(async () => {
        entered();
        await gate;
        return { kind: "confirmed", threadId: "thr_raced01" };
      });
      const coordinator = createLaunchCoordinator({
        store: attemptStoreFromRunStore(writes, reads),
        liveIdentity: liveIdentityFromDatabase(db),
        readiness: testReady,
        spawn,
        threadVerify: unsupportedSdkThreadVerifyPort(),
        jobRunning: jobOk(),
      });
      const pending = coordinator.launchPreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshotId: reserved.value.snapshotId,
        digest: reserved.value.digest,
        attemptId: reserved.value.attempt.attemptId,
        attestation: {
          accessVerified: true,
          revisionsVerified: true,
          expectedJobRevision: seeded.job.revision,
          expectedBindingRevision: seeded.binding.revision,
        },
      });
      await started;
      const current = reads.getAttempt(seeded.ctx, reserved.value.attempt.attemptId);
      if (!current.ok) throw new Error(current.error.message);
      const canceled = writes.transitionAttempt(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        expectedRevision: current.value.revision,
        to: "canceled",
      });
      expect(canceled.ok).toBe(true);
      release();
      const result = await pending;
      expect(result.ok).toBe(true);
      if (!result.ok || result.value.kind !== "needs_reconciliation") throw new Error("expected orphan");
      expect(result.value.receipt.threadId).toBe("thr_raced01");
      expect(result.value.kind).not.toBe("canceled");
    } finally {
      close();
    }
  });

  it("rejects a second concurrent launch of the same attempt on shared SQLite", async () => {
    const { db, close } = openFileDb();
    try {
      const seeded = seedProject(db);
      const snapshot = compileFor(seeded);
      const writes = createRunStore(db);
      const reads = createInternalRunStoreReads(db);
      const reserved = writes.reservePreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshot,
        attestation: {
          accessVerified: true,
          revisionsVerified: true,
          expectedJobRevision: seeded.job.revision,
          expectedBindingRevision: seeded.binding.revision,
        },
      });
      if (!reserved.ok) throw new Error(reserved.error.message);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const spawn = spawnPort(async () => {
        await gate;
        return { kind: "confirmed", threadId: "thr_one" };
      });
      const ports = {
        store: attemptStoreFromRunStore(writes, reads),
        liveIdentity: liveIdentityFromDatabase(db),
        readiness: testReady,
        spawn,
        threadVerify: unsupportedSdkThreadVerifyPort(),
        jobRunning: jobOk(),
      };
      const first = createLaunchCoordinator(ports).launchPreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshotId: reserved.value.snapshotId,
        digest: reserved.value.digest,
        attemptId: reserved.value.attempt.attemptId,
        attestation: {
          accessVerified: true,
          revisionsVerified: true,
          expectedJobRevision: seeded.job.revision,
          expectedBindingRevision: seeded.binding.revision,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await createLaunchCoordinator(ports).launchPreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshotId: reserved.value.snapshotId,
        digest: reserved.value.digest,
        attemptId: reserved.value.attempt.attemptId,
        attestation: {
          accessVerified: true,
          revisionsVerified: true,
          expectedJobRevision: seeded.job.revision,
          expectedBindingRevision: seeded.binding.revision,
        },
      });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(["launch_in_progress", "not_prepared"]).toContain(second.error.code);
      release();
      const done = await first;
      expect(done.ok).toBe(true);
    } finally {
      close();
    }
  });

  it("returns persisted=false when receipt write fails and does not claim reopen durability", async () => {
    const opened = openFileDb();
    const { seeded, writes, reads, reserved } = reserveLaunch(opened.db);
    const spawn = spawnPort(() => ({ kind: "confirmed", threadId: "thr_lost01" }));
    const result = await createLaunchCoordinator({
      store: wrapStore(attemptStoreFromRunStore(writes, reads), {
        failReceiptAlways: true,
        failTransitionTo: ["running", "unknown"],
      }),
      liveIdentity: liveIdentityFromDatabase(opened.db),
      readiness: testReady,
      spawn,
      threadVerify: unsupportedSdkThreadVerifyPort(),
      jobRunning: jobOk(),
    }).launchPreparedRun(seeded.ctx, {
      requestId: requestId(),
      snapshotId: reserved.value.snapshotId,
      digest: reserved.value.digest,
      attemptId: reserved.value.attempt.attemptId,
      attestation: attestation(seeded),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected typed receipt");
    expect(result.value.receipt.persisted).toBe(false);
    expect(result.value.receipt.launchId).toBeTruthy();
    expect(spawn.calls).toHaveLength(0);
    expect(result.value.kind).toBe("unknown");
    if (result.value.kind === "unknown") expect(result.value.code).toBe("receipt_not_durable");
    opened.close();

    const db = reopen(opened.path);
    try {
      const reads2 = createInternalRunStoreReads(db);
      const missing = reads2.getLaunchReceipt(seeded.ctx, result.value.receipt.launchId);
      expect(missing.ok).toBe(false);
      const spawn2 = spawnPort(() => {
        throw new Error("must not respawn");
      });
      const replay = await createLaunchCoordinator({
        store: attemptStoreFromRunStore(createRunStore(db), reads2),
        liveIdentity: liveIdentityFromDatabase(db),
        readiness: testReady,
        spawn: spawn2,
        threadVerify: unsupportedSdkThreadVerifyPort(),
        jobRunning: jobOk(),
      }).launchPreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshotId: reserved.value.snapshotId,
        digest: reserved.value.digest,
        attemptId: reserved.value.attempt.attemptId,
        attestation: attestation(seeded),
      });
      expect(replay.ok).toBe(false);
      if (!replay.ok) expect(replay.error.code).toBe("not_prepared");
      expect(spawn2.calls).toHaveLength(0);
      const recovered = await createLaunchCoordinator({
        store: attemptStoreFromRunStore(createRunStore(db), reads2),
        liveIdentity: liveIdentityFromDatabase(db),
        readiness: testReady,
        spawn: spawn2,
        threadVerify: unsupportedSdkThreadVerifyPort(),
        jobRunning: jobOk(),
      }).reconcileLaunch(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        launchId: result.value.receipt.launchId,
        knownReceipt: result.value.receipt,
      });
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) throw new Error(recovered.error.message);
      expect(recovered.value.kind).not.toBe("running");
      expect(spawn2.calls).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("keeps confirmed thread only on the typed receipt when bind and receipt update fail", async () => {
    const opened = openFileDb();
    const { seeded, writes, reads, reserved } = reserveLaunch(opened.db);
    const spawn = spawnPort(() => ({ kind: "confirmed", threadId: "thr_mem01" }));
    const result = await createLaunchCoordinator({
      store: wrapStore(attemptStoreFromRunStore(writes, reads), {
        failReceiptAfter: 1,
        failTransitionTo: ["running", "unknown"],
      }),
      liveIdentity: liveIdentityFromDatabase(opened.db),
      readiness: testReady,
      spawn,
      threadVerify: unsupportedSdkThreadVerifyPort(),
      jobRunning: jobOk(),
    }).launchPreparedRun(seeded.ctx, {
      requestId: requestId(),
      snapshotId: reserved.value.snapshotId,
      digest: reserved.value.digest,
      attemptId: reserved.value.attempt.attemptId,
      attestation: attestation(seeded),
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "unknown") throw new Error("expected persist_after_spawn");
    expect(result.value.code).toBe("persist_after_spawn");
    expect(result.value.receipt.persisted).toBe(false);
    expect(result.value.receipt.threadId).toBe("thr_mem01");
    expect(spawn.calls).toHaveLength(1);
    opened.close();

    const db = reopen(opened.path);
    try {
      const writes2 = createRunStore(db);
      const reads2 = createInternalRunStoreReads(db);
      const stored = reads2.getLaunchReceipt(seeded.ctx, result.value.receipt.launchId);
      expect(stored.ok).toBe(true);
      if (stored.ok) expect(stored.value.threadId).toBeNull();
      const spawn2 = spawnPort(() => {
        throw new Error("must not respawn");
      });
      const replay = await createLaunchCoordinator({
        store: attemptStoreFromRunStore(writes2, reads2),
        liveIdentity: liveIdentityFromDatabase(db),
        readiness: testReady,
        spawn: spawn2,
        threadVerify: unsupportedSdkThreadVerifyPort(),
        jobRunning: jobOk(),
      }).launchPreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshotId: reserved.value.snapshotId,
        digest: reserved.value.digest,
        attemptId: reserved.value.attempt.attemptId,
        attestation: attestation(seeded),
      });
      expect(replay.ok).toBe(true);
      if (!replay.ok || replay.value.kind === "running") throw new Error("reopen must not invent running");
      expect(spawn2.calls).toHaveLength(0);
      let jobCalls = 0;
      const jobWatch: JobRunningPort = {
        async onConfirmedBind() {
          jobCalls += 1;
          return ok(true);
        },
      };
      const invented = await createLaunchCoordinator({
        store: attemptStoreFromRunStore(writes2, reads2),
        liveIdentity: liveIdentityFromDatabase(db),
        readiness: testReady,
        spawn: spawn2,
        threadVerify: lookupVerify([
          {
            launchId: result.value.receipt.launchId,
            threadId: "thr_mem01",
            attemptId: reserved.value.attempt.attemptId,
            ...snapshotLink(seeded),
          },
        ]),
        jobRunning: jobWatch,
      }).reconcileLaunch(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        launchId: result.value.receipt.launchId,
        knownReceipt: { ...result.value.receipt, threadId: "thr_invented01" },
      });
      expect(invented.ok).toBe(true);
      if (!invented.ok || invented.value.kind === "running") throw new Error("invented thread must not bind");
      expect(invented.value.kind).toBe("needs_reconciliation");
      if (invented.value.kind === "needs_reconciliation") expect(invented.value.code).toBe("thread_mismatch");
      expect(jobCalls).toBe(0);
      const foreignHost = await createLaunchCoordinator({
        store: attemptStoreFromRunStore(writes2, reads2),
        liveIdentity: liveIdentityFromDatabase(db),
        readiness: testReady,
        spawn: spawn2,
        threadVerify: lookupVerify([
          {
            launchId: result.value.receipt.launchId,
            threadId: "thr_mem01",
            attemptId: reserved.value.attempt.attemptId,
            ...snapshotLink(seeded),
            hostId: "host_foreign",
          },
        ]),
        jobRunning: jobWatch,
      }).reconcileLaunch(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        launchId: result.value.receipt.launchId,
        knownReceipt: result.value.receipt,
      });
      expect(foreignHost.ok).toBe(true);
      if (!foreignHost.ok || foreignHost.value.kind === "running") throw new Error("foreign host must not bind");
      if (foreignHost.value.kind === "needs_reconciliation") {
        expect(foreignHost.value.code).toBe("live_binding_mismatch");
      }
      const foreignProject = await createLaunchCoordinator({
        store: attemptStoreFromRunStore(writes2, reads2),
        liveIdentity: liveIdentityFromDatabase(db),
        readiness: testReady,
        spawn: spawn2,
        threadVerify: lookupVerify([
          {
            launchId: result.value.receipt.launchId,
            threadId: "thr_mem01",
            attemptId: reserved.value.attempt.attemptId,
            ...snapshotLink(seeded),
            bbProjectId: "proj_foreign",
          },
        ]),
        jobRunning: jobWatch,
      }).reconcileLaunch(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        launchId: result.value.receipt.launchId,
        knownReceipt: result.value.receipt,
      });
      expect(foreignProject.ok).toBe(true);
      if (!foreignProject.ok || foreignProject.value.kind === "running") throw new Error("foreign project must not bind");
      const foreignLaunch = await createLaunchCoordinator({
        store: attemptStoreFromRunStore(writes2, reads2),
        liveIdentity: liveIdentityFromDatabase(db),
        readiness: testReady,
        spawn: spawn2,
        threadVerify: lookupVerify([
          {
            launchId: requestId(),
            threadId: "thr_mem01",
            attemptId: reserved.value.attempt.attemptId,
            ...snapshotLink(seeded),
          },
        ]),
        jobRunning: jobWatch,
      }).reconcileLaunch(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        launchId: result.value.receipt.launchId,
        knownReceipt: result.value.receipt,
      });
      expect(foreignLaunch.ok).toBe(true);
      if (!foreignLaunch.ok || foreignLaunch.value.kind === "running") throw new Error("foreign launch linkage must not bind");
      if (foreignLaunch.value.kind === "needs_reconciliation") {
        expect(foreignLaunch.value.code).toBe("thread_not_found");
      }
      expect(jobCalls).toBe(0);
      const pending = await createLaunchCoordinator({
        store: attemptStoreFromRunStore(writes2, reads2),
        liveIdentity: liveIdentityFromDatabase(db),
        readiness: testReady,
        spawn: spawn2,
        threadVerify: unsupportedSdkThreadVerifyPort(),
        jobRunning: jobWatch,
      }).reconcileLaunch(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        launchId: result.value.receipt.launchId,
        knownReceipt: result.value.receipt,
      });
      expect(pending.ok).toBe(true);
      if (!pending.ok || pending.value.kind !== "needs_reconciliation") throw new Error("hint is not authority");
      expect(pending.value.code).toBe("thread_verify_unavailable");
      expect(jobCalls).toBe(0);
      const recovered = await createLaunchCoordinator({
        store: attemptStoreFromRunStore(writes2, reads2),
        liveIdentity: liveIdentityFromDatabase(db),
        readiness: testReady,
        spawn: spawn2,
        threadVerify: lookupVerify([
          {
            launchId: result.value.receipt.launchId,
            threadId: "thr_mem01",
            attemptId: reserved.value.attempt.attemptId,
            ...snapshotLink(seeded),
          },
        ]),
        jobRunning: jobWatch,
      }).reconcileLaunch(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        launchId: result.value.receipt.launchId,
        knownReceipt: result.value.receipt,
      });
      expect(recovered.ok).toBe(true);
      if (!recovered.ok || recovered.value.kind !== "running") throw new Error("expected verified bind");
      expect(recovered.value.attempt.threadId).toBe("thr_mem01");
      expect(recovered.value.receipt.persisted).toBe(true);
      expect(jobCalls).toBe(1);
      expect(spawn2.calls).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("rejects foreign launch/thread/receipt identities and hides receipt outside ctx scope", async () => {
    const { db, close } = openFileDb();
    try {
      const { seeded, writes, reads, reserved } = reserveLaunch(db);
      const spawn = spawnPort(() => ({ kind: "confirmed", threadId: "thr_owned01" }));
      const coordinator = createLaunchCoordinator({
        store: attemptStoreFromRunStore(writes, reads),
        liveIdentity: liveIdentityFromDatabase(db),
        readiness: testReady,
        spawn,
        threadVerify: unsupportedSdkThreadVerifyPort(),
        jobRunning: jobOk(),
      });
      const launched = await coordinator.launchPreparedRun(seeded.ctx, {
        requestId: requestId(),
        snapshotId: reserved.value.snapshotId,
        digest: reserved.value.digest,
        attemptId: reserved.value.attempt.attemptId,
        attestation: attestation(seeded),
      });
      expect(launched.ok).toBe(true);
      if (!launched.ok || launched.value.kind !== "running") throw new Error("expected running");
      const launchId = launched.value.receipt.launchId;
      const foreignLaunch = await coordinator.reconcileLaunch(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        launchId: requestId(),
      });
      expect(foreignLaunch.ok).toBe(false);
      if (!foreignLaunch.ok) expect(foreignLaunch.error.code).toBe("bind_id_immutable");
      const foreignKnown = await coordinator.reconcileLaunch(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        launchId,
        knownReceipt: { ...launched.value.receipt, threadId: "thr_foreign01" },
      });
      expect(foreignKnown.ok).toBe(false);
      if (!foreignKnown.ok) expect(foreignKnown.error.code).toBe("bind_id_immutable");
      const replaceThread = writes.recordLaunchReceipt(seeded.ctx, {
        requestId: requestId(),
        receipt: {
          launchId,
          attemptId: reserved.value.attempt.attemptId,
          jobId: reserved.value.attempt.jobId,
          snapshotId: reserved.value.snapshotId,
          digest: reserved.value.digest,
          threadId: "thr_other99",
          spawnKind: "confirmed",
          persistErrorCode: null,
          persistErrorMessage: null,
          jobBindState: "applied",
          needsReconciliation: false,
          parentRequestId: requestId(),
        },
      });
      expect(replaceThread.ok).toBe(false);
      if (!replaceThread.ok) expect(replaceThread.error.code).toBe("bind_id_immutable");
      const downgrade = writes.recordLaunchReceipt(seeded.ctx, {
        requestId: requestId(),
        receipt: {
          launchId,
          attemptId: reserved.value.attempt.attemptId,
          jobId: reserved.value.attempt.jobId,
          snapshotId: reserved.value.snapshotId,
          digest: reserved.value.digest,
          threadId: "thr_owned01",
          spawnKind: "rejected",
          persistErrorCode: null,
          persistErrorMessage: null,
          jobBindState: "failed",
          needsReconciliation: false,
          parentRequestId: requestId(),
        },
      });
      expect(downgrade.ok).toBe(false);
      if (!downgrade.ok) expect(downgrade.error.code).toBe("bind_id_immutable");
      const stolenLaunchId = requestId();
      const foreignReceiptRow = writes.recordLaunchReceipt(seeded.ctx, {
        requestId: requestId(),
        receipt: {
          launchId: stolenLaunchId,
          attemptId: reserved.value.attempt.attemptId,
          jobId: reserved.value.attempt.jobId,
          snapshotId: reserved.value.snapshotId,
          digest: reserved.value.digest,
          threadId: "thr_owned01",
          spawnKind: "confirmed",
          persistErrorCode: null,
          persistErrorMessage: null,
          jobBindState: "applied",
          needsReconciliation: false,
          parentRequestId: requestId(),
        },
      });
      expect(foreignReceiptRow.ok).toBe(false);
      if (!foreignReceiptRow.ok) expect(foreignReceiptRow.error.code).toBe("bind_id_immutable");
      const forbidden = reads.getLaunchReceipt(
        { actor: { kind: "user", userId: "user_other" }, allowedBindingIds: [] },
        launchId,
      );
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) expect(forbidden.error.code).toBe("forbidden_binding");
    } finally {
      close();
    }
  });

  it("routes reconcileByLaunchId confirmed through the same thread verify", async () => {
    const { db, close } = openFileDb();
    try {
      const { seeded, writes, reads, reserved } = reserveLaunch(db);
      const launchId = requestId();
      const launching = writes.transitionAttempt(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        expectedRevision: reserved.value.attempt.revision,
        to: "launching",
        launchId,
      });
      expect(launching.ok).toBe(true);
      const spawn = spawnPort(() => {
        throw new Error("must not spawn");
      });
      const spawnWithLookup: SpawnPort & { calls: LaunchContract[] } = {
        ...spawn,
        async reconcileByLaunchId() {
          return { kind: "confirmed", threadId: "thr_lookup01" };
        },
      };
      let jobCalls = 0;
      const jobWatch: JobRunningPort = {
        async onConfirmedBind() {
          jobCalls += 1;
          return ok(true);
        },
      };
      const ports = {
        store: attemptStoreFromRunStore(writes, reads),
        liveIdentity: liveIdentityFromDatabase(db),
        readiness: testReady,
        spawn: spawnWithLookup,
      };
      const unavailable = await createLaunchCoordinator({
        ...ports,
        threadVerify: unsupportedSdkThreadVerifyPort(),
        jobRunning: jobWatch,
      }).reconcileLaunch(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        launchId,
      });
      expect(unavailable.ok).toBe(true);
      if (!unavailable.ok || unavailable.value.kind === "running") throw new Error("unavailable lookup must not bind");
      expect(unavailable.value.kind).toBe("needs_reconciliation");
      if (unavailable.value.kind === "needs_reconciliation") {
        expect(unavailable.value.code).toBe("thread_verify_unavailable");
      }
      expect(jobCalls).toBe(0);
      expect(spawnWithLookup.calls).toHaveLength(0);
      const foreign = await createLaunchCoordinator({
        ...ports,
        threadVerify: lookupVerify([
          {
            launchId,
            threadId: "thr_lookup01",
            attemptId: reserved.value.attempt.attemptId,
            ...snapshotLink(seeded),
            hostId: "host_foreign",
          },
        ]),
        jobRunning: jobWatch,
      }).reconcileLaunch(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        launchId,
      });
      expect(foreign.ok).toBe(true);
      if (!foreign.ok || foreign.value.kind === "running") throw new Error("foreign lookup must not bind");
      if (foreign.value.kind === "needs_reconciliation") {
        expect(foreign.value.code).toBe("live_binding_mismatch");
      }
      expect(jobCalls).toBe(0);
      expect(spawnWithLookup.calls).toHaveLength(0);
      const verified = await createLaunchCoordinator({
        ...ports,
        threadVerify: lookupVerify([
          {
            launchId,
            threadId: "thr_lookup01",
            attemptId: reserved.value.attempt.attemptId,
            ...snapshotLink(seeded),
          },
        ]),
        jobRunning: jobWatch,
      }).reconcileLaunch(seeded.ctx, {
        requestId: requestId(),
        attemptId: reserved.value.attempt.attemptId,
        launchId,
      });
      expect(verified.ok).toBe(true);
      if (!verified.ok || verified.value.kind !== "running") throw new Error("expected verified bind");
      expect(verified.value.attempt.threadId).toBe("thr_lookup01");
      expect(verified.value.jobStateApplied).toBe(true);
      expect(jobCalls).toBe(1);
      expect(spawnWithLookup.calls).toHaveLength(0);
    } finally {
      close();
    }
  });
});
