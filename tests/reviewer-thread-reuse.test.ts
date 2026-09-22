import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ok } from "../src/domain";
import { listBoundLaunchWatches } from "../src/server/api/launch-rpc";
import { openMigratedDatabase, type SqlDatabase } from "../src/server/db";
import { compileContextSnapshot } from "../src/server/runtime/context-snapshot";
import type { ContextSnapshot } from "../src/server/runtime/context-snapshot/types";
import { createCancelLaunchService } from "../src/server/runtime/cancel-launch";
import { createIsolatedThreadVerifyPort } from "../src/server/runtime/isolated-sdk/sdk-ports";
import type { IsolatedSendOutcome, IsolatedSendPort } from "../src/server/runtime/isolated-sdk/send-port";
import {
  attemptStoreFromRunStore,
  createLaunchCoordinator,
  liveIdentityFromDatabase,
  type JobRunningPort,
  type LaunchContract,
  type SpawnOutcome,
  type SpawnPort,
} from "../src/server/runtime/launch";
import { unsupportedSdkThreadVerifyPort } from "../src/server/runtime/launch/sdk-spawn";
import {
  createReviewerThreadReusePort,
  findReviewerThread,
  rememberReviewerThread,
  resolveReviewLine,
} from "../src/server/runtime/reviewer-thread/service";
import { createInternalRunStoreReads, createRunStore } from "../src/server/runtime/run-store";
import { createDomainStore, type ServiceContext } from "../src/server/services";
import type { CatalogSkillId } from "../src/shared/contracts/ids";
import type { OfficialThreadStatus, ThreadGetPort, ThreadListRunningPort, ThreadStopPort } from "../src/server/runtime/stop-handoff";

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

