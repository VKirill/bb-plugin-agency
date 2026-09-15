import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase, type SqlDatabase } from "../src/server/db";
import { createDomainStore, type ServiceContext } from "../src/server/services";
import { applyVerifiedReviewToStore } from "../src/server/runtime/isolated-sdk/completion-apply";
import { createCompletionWatch } from "../src/server/runtime/isolated-sdk/completion-watch";
import { interpretVerifiedCompletion } from "../src/server/runtime/isolated-sdk/completion";
import type { IsolatedThreadsApi, IsolatedThreadView } from "../src/server/runtime/isolated-sdk/sdk-ports";
import { hashBytes } from "../src/host/guarded-fs";

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
  const dir = mkdtempSync(join(tmpdir(), "agy-watch-"));
  tempDirs.push(dir);
  const path = join(dir, "agency.sqlite");
  const db = openMigratedDatabase(new Database(path));
  return { db, path, close: () => db.close() };
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
      skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
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
    canonicalRoot: "/tmp/agy-watch-root",
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
    key: "AG-801",
    bindingId: binding.value.id,
    departmentId: department.value.department.id,
    title: "Карточка",
    brief: "Собрать карточку.",
    acceptance: "Текст принят.",
    parentJobId: null,
    assignedAgentId: agent.value.agent.id,
    priority: "normal",
    dueAt: null,
  });
  if (!job.ok) throw new Error(job.error.message);
  const facts = store.setJobExecutionFacts(ctx, {
    requestId: requestId(),
    jobId: job.value.id,
    threadBound: true,
  });
  if (!facts.ok) throw new Error(facts.error.message);
  const queued = store.transitionJob(ctx, {
    requestId: requestId(),
    jobId: job.value.id,
    expectedRevision: job.value.revision,
    to: "queued",
  });
  if (!queued.ok) throw new Error(queued.error.message);
  const running = store.transitionJob(ctx, {
    requestId: requestId(),
    jobId: job.value.id,
    expectedRevision: queued.value.revision,
    to: "running",
  });
  if (!running.ok) throw new Error(running.error.message);
  return { store, ctx, job: running.value };
}

