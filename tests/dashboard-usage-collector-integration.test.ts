import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachDashboardUsageCollector,
  createAttemptBoundThreadPort,
  createDashboardUsageRpc,
  listBoundAttemptThreadIds,
  startUsageCollectorCapture,
} from "../src/server/api/dashboard-usage-rpc";
import { compileContextSnapshot } from "../src/server/runtime/context-snapshot";
import type { ContextSnapshot } from "../src/server/runtime/context-snapshot/types";
import { createRunStore } from "../src/server/runtime/run-store";
import { typedUsageEvent } from "../src/server/runtime/usage-collector";
import { migrations, openMigratedDatabase, type SqlDatabase } from "../src/server/db";
import { USAGE_COLLECTOR_MIGRATION } from "../src/server/runtime/usage-collector/migration";
import { createDomainStore, type ServiceContext } from "../src/server/services";
import type { CatalogSkillId } from "../src/shared/contracts/ids";
import type { Job } from "../src/shared/contracts/job";

const here = dirname(fileURLToPath(import.meta.url));
const fableEvents = JSON.parse(
  readFileSync(join(here, "fixtures/dashboard-usage/fable-usage-observed.json"), "utf8"),
) as unknown[];
const FABLE_THREAD = "thr_uu5jukubj5";
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

function openFileDb() {
  const dir = mkdtempSync(join(tmpdir(), "agy-usage-int-"));
  tempDirs.push(dir);
  const db = openMigratedDatabase(new Database(join(dir, "agency.sqlite")));
  return { db, close: () => db.close() };
}