function catalogHash(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

function openFileDb(): SqlDatabase {
  const dir = mkdtempSync(join(tmpdir(), "agy-reuse-"));
  tempDirs.push(dir);
  return openMigratedDatabase(new Database(join(dir, "agency.sqlite")));
}

function seedWorld(db: SqlDatabase) {
  const store = createDomainStore(db);
  const bootstrap: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [] };
  const policy = store.createPolicyVersion(bootstrap, {
    requestId: requestId(),
    allowedCapabilities: ["read.files"],
    cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_mini"] },
    secretRefs: ["OPENAI_API_KEY"],
  });
  if (!policy.ok) throw new Error(policy.error.message);
  const provision = (name: string) => {
    const agent = store.provisionAgent(bootstrap, {
      requestId: requestId(),
      name,
      state: "active",
      version: {
        version: 1,
        role: name,
        instructions: "Работать по брифу.",
        providerId: "codex",
        model: "gpt-5.6",
        skillIds: [AGENCY_SKILL],
        mcpIds: [],
        policyVersionId: policy.value.id,
      },
    });
    if (!agent.ok) throw new Error(agent.error.message);
    return agent.value;
  };
  const lead = provision("Руководитель");
  const developer = provision("Разработчик");
  const reviewer = provision("Проверяющий");
  const otherReviewer = provision("Другой проверяющий");
  const department = store.provisionDepartment(bootstrap, {
    requestId: requestId(),
    name: "Разработка",
    leadAgentId: lead.agent.id,
    process: {
      instructions: "Черновик, затем проверка.",
      acceptance: "Есть принятая версия файла.",
      reviewPolicy: { required: true },
    },
  });
  if (!department.ok) throw new Error(department.error.message);
  for (const [agentId, role] of [
    [developer.agent.id, "executor"],
    [reviewer.agent.id, "reviewer"],
    [otherReviewer.agent.id, "reviewer"],
  ] as const) {
    const added = store.addMembership(bootstrap, {
      requestId: requestId(),
      departmentId: department.value.department.id,
      agentId,
      role,
    });
    if (!added.ok) throw new Error(added.error.message);
  }
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
  const processVersion = store.getProcessVersion(department.value.department.processVersionId);
  if (!processVersion) throw new Error("process missing");
  const main = store.createJob(ctx, {
    requestId: requestId(),
    key: "AG-900",
    bindingId: binding.value.id,
    departmentId: department.value.department.id,
    title: "Главная",
    brief: "Собрать продукт.",
    acceptance: "Принятые станции.",
    parentJobId: null,
    assignedAgentId: lead.agent.id,
    priority: "normal",
    dueAt: null,
  });
  if (!main.ok) throw new Error(main.error.message);
  const work = (title: string, key: string) => {
    const created = store.createJob(ctx, {
      requestId: requestId(),
      key,
      bindingId: binding.value.id,
      departmentId: department.value.department.id,
      title,
      brief: `Бриф ${title}.`,
      acceptance: `Критерий ${title}.`,
      parentJobId: main.value.id,
      assignedAgentId: developer.agent.id,
      priority: "normal",
      dueAt: null,
    });
    if (!created.ok) throw new Error(created.error.message);
    return created.value;
  };
  const review = (title: string, key: string, reviewerId: string) => {
    const created = store.createJob(ctx, {
      requestId: requestId(),
      key,
      bindingId: binding.value.id,
      departmentId: department.value.department.id,
      title,
      brief: `Бриф ${title}.`,
      acceptance: `Критерий ${title}.`,
      parentJobId: main.value.id,
      assignedAgentId: reviewerId,
      priority: "normal",
      dueAt: null,
    });
    if (!created.ok) throw new Error(created.error.message);
    return created.value;
  };
  const linkReview = (workJobId: string, reviewJobId: string, hash = "aa".repeat(32)) => {
    db.prepare(
      `INSERT INTO agency_auto_review (job_id, hash, review_job_id, outcome, created_at) VALUES (?, ?, ?, 'queued', '2026-09-22T00:00:00.000Z')`,
    ).run(workJobId, hash, reviewJobId);
  };
  const input = (targetJobId: string, sourceJobId: string) => {
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO agency_job_input_ref (target_job_id, source_job_id, artifact_id, version, hash, host_id, relative_path, accepted, created_at)
       VALUES (?, ?, ?, 1, ?, 'host_mini', 'report.md', 0, '2026-09-22T00:00:00.000Z')`,
    ).run(targetJobId, sourceJobId, `art_${randomUUID().slice(0, 8)}`, "ab".repeat(32));
    db.pragma("foreign_keys = ON");
  };
  return {
    ctx,
    store,
    policy: policy.value,
    processVersion,
    binding: binding.value,
    reviewer,
    otherReviewer,
    developer,
    work,
    review,
    linkReview,
    input,
  };
}

function compileFor(
  world: ReturnType<typeof seedWorld>,
  job: ReturnType<ReturnType<typeof seedWorld>["review"]>,
  agentVersion: ReturnType<typeof seedWorld>["reviewer"]["version"],
): ContextSnapshot {
  const text = "Писать только в canonicalRoot.";
  const result = compileContextSnapshot({
    binding: world.binding,
    job,
    agentVersion,
    processVersion: world.processVersion,
    bindingPolicyVersion: world.policy,
    agentPolicyVersion: world.policy,
    projectRules: { versionId: "rul_project1", text, hash: catalogHash(text) },
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

function recordingJob(): JobRunningPort & { binds: Array<{ jobId: string; threadId: string; attemptId: string }> } {
  const binds: Array<{ jobId: string; threadId: string; attemptId: string }> = [];
  return {
    binds,
    onConfirmedBind: async (_ctx, bind) => {
      binds.push({ jobId: bind.jobId, threadId: bind.threadId, attemptId: bind.attemptId });
      return ok(true);
    },
  };
}

function sendPort(impl: () => Promise<IsolatedSendOutcome> | IsolatedSendOutcome): IsolatedSendPort & {
  calls: Array<{ threadId: string; text: string }>;
} {
  const calls: Array<{ threadId: string; text: string }> = [];
  return {
    calls,
    async send(args) {
      calls.push(args);
      return impl();
    },
    async recoverContinuation() {
      return "absent";
    },
  };
}

async function launchReview(
  db: SqlDatabase,
  world: ReturnType<typeof seedWorld>,
  job: ReturnType<ReturnType<typeof seedWorld>["review"]>,
  agentVersion: ReturnType<typeof seedWorld>["reviewer"]["version"],
  ports: {
    spawn: ReturnType<typeof spawnPort>;
    send: IsolatedSendPort;
    getStatus: string | "throw";
    jobRunning: JobRunningPort;
  },
) {
  const snapshot = compileFor(world, job, agentVersion);
  const writes = createRunStore(db);
  const reads = createInternalRunStoreReads(db);
  const reserved = writes.reservePreparedRun(world.ctx, {
    requestId: requestId(),
    snapshot,
    attestation: {
      accessVerified: true,
      revisionsVerified: true,
      expectedJobRevision: job.revision,
      expectedBindingRevision: world.binding.revision,
    },
  });
  if (!reserved.ok) throw new Error(reserved.error.message);
  const coordinator = createLaunchCoordinator({
    store: attemptStoreFromRunStore(writes, reads),
    liveIdentity: liveIdentityFromDatabase(db),
    readiness: testReady,
    spawn: ports.spawn,
    threadVerify: unsupportedSdkThreadVerifyPort(),
    jobRunning: ports.jobRunning,
    threadReuse: createReviewerThreadReusePort(
      db,
      {
        async get(args) {
          if (ports.getStatus === "throw") throw new Error("thread get failed");
          return { id: args.threadId, status: ports.getStatus };
        },
      },
      ports.send,
    ),
  });
  const result = await coordinator.launchPreparedRun(world.ctx, {
    requestId: requestId(),
    snapshotId: reserved.value.snapshotId,
    digest: reserved.value.digest,
    attemptId: reserved.value.attempt.attemptId,
    attestation: {
      accessVerified: true,
      revisionsVerified: true,
      expectedJobRevision: job.revision,
      expectedBindingRevision: world.binding.revision,
    },
  });
  return { result, reserved: reserved.value, snapshot, writes };
}

describe("reviewer thread reuse", () => {
  it("spawns on the first review of a line and remembers the thread id", async () => {
    const db = openFileDb();
    const world = seedWorld(db);
    const w0 = world.work("Реализация", "AG-901");
    const r0 = world.review("Проверка 0", "AG-902", world.reviewer.agent.id);
    world.linkReview(w0.id, r0.id);
    expect(resolveReviewLine(db, r0.id)).toBe(w0.id);
    const spawn = spawnPort(() => ({ kind: "confirmed", threadId: "thr_review_first" }));
    const send = sendPort(() => ({ kind: "confirmed", delivery: "sent" }));
    const jobRunning = recordingJob();
    const launched = await launchReview(db, world, r0, world.reviewer.version, {
      spawn,
      send,
      getStatus: "active",
      jobRunning,
    });
    expect(launched.result.ok).toBe(true);
    if (!launched.result.ok || launched.result.value.kind !== "running") throw new Error("expected running");
    expect(spawn.calls).toHaveLength(1);
    expect(send.calls).toHaveLength(0);
    expect(launched.result.value.attempt.threadId).toBe("thr_review_first");
    expect(findReviewerThread(db, world.reviewer.agent.id, w0.id)?.threadId).toBe("thr_review_first");
    db.close();
  });

  it("sends a follow-up to the saved thread on a second review and does not spawn", async () => {
    const db = openFileDb();
    const world = seedWorld(db);
    const w0 = world.work("Реализация", "AG-911");
    const r0 = world.review("Проверка 0", "AG-912", world.reviewer.agent.id);
    const w1 = world.work("Доработка", "AG-913");
    const r1 = world.review("Проверка 1", "AG-914", world.reviewer.agent.id);
    world.linkReview(w0.id, r0.id, "11".repeat(32));
    world.linkReview(w1.id, r1.id, "22".repeat(32));
    world.input(w1.id, r0.id);
    const spawn = spawnPort(() => ({ kind: "confirmed", threadId: "thr_review_live" }));
    const send = sendPort(() => ({ kind: "confirmed", delivery: "sent" }));
    const jobRunning = recordingJob();
    const first = await launchReview(db, world, r0, world.reviewer.version, {
      spawn,
      send,
      getStatus: "idle",
      jobRunning,
    });
    expect(first.result.ok && first.result.value.kind === "running").toBe(true);
    expect(spawn.calls).toHaveLength(1);
    const second = await launchReview(db, world, r1, world.reviewer.version, {
      spawn,
      send,
      getStatus: "idle",
      jobRunning,
    });
    expect(second.result.ok).toBe(true);
    if (!second.result.ok || second.result.value.kind !== "running") throw new Error("expected running");
    expect(spawn.calls).toHaveLength(1);
    expect(send.calls).toHaveLength(1);
    expect(send.calls[0]?.threadId).toBe("thr_review_live");
    expect(send.calls[0]?.text).toContain("AG-914");
    expect(second.result.value.attempt.threadId).toBe("thr_review_live");
    expect(second.result.value.receipt.threadId).toBe("thr_review_live");
    expect(second.result.value.receipt.spawnKind).toBe("confirmed");
    expect(jobRunning.binds.at(-1)?.threadId).toBe("thr_review_live");
    expect(jobRunning.binds.at(-1)?.jobId).toBe(r1.id);
    expect(findReviewerThread(db, world.reviewer.agent.id, w0.id)?.threadId).toBe("thr_review_live");
    db.close();
  });

  it("spawns a new thread when the saved one is archived or send is rejected", async () => {
    const db = openFileDb();
    const world = seedWorld(db);
    const w0 = world.work("Реализация", "AG-921");
    const r0 = world.review("Проверка 0", "AG-922", world.reviewer.agent.id);
    const w1 = world.work("Доработка", "AG-923");
    const r1 = world.review("Проверка 1", "AG-924", world.reviewer.agent.id);
    world.linkReview(w0.id, r0.id, "31".repeat(32));
    world.linkReview(w1.id, r1.id, "32".repeat(32));
    world.input(w1.id, r0.id);
    let spawnNo = 0;
    const spawn = spawnPort(() => ({ kind: "confirmed", threadId: `thr_spawn_${spawnNo++}` }));
    const send = sendPort(() => ({ kind: "confirmed", delivery: "sent" }));
    const jobRunning = recordingJob();
    await launchReview(db, world, r0, world.reviewer.version, {
      spawn,
      send,
      getStatus: "active",
      jobRunning,
    });
    expect(findReviewerThread(db, world.reviewer.agent.id, w0.id)?.threadId).toBe("thr_spawn_0");
    const dead = await launchReview(db, world, r1, world.reviewer.version, {
      spawn,
      send,
      getStatus: "archived",
      jobRunning,
    });
    expect(dead.result.ok && dead.result.value.kind === "running").toBe(true);
    if (!dead.result.ok || dead.result.value.kind !== "running") throw new Error("expected running");
    expect(send.calls).toHaveLength(0);
    expect(spawn.calls).toHaveLength(2);
    expect(dead.result.value.attempt.threadId).toBe("thr_spawn_1");
    expect(findReviewerThread(db, world.reviewer.agent.id, w0.id)?.threadId).toBe("thr_spawn_1");

    const w2 = world.work("Ещё доработка", "AG-925");
    const r2 = world.review("Проверка 2", "AG-926", world.reviewer.agent.id);
    world.linkReview(w2.id, r2.id, "33".repeat(32));
    world.input(w2.id, r1.id);
    const rejectSend = sendPort(() => ({ kind: "rejected", code: "send_denied", message: "not delivered" }));
    const afterReject = await launchReview(db, world, r2, world.reviewer.version, {
      spawn,
      send: rejectSend,
      getStatus: "idle",
      jobRunning,
    });
    expect(afterReject.result.ok && afterReject.result.value.kind === "running").toBe(true);
    if (!afterReject.result.ok || afterReject.result.value.kind !== "running") throw new Error("expected running");
    expect(rejectSend.calls).toHaveLength(1);
    expect(spawn.calls).toHaveLength(3);
    expect(afterReject.result.value.attempt.threadId).toBe("thr_spawn_2");
    expect(findReviewerThread(db, world.reviewer.agent.id, w0.id)?.threadId).toBe("thr_spawn_2");
    db.close();
  });

  it("gives another reviewer of the same line their own spawn", async () => {
    const db = openFileDb();
    const world = seedWorld(db);
    const w0 = world.work("Реализация", "AG-931");
    const r0 = world.review("Проверка 0", "AG-932", world.reviewer.agent.id);
    const rOther = world.review("Проверка другим", "AG-933", world.otherReviewer.agent.id);
    world.linkReview(w0.id, r0.id, "41".repeat(32));
    world.linkReview(w0.id, rOther.id, "42".repeat(32));
    let revNo = 0;
    const spawn = spawnPort(() => ({ kind: "confirmed", threadId: `thr_rev_${revNo++}` }));
    const send = sendPort(() => ({ kind: "confirmed", delivery: "sent" }));
    const jobRunning = recordingJob();
    await launchReview(db, world, r0, world.reviewer.version, {
      spawn,
      send,
      getStatus: "idle",
      jobRunning,
    });
    const other = await launchReview(db, world, rOther, world.otherReviewer.version, {
      spawn,
      send,
      getStatus: "idle",
      jobRunning,
    });
    expect(other.result.ok && other.result.value.kind === "running").toBe(true);
    if (!other.result.ok || other.result.value.kind !== "running") throw new Error("expected running");
    expect(spawn.calls).toHaveLength(2);
    expect(send.calls).toHaveLength(0);
    expect(other.result.value.attempt.threadId).toBe("thr_rev_1");
    expect(findReviewerThread(db, world.reviewer.agent.id, w0.id)?.threadId).toBe("thr_rev_0");
    expect(findReviewerThread(db, world.otherReviewer.agent.id, w0.id)?.threadId).toBe("thr_rev_1");
    db.close();
  });

  it("listBoundLaunchWatches keeps one live attempt per shared thread", async () => {
    const db = openFileDb();
    const world = seedWorld(db);
    const w0 = world.work("Реализация", "AG-941");
    const r0 = world.review("Проверка 0", "AG-942", world.reviewer.agent.id);
    const w1 = world.work("Доработка", "AG-943");
    const r1 = world.review("Проверка 1", "AG-944", world.reviewer.agent.id);
    world.linkReview(w0.id, r0.id, "51".repeat(32));
    world.linkReview(w1.id, r1.id, "52".repeat(32));
    world.input(w1.id, r0.id);
    const spawn = spawnPort(() => ({ kind: "confirmed", threadId: "thr_shared_watch" }));
    const send = sendPort(() => ({ kind: "confirmed", delivery: "sent" }));
    const jobRunning = recordingJob();
    const first = await launchReview(db, world, r0, world.reviewer.version, {
      spawn,
      send,
      getStatus: "idle",
      jobRunning,
    });
    if (!first.result.ok || first.result.value.kind !== "running") throw new Error("first");
    first.writes.transitionAttempt(world.ctx, {
      requestId: requestId(),
      attemptId: first.result.value.attempt.attemptId,
      expectedRevision: first.result.value.attempt.revision,
      to: "succeeded",
    });
    const second = await launchReview(db, world, r1, world.reviewer.version, {
      spawn,
      send,
      getStatus: "idle",
      jobRunning,
    });
    if (!second.result.ok || second.result.value.kind !== "running") throw new Error("second");
    const watches = listBoundLaunchWatches(db);
    const shared = watches.filter((row) => row.threadId === "thr_shared_watch");
    expect(shared).toHaveLength(1);
    expect(shared[0]?.jobId).toBe(r1.id);
    db.close();
  });

  it("createIsolatedThreadVerifyPort accepts first-spawn metadata via expectedMetadata", async () => {
    const originLaunchId = randomUUID();
    const originAttemptId = "run_origin000000000000000001";
    const originJobId = "job_origin000001";
    const currentLaunchId = randomUUID();
    const port = createIsolatedThreadVerifyPort(
      {
        async spawn() {
          throw new Error("unused");
        },
        async get() {
          return {
            id: "thr_reused01",
            status: "idle",
            projectId: "proj_trusted",
            providerId: "codex",
            model: "gpt-5.6",
            environmentId: "env_1",
            pluginMetadata: {
              agencyLaunchId: originLaunchId,
              agencyAttemptId: originAttemptId,
              agencyJobId: originJobId,
            },
            host: { id: "host_mini" },
            environment: { id: "env_1", hostId: "host_mini", path: "/tmp/agency-root" },
          };
        },
        async list() {
          return [];
        },
      },
      true,
    );
    const snapshot = {
      schemaVersion: 2,
      digest: "d".repeat(64),
      prompt: {
        digest: "p".repeat(64),
        levels: {
          platform: "p",
          agency: "a",
          project: "pr",
          department: "d",
          agent: "ag",
          job: "Job",
          handoff: "",
        },
      },
      binding: {
        id: "bnd_aaaaaaaa",
        hostId: "host_mini",
        canonicalRoot: "/tmp/agency-root",
        revision: 1,
        bbProjectId: "proj_trusted",
        environmentId: "env_1",
        policyVersionId: "pol_aaaaaaaa",
      },
      job: {
        id: "job_current00001",
        key: "AG-1",
        title: "T",
        revision: 1,
        departmentId: "dep_aaaaaaaa",
        assignedAgentId: "agt_aaaaaaaa",
        briefHash: "b".repeat(64),
        acceptanceHash: "c".repeat(64),
      },
      agentVersion: {
        id: "avr_aaaaaaaa",
        agentId: "agt_aaaaaaaa",
        version: 1,
        providerId: "codex",
        model: "gpt-5.6",
        role: "reviewer",
        instructionsHash: "i".repeat(64),
        policyVersionId: "pol_aaaaaaaa",
        skillIds: [],
        mcpIds: [],
      },
    } as unknown as ContextSnapshot;
    const withoutHint = await port.verifyConfirmedThread(
      {
        launchId: currentLaunchId,
        attemptId: "run_current0000000000000001",
        threadId: "thr_reused01",
        jobId: "job_current00001",
        snapshotId: "snp_aaaaaaaaaaaaaaaaaaaaaaaa",
        digest: "d".repeat(64),
      },
      snapshot,
    );
    expect(withoutHint.kind).toBe("rejected");
    const withHint = await port.verifyConfirmedThread(
      {
        launchId: currentLaunchId,
        attemptId: "run_current0000000000000001",
        threadId: "thr_reused01",
        jobId: "job_current00001",
        snapshotId: "snp_aaaaaaaaaaaaaaaaaaaaaaaa",
        digest: "d".repeat(64),
        expectedMetadata: { launchId: originLaunchId, attemptId: originAttemptId, jobId: originJobId },
      },
      snapshot,
    );
    expect(withHint.kind).toBe("confirmed");
    if (withHint.kind === "confirmed") {
      expect(withHint.identity.launchId).toBe(currentLaunchId);
      expect(withHint.identity.attemptId).toBe("run_current0000000000000001");
    }
  });

  it("marks the reviewer-thread row dead when the reused attempt is canceled", async () => {
    const db = openFileDb();
    const world = seedWorld(db);
    const w0 = world.work("Реализация", "AG-951");
    const r0 = world.review("Проверка 0", "AG-952", world.reviewer.agent.id);
    world.linkReview(w0.id, r0.id);
    const spawn = spawnPort(() => ({ kind: "confirmed", threadId: "thr_cancel_reuse" }));
    const send = sendPort(() => ({ kind: "confirmed", delivery: "sent" }));
    const jobRunning = recordingJob();
    const launched = await launchReview(db, world, r0, world.reviewer.version, {
      spawn,
      send,
      getStatus: "idle",
      jobRunning,
    });
    if (!launched.result.ok || launched.result.value.kind !== "running") throw new Error("expected running");
    expect(findReviewerThread(db, world.reviewer.agent.id, w0.id)?.threadId).toBe("thr_cancel_reuse");
    const job = world.store.getJob(r0.id)!;
    const stop: ThreadStopPort = {
      supported: true,
      async stop() {
        return { ok: true };
      },
    };
    const get: ThreadGetPort = {
      supported: true,
      async get() {
        return { threadId: "thr_cancel_reuse", status: "idle" as OfficialThreadStatus };
      },
    };
    const listRunning: ThreadListRunningPort = {
      supported: true,
      async listRunning() {
        return [];
      },
    };
    const service = createCancelLaunchService({
      db,
      store: world.store,
      runs: launched.writes,
      reads: createInternalRunStoreReads(db),
      stop,
      get,
      listRunning,
    });
    const canceled = await service.cancelLaunch(world.ctx, {
      requestId: requestId(),
      jobId: r0.id,
      attemptId: launched.result.value.attempt.attemptId,
      expectedJobRevision: job.revision,
      expectedAttemptRevision: launched.result.value.attempt.revision,
      launchId: launched.result.value.receipt.launchId,
      threadId: "thr_cancel_reuse",
      reason: "owner_cancel",
    });
    expect(canceled.ok).toBe(true);
    expect(findReviewerThread(db, world.reviewer.agent.id, w0.id)).toBeNull();
    db.close();
  });

  it("does not reuse a thread for a job that is not an auto-review", async () => {
    const db = openFileDb();
    const world = seedWorld(db);
    const work = world.work("Реализация без проверки", "AG-961");
    rememberReviewerThread(db, {
      reviewerAgentId: world.developer.agent.id,
      lineJobId: work.id,
      threadId: "thr_should_not_reuse",
      launchId: "lch_x",
      attemptId: "att_x",
      jobId: work.id,
      now: "2026-09-22T00:00:00.000Z",
    });
    const spawn = spawnPort(() => ({ kind: "confirmed", threadId: "thr_executor_new" }));
    const send = sendPort(() => ({ kind: "confirmed", delivery: "sent" }));
    const jobRunning = recordingJob();
    const launched = await launchReview(db, world, work, world.developer.version, {
      spawn,
      send,
      getStatus: "idle",
      jobRunning,
    });
    expect(launched.result.ok && launched.result.value.kind === "running").toBe(true);
    if (!launched.result.ok || launched.result.value.kind !== "running") throw new Error("expected running");
    expect(spawn.calls).toHaveLength(1);
    expect(send.calls).toHaveLength(0);
    expect(launched.result.value.attempt.threadId).toBe("thr_executor_new");
    db.close();
  });
});