function publishVersion(
  seeded: Awaited<ReturnType<typeof seedRunningJob>>,
  bytes: Uint8Array,
) {
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

function idleThreads(threadId: string): IsolatedThreadsApi {
  return {
    async get(): Promise<IsolatedThreadView> {
      return { id: threadId, status: "idle" };
    },
    spawn: async () => {
      throw new Error("spawn unused");
    },
    list: async () => {
      throw new Error("list unused");
    },
  } as IsolatedThreadsApi;
}

describe("completion watch store review", () => {
  it("event/poll transitions running Job to review with published hash and is idempotent after reload", async () => {
    const opened = openFileDb();
    const seeded = await seedRunningJob(opened.db);
    const bytes = new TextEncoder().encode("published-body\n");
    const version = publishVersion(seeded, bytes);
    const launchId = randomUUID();
    const threadId = "thr_watchreview01";
    const row = { threadId, jobId: seeded.job.id, launchId };
    let published = true;
    const watch = createCompletionWatch({
      threads: idleThreads(threadId),
      listBoundLaunches: () => [row],
      pollMs: 60_000,
      readPublishedForJob: async () =>
        published
          ? { publishedVerified: true, acceptedVerified: false, publishedHash: version.hash }
          : { publishedVerified: false, acceptedVerified: false, publishedHash: null },
      applyReading: async (bound, reading, publishedHash) => {
        const applied = applyVerifiedReviewToStore({
          store: seeded.store,
          ctx: seeded.ctx,
          jobId: bound.jobId,
          launchId: bound.launchId,
          reading,
          publishedHash,
        });
        if (!applied.ok) throw new Error(applied.error.message);
        expect(applied.value.runSucceeded).toBe(false);
        return applied.value;
      },
    });
    published = false;
    await watch.poll();
    expect(seeded.store.getJob(seeded.job.id)?.state).toBe("running");
    published = true;
    await watch.poll();
    const after = seeded.store.getJob(seeded.job.id);
    expect(after?.state).toBe("review");
    expect(after?.revision).toBe(seeded.job.revision + 1);
    expect(version.hash).toBe(createHash("sha256").update(bytes).digest("hex"));
    const retry = applyVerifiedReviewToStore({
      store: seeded.store,
      ctx: seeded.ctx,
      jobId: seeded.job.id,
      launchId,
      reading: interpretVerifiedCompletion({
        threadStatus: "idle",
        publishedVerified: true,
        acceptedVerified: false,
      }),
      publishedHash: version.hash,
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error(retry.error.message);
    expect(retry.value.reviewApplied).toBe(false);
    expect(retry.value.jobState).toBe("review");
    expect(retry.value.publishedHash).toBe(version.hash);
    expect(retry.value.runSucceeded).toBe(false);
    watch.dispose();
    const reloaded = createCompletionWatch({
      threads: idleThreads(threadId),
      listBoundLaunches: () => [row],
      pollMs: 60_000,
      readPublishedForJob: async () => ({
        publishedVerified: true,
        acceptedVerified: false,
        publishedHash: version.hash,
      }),
      applyReading: async (bound, reading, publishedHash) => {
        const applied = applyVerifiedReviewToStore({
          store: seeded.store,
          ctx: seeded.ctx,
          jobId: bound.jobId,
          launchId: bound.launchId,
          reading,
          publishedHash,
        });
        if (!applied.ok) throw new Error(applied.error.message);
        return applied.value;
      },
    });
    await reloaded.poll();
    expect(seeded.store.getJob(seeded.job.id)?.state).toBe("review");
    expect(seeded.store.getJob(seeded.job.id)?.revision).toBe(after?.revision);
    reloaded.dispose();
    opened.close();
  });

  it("does not move Job to review when no published hash-verified artifact", async () => {
    const opened = openFileDb();
    const seeded = await seedRunningJob(opened.db);
    const launchId = randomUUID();
    const threadId = "thr_watchnoreview1";
    const watch = createCompletionWatch({
      threads: idleThreads(threadId),
      listBoundLaunches: () => [{ threadId, jobId: seeded.job.id, launchId }],
      pollMs: 60_000,
      readPublishedForJob: async () => ({
        publishedVerified: false,
        acceptedVerified: false,
        publishedHash: null,
      }),
      applyReading: async (bound, reading, publishedHash) => {
        const applied = applyVerifiedReviewToStore({
          store: seeded.store,
          ctx: seeded.ctx,
          jobId: bound.jobId,
          launchId: bound.launchId,
          reading,
          publishedHash,
        });
        if (!applied.ok) throw new Error(applied.error.message);
        return applied.value;
      },
    });
    watch.hintFromCoreEvent({ id: threadId, status: "idle" });
    await watch.poll();
    expect(seeded.store.getJob(seeded.job.id)?.state).toBe("running");
    watch.dispose();
    opened.close();
  });

  it("isolates a thrown row, coalesces overlapping poll, and skips apply/onReading after dispose", async () => {
    const jobs = ["job_a", "job_b"];
    const seen: string[] = [];
    const applied: string[] = [];
    const notified: string[] = [];
    let releaseGet!: () => void;
    const holdGet = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    const watch = createCompletionWatch({
      threads: {
        async get(args) {
          if (args.threadId === "thr_a") await holdGet;
          return { id: args.threadId, status: "idle" };
        },
        spawn: async () => {
          throw new Error("unused");
        },
        list: async () => [],
      },
      listBoundLaunches: () => [
        { threadId: "thr_a", jobId: jobs[0]!, launchId: "11111111-1111-4111-8111-111111111111" },
        { threadId: "thr_b", jobId: jobs[1]!, launchId: "22222222-2222-4222-8222-222222222222" },
      ],
      pollMs: 60_000,
      readPublishedForJob: async (jobId) => {
        seen.push(jobId);
        if (jobId === jobs[0]) throw new Error("published failed");
        return { publishedVerified: false, acceptedVerified: false, publishedHash: null };
      },
      applyReading: async (row, reading) => {
        applied.push(row.jobId);
        return {
          ...reading,
          jobState: null,
          reviewApplied: false,
          publishedHash: null,
          attemptState: null,
          attemptReviewApplied: false,
          attemptAcceptedApplied: false,
        };
      },
      onReading: (jobId) => {
        notified.push(jobId);
      },
    });
    const first = watch.poll();
    const second = watch.poll();
    watch.hintFromCoreEvent({ id: "thr_a", status: "idle" });
    releaseGet();
    await Promise.all([first, second]);
    expect(seen.filter((id) => id === jobs[1])).not.toHaveLength(0);
    expect(applied).toContain(jobs[1]);
    expect(applied).not.toContain(jobs[0]);
    expect(notified).toContain(jobs[1]);

    let applyAfterDispose = 0;
    let notifyAfterDispose = 0;
    let releaseLate!: () => void;
    const late = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    const lateWatch = createCompletionWatch({
      threads: {
        async get() {
          await late;
          return { id: "thr_late", status: "idle" };
        },
        spawn: async () => {
          throw new Error("unused");
        },
        list: async () => [],
      },
      listBoundLaunches: () => [{ threadId: "thr_late", jobId: "job_late", launchId: "33333333-3333-4333-8333-333333333333" }],
      pollMs: 60_000,
      readPublishedForJob: async () => ({
        publishedVerified: false,
        acceptedVerified: false,
        publishedHash: null,
      }),
      applyReading: async (_row, reading) => {
        applyAfterDispose += 1;
        return {
          ...reading,
          jobState: null,
          reviewApplied: false,
          publishedHash: null,
          attemptState: null,
          attemptReviewApplied: false,
          attemptAcceptedApplied: false,
        };
      },
      onReading: () => {
        notifyAfterDispose += 1;
      },
    });
    const pending = lateWatch.poll();
    lateWatch.dispose();
    releaseLate();
    await expect(pending).resolves.toBeUndefined();
    expect(applyAfterDispose).toBe(0);
    expect(notifyAfterDispose).toBe(0);

    let appliedThen = 0;
    let notifiedThen = 0;
    const mid = createCompletionWatch({
      threads: idleThreads("thr_mid"),
      listBoundLaunches: () => [{ threadId: "thr_mid", jobId: "job_mid", launchId: "44444444-4444-4444-8444-444444444444" }],
      pollMs: 60_000,
      readPublishedForJob: async () => ({
        publishedVerified: false,
        acceptedVerified: false,
        publishedHash: null,
      }),
      applyReading: async (_row, reading) => {
        appliedThen += 1;
        mid.dispose();
        return {
          ...reading,
          jobState: null,
          reviewApplied: false,
          publishedHash: null,
          attemptState: null,
          attemptReviewApplied: false,
          attemptAcceptedApplied: false,
        };
      },
      onReading: () => {
        notifiedThen += 1;
      },
    });
    await mid.poll();
    expect(appliedThen).toBe(1);
    expect(notifiedThen).toBe(0);
    watch.dispose();
  });
});