function seedProject(db: SqlDatabase) {
  const store = createDomainStore(db);
  const bootstrap: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [] };
  const policy = store.createPolicyVersion(bootstrap, {
    requestId: requestId(),
    allowedCapabilities: ["read.files"],
    cliHostConstraints: { providerIds: ["claude-code"], hostIds: ["host_mini"] },
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
      providerId: "claude-code",
      model: "claude-sonnet-4-6",
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
  const ctx: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [binding.value.id] };
  const linked = store.linkDepartment(ctx, {
    requestId: requestId(),
    bindingId: binding.value.id,
    departmentId: department.value.department.id,
  });
  if (!linked.ok) throw new Error(linked.error.message);
  const job = store.createJob(ctx, {
    requestId: requestId(),
    key: "AG-401",
    bindingId: binding.value.id,
    departmentId: department.value.department.id,
    title: "Корень",
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

function compileFor(seeded: ReturnType<typeof seedProject>, job = seeded.job): ContextSnapshot {
  const result = compileContextSnapshot({
    binding: seeded.binding,
    job,
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

function bindAttempt(db: SqlDatabase, seeded: ReturnType<typeof seedProject>, job: Job, threadId: string) {
  const snapshot = compileFor(seeded, job);
  const runs = createRunStore(db);
  const reserved = runs.reservePreparedRun(seeded.ctx, {
    requestId: requestId(),
    snapshot,
    attestation: {
      accessVerified: true,
      revisionsVerified: true,
      expectedJobRevision: job.revision,
      expectedBindingRevision: seeded.binding.revision,
    },
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
    threadId,
  });
  if (!running.ok) throw new Error(running.error.message);
  return running.value;
}

function liveEvents(byThread: Record<string, unknown[] | "unavailable" | "throw">) {
  return {
    async list(input: { threadId: string }) {
      const rows = byThread[input.threadId];
      if (rows === "throw") throw new Error("private-provider-detail");
      if (rows === "unavailable" || rows === undefined) return [];
      return rows as Awaited<ReturnType<Parameters<typeof createDashboardUsageRpc>[0]["events"]["list"]>>;
    },
  };
}

describe("dashboard usage collector integration", () => {
  it("appends the collector migration without rewriting earlier statements", () => {
    expect(migrations.at(-1)).toBe(USAGE_COLLECTOR_MIGRATION);
    const { db, close } = openFileDb();
    try {
      const row = db.prepare(`SELECT count(*) AS n FROM agency_usage_event`).get() as { n: number };
      expect(row.n).toBe(0);
    } finally {
      close();
    }
  });

  it("lists attempt-bound threads and rejects unbound ids", () => {
    const { db, close } = openFileDb();
    try {
      const seeded = seedProject(db);
      bindAttempt(db, seeded, seeded.job, FABLE_THREAD);
      expect(listBoundAttemptThreadIds(db)).toEqual([FABLE_THREAD]);
      const bound = createAttemptBoundThreadPort(db);
      expect(bound.isBound(FABLE_THREAD)).toBe(true);
      expect(bound.isBound("thr_other")).toBe(false);
    } finally {
      close();
    }
  });

  it("unions durable typed facts over live and keeps saved rows when live fails", async () => {
    const { db, close } = openFileDb();
    try {
      const seeded = seedProject(db);
      bindAttempt(db, seeded, seeded.job, FABLE_THREAD);
      const state: Record<string, unknown[] | "unavailable" | "throw"> = { [FABLE_THREAD]: fableEvents };
      const rpc = createDashboardUsageRpc({ db, events: liveEvents(state) });

      const liveFirst = await rpc.listDashboardUsage({ rootJobId: seeded.job.id });
      expect(liveFirst.ok).toBe(true);
      if (!liveFirst.ok) return;
      expect(liveFirst.value.totals?.totalTokens).toBe(6_697_149);

      const captured = await rpc.collector.capture(listBoundAttemptThreadIds(db));
      expect(captured).toMatchObject({ inserted: 6, duplicate: 0, unbound: 0, liveUnavailable: 0 });
      expect(rpc.collector.store.count(FABLE_THREAD)).toBe(6);

      const mutated = structuredClone(fableEvents) as Array<{
        id: string;
        data: { tokenUsage: { total: { totalTokens: number } } };
      }>;
      const last = mutated.find((row) => row.id === "evt_zdpnwdvxsr");
      if (last) last.data.tokenUsage.total.totalTokens = 1;
      state[FABLE_THREAD] = mutated;

      const unioned = await rpc.listDashboardUsage({ rootJobId: seeded.job.id });
      expect(unioned.ok).toBe(true);
      if (!unioned.ok) return;
      expect(unioned.value.totals?.totalTokens).toBe(6_697_149);
      expect(unioned.value.rows[0]?.sessionLatestTotal?.totalTokens).toBe(968_858);

      state[FABLE_THREAD] = "throw";
      const afterFail = await rpc.listDashboardUsage({ rootJobId: seeded.job.id });
      expect(afterFail.ok).toBe(true);
      if (!afterFail.ok) return;
      expect(afterFail.value.totals?.totalTokens).toBe(6_697_149);
      expect(rpc.collector.store.count(FABLE_THREAD)).toBe(6);
      expect(rpc.collector.store.listCaptured(FABLE_THREAD).find((row) => row.seq === 610)?.total.totalTokens).toBe(
        968_858,
      );
    } finally {
      close();
    }
  });

  it("does not expose unbound store rows through the union port", async () => {
    const { db, close } = openFileDb();
    try {
      seedProject(db);
      const rpc = createDashboardUsageRpc({
        db,
        events: liveEvents({ thr_other: fableEvents }),
      });
      expect(createAttemptBoundThreadPort(db).isBound("thr_other")).toBe(false);
      await expect(rpc.collector.events.listUpdated("thr_other")).resolves.toEqual([]);
    } finally {
      close();
    }
  });

  it("skips an overlapping poll tick and stops after dispose", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const poll = startUsageCollectorCapture({
      intervalMs: 60_000,
      schedule: () => () => undefined,
      listThreadIds: () => [FABLE_THREAD],
      capture: async () => {
        started += 1;
        await gate;
      },
    });
    await Promise.resolve();
    expect(started).toBe(1);
    expect(poll.busy()).toBe(true);
    await poll.tick();
    expect(started).toBe(1);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(poll.busy()).toBe(false);
    await poll.tick();
    expect(started).toBe(2);
    poll.dispose();
    await poll.tick();
    expect(started).toBe(2);
  });

  it("does not reject a poll tick when capture throws", async () => {
    const poll = startUsageCollectorCapture({
      schedule: () => () => undefined,
      listThreadIds: () => [FABLE_THREAD],
      capture: async () => {
        throw new Error("private-provider-detail");
      },
    });
    await expect(poll.tick()).resolves.toBeUndefined();
    poll.dispose();
  });

  it("publishes usage-changed after insert and not on duplicate replay", async () => {
    const { db, close } = openFileDb();
    try {
      const seeded = seedProject(db);
      bindAttempt(db, seeded, seeded.job, FABLE_THREAD);
      let published = 0;
      const attached = attachDashboardUsageCollector({
        db,
        events: liveEvents({ [FABLE_THREAD]: fableEvents }),
        onUsageChanged: () => {
          published += 1;
        },
      });
      const started = Date.now();
      while (attached.poll.busy() && Date.now() - started < 2_000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(attached.collector.store.count(FABLE_THREAD)).toBe(6);
      expect(published).toBe(1);
      await attached.poll.tick();
      expect(published).toBe(1);
      attached.dispose();
    } finally {
      close();
    }
  });

  it("does not ingest after poll dispose unblocks a live await", async () => {
    const { db, close } = openFileDb();
    try {
      const seeded = seedProject(db);
      bindAttempt(db, seeded, seeded.job, FABLE_THREAD);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const rpc = createDashboardUsageRpc({
        db,
        events: {
          async list() {
            await gate;
            return fableEvents as never;
          },
        },
      });
      const poll = startUsageCollectorCapture({
        schedule: () => () => undefined,
        listThreadIds: () => listBoundAttemptThreadIds(db),
        capture: (threadIds, shouldContinue) => rpc.collector.capture(threadIds, { shouldContinue }),
      });
      await Promise.resolve();
      poll.dispose();
      release();
      const settled = Date.now();
      while (poll.busy() && Date.now() - settled < 2_000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(poll.shouldContinue()).toBe(false);
      expect(rpc.collector.store.count(FABLE_THREAD)).toBe(0);
    } finally {
      close();
    }
  });
});
