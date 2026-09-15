import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { compileContextSnapshot } from "../src/server/runtime/context-snapshot";
import type { ContextSnapshot } from "../src/server/runtime/context-snapshot/types";
import {
  collectJobSubtree,
  createDashboardUsageReader,
  dashboardUsageCatalogFromSql,
  foldClaudeThreadUsage,
  hasProvenUsageSemantics,
} from "../src/server/runtime/dashboard-usage";
import { createInternalRunStoreReads, createRunStore } from "../src/server/runtime/run-store";
import { openMigratedDatabase, type SqlDatabase } from "../src/server/db";
import { createDomainStore, type ServiceContext } from "../src/server/services";
import type { CatalogSkillId } from "../src/shared/contracts/ids";
import type { Job } from "../src/shared/contracts/job";
import { listDashboardUsageOutputSchema } from "../src/shared/contracts/dashboard-usage";

const here = dirname(fileURLToPath(import.meta.url));
const fableEvents = JSON.parse(
  readFileSync(join(here, "fixtures/dashboard-usage/fable-usage-observed.json"), "utf8"),
) as unknown[];
const chainObserved = JSON.parse(
  readFileSync(join(here, "fixtures/dashboard-usage/chain-usage-observed.json"), "utf8"),
) as Record<string, unknown[]>;

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
  const dir = mkdtempSync(join(tmpdir(), "agy-usage-"));
  tempDirs.push(dir);
  const db = openMigratedDatabase(new Database(join(dir, "agency.sqlite")));
  return { db, close: () => db.close() };
}

function fakeJob(id: string, parentJobId: string | null, key: Job["key"]): Job {
  return {
    id,
    key,
    bindingId: "bnd_aaaaaaaa",
    departmentId: "dep_aaaaaaaa",
    title: key,
    brief: "brief",
    acceptance: "ok",
    state: "backlog",
    parentJobId,
    assignedAgentId: null,
    reviewerAgentIds: [],
    observerAgentIds: [],
    priority: "normal",
    dueAt: null,
    revision: 1,
    updatedAt: "2026-09-14T00:00:00.000Z",
  };
}

function seedProject(db: SqlDatabase, providerId = "claude-code") {
  const store = createDomainStore(db);
  const bootstrap: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [] };
  const policy = store.createPolicyVersion(bootstrap, {
    requestId: requestId(),
    allowedCapabilities: ["read.files"],
    cliHostConstraints: { providerIds: [providerId], hostIds: ["host_mini"] },
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
      providerId,
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
    key: "AG-301",
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

function attestation(seeded: ReturnType<typeof seedProject>, job = seeded.job) {
  return {
    accessVerified: true as const,
    revisionsVerified: true as const,
    expectedJobRevision: job.revision,
    expectedBindingRevision: seeded.binding.revision,
  };
}

function bindAttempt(db: SqlDatabase, seeded: ReturnType<typeof seedProject>, job: Job, threadId: string | null) {
  const snapshot = compileFor(seeded, job);
  const runs = createRunStore(db);
  const reserved = runs.reservePreparedRun(seeded.ctx, {
    requestId: requestId(),
    snapshot,
    attestation: attestation(seeded, job),
  });
  if (!reserved.ok) throw new Error(reserved.error.message);
  if (!threadId) return reserved.value.attempt;
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

describe("dashboard usage fold", () => {
  it("sums visible epoch peaks, not latest total; days only after unique thread + last proof", () => {
    const fold = foldClaudeThreadUsage(fableEvents);
    expect(fold.unknown).toBe(false);
    if (fold.unknown) return;
    expect(fold.epochCount).toBe(2);
    expect(fold.peaks.totalTokens).toBe(6_697_149);
    expect(fold.sessionLatestTotal.totalTokens).toBe(968_858);
    expect(fold.sessionLatestTotal.inputTokens).toBe(132);
    expect(fold.sessionLatestTotal.cachedInputTokens).toBe(966_855);
    expect(fold.reasons).toContain("epoch_reset");
    expect(fold.reasons).toContain("prefix_pruned");
    expect(fold.days).toHaveLength(4);
    expect(fold.days.reduce((sum, day) => sum + day.totalTokens, 0)).toBe(2_549_105);
    expect(fold.days.reduce((sum, day) => sum + day.totalTokens, 0)).not.toBe(fold.peaks.totalTokens);
  });

  it("treats empty events as unknown and single retained total as incomplete lower bound", () => {
    expect(foldClaudeThreadUsage([]).unknown).toBe(true);
    const child = foldClaudeThreadUsage(chainObserved.thr_9erjutvnvd);
    expect(child.unknown).toBe(false);
    if (child.unknown) return;
    expect(child.peaks.totalTokens).toBe(2_797_751);
    expect(child.sessionLatestTotal.totalTokens).toBe(2_797_751);
    expect(child.days).toEqual([]);
    expect(child.reasons).toContain("single_snapshot");
  });

  it("smokes calculator chain: empty Cursor unknown; sum of peaks is not latest-root", () => {
    expect(foldClaudeThreadUsage(chainObserved.thr_4nwum7332u).unknown).toBe(true);
    const root = foldClaudeThreadUsage(chainObserved.thr_uu5jukubj5);
    expect(root.unknown).toBe(false);
    if (root.unknown) return;
    const known = [
      root.peaks.totalTokens,
      foldClaudeThreadUsage(chainObserved.thr_9erjutvnvd),
      foldClaudeThreadUsage(chainObserved.thr_prjxsh88y2),
      foldClaudeThreadUsage(chainObserved.thr_f5224efmvs),
      foldClaudeThreadUsage(chainObserved.thr_w583shecbg),
    ].map((item) => (typeof item === "number" ? item : item.unknown ? 0 : item.peaks.totalTokens));
    expect(known.reduce((sum, value) => sum + value, 0)).toBe(24_948_508);
    expect(hasProvenUsageSemantics("claude-code")).toBe(true);
    expect(hasProvenUsageSemantics("codex")).toBe(false);
  });

  it("keeps malformed in reasons when at least one event is valid", () => {
    const fold = foldClaudeThreadUsage([...fableEvents, { id: "evt_bad", seq: 999 }]);
    expect(fold.unknown).toBe(false);
    if (fold.unknown) return;
    expect(fold.peaks.totalTokens).toBe(6_697_149);
    expect(fold.reasons).toContain("malformed");
  });
});

describe("dashboard usage subtree", () => {
  it("walks parentJobId with visited and does not hang on a cycle", () => {
    const root = fakeJob("job_rootaaaa", null, "AG-1");
    const child = fakeJob("job_childaaa", "job_rootaaaa", "AG-2");
    const loop = fakeJob("job_loopaaaa", "job_cycleaaa", "AG-3");
    const cycle = fakeJob("job_cycleaaa", "job_loopaaaa", "AG-4");
    const outsider = fakeJob("job_outsidea", null, "AG-5");
    const tree = collectJobSubtree([root, child, loop, cycle, outsider], "job_rootaaaa");
    expect(tree.map((job) => job.id)).toEqual(["job_rootaaaa", "job_childaaa"]);
    const cycled = collectJobSubtree([loop, cycle], "job_loopaaaa");
    expect(cycled.map((job) => job.id).sort()).toEqual(["job_cycleaaa", "job_loopaaaa"]);
    const mixed = collectJobSubtree([root, child, loop, cycle, outsider], undefined);
    expect(mixed.map((job) => job.id).sort()).toEqual([
      "job_childaaa",
      "job_cycleaaa",
      "job_loopaaaa",
      "job_outsidea",
      "job_rootaaaa",
    ]);
  });
});

describe("dashboard usage reader", () => {
  it("dedups threadId before days, keeps totals all-time when period hides days, labels snapshot model", async () => {
    const { db, close } = openFileDb();
    try {
      const seeded = seedProject(db);
      const child = seeded.store.createJob(seeded.ctx, {
        requestId: requestId(),
        key: "AG-302",
        bindingId: seeded.binding.id,
        departmentId: seeded.department.id,
        title: "Потомок",
        brief: "Дочерняя.",
        acceptance: "Текст принят.",
        parentJobId: seeded.job.id,
        assignedAgentId: seeded.agent.id,
        priority: "normal",
        dueAt: null,
      });
      if (!child.ok) throw new Error(child.error.message);
      const outsider = seeded.store.createJob(seeded.ctx, {
        requestId: requestId(),
        key: "AG-303",
        bindingId: seeded.binding.id,
        departmentId: seeded.department.id,
        title: "Чужая",
        brief: "Не в дереве.",
        acceptance: "Текст принят.",
        parentJobId: null,
        assignedAgentId: seeded.agent.id,
        priority: "normal",
        dueAt: null,
      });
      if (!outsider.ok) throw new Error(outsider.error.message);
      const pending = seeded.store.createJob(seeded.ctx, {
        requestId: requestId(),
        key: "AG-304",
        bindingId: seeded.binding.id,
        departmentId: seeded.department.id,
        title: "Без треда",
        brief: "Ещё не запущена.",
        acceptance: "Текст принят.",
        parentJobId: seeded.job.id,
        assignedAgentId: seeded.agent.id,
        priority: "normal",
        dueAt: null,
      });
      if (!pending.ok) throw new Error(pending.error.message);
      bindAttempt(db, seeded, seeded.job, "thr_shared001");
      bindAttempt(db, seeded, child.value, "thr_shared001");
      bindAttempt(db, seeded, outsider.value, "thr_outsider1");
      bindAttempt(db, seeded, pending.value, null);

      const reader = createDashboardUsageReader({
        reads: createInternalRunStoreReads(db),
        catalog: dashboardUsageCatalogFromSql(db),
        events: {
          async listUpdated(threadId) {
            if (threadId === "thr_shared001") return fableEvents;
            if (threadId === "thr_outsider1") return [];
            return "unavailable";
          },
        },
      });

      const listed = await reader.listDashboardUsage(seeded.ctx, { rootJobId: seeded.job.id });
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const parsed = listDashboardUsageOutputSchema.parse(listed.value);
      expect(parsed.grain).toBe("visible_epoch_peaks");
      expect(parsed.allTime.grain).toBe("visible_epoch_peaks");
      expect(parsed.allTime.incomplete).toBe(true);
      expect(parsed.period.grain).toBe("epoch_proven_day_deltas");
      expect(parsed.period.available).toBe(true);
      expect(parsed.coverage.resetObserved).toBe(true);
      expect(parsed.totals?.totalTokens).toBe(6_697_149);
      expect(parsed.allTime.totals?.totalTokens).toBe(6_697_149);
      expect(parsed.coverage.uniqueThreadCount).toBe(1);
      expect(parsed.coverage.jobCount).toBe(3);
      expect(parsed.coverage.attemptsWithoutThread).toBe(1);
      expect(parsed.coverage.threadsUnknown).toBe(0);
      expect(parsed.coverage.lifetimeIncomplete).toBe(true);
      expect(parsed.coverage.dayChart).toBe("partial");
      expect(parsed.days.every((day) => day.threadId === "thr_shared001")).toBe(true);
      expect(parsed.days[0]?.modelSource).toBe("snapshot");
      expect(parsed.days[0]?.model).toBe("claude-sonnet-4-6");
      expect(parsed.rows.every((row) => row.modelSource === "snapshot")).toBe(true);
      expect(parsed.rows.some((row) => row.threadId === "thr_outsider1")).toBe(false);
      expect(parsed.costUsdCents).toBeNull();

      const windowed = await reader.listDashboardUsage(seeded.ctx, {
        rootJobId: seeded.job.id,
        fromDate: "1999-01-01",
        toDate: "1999-01-02",
      });
      expect(windowed.ok).toBe(true);
      if (!windowed.ok) return;
      expect(windowed.value.totals?.totalTokens).toBe(6_697_149);
      expect(windowed.value.days).toEqual([]);
      expect(windowed.value.coverage.dayChart).toBe("omitted");
    } finally {
      close();
    }
  });

  it("does not invent Claude totals for unsupported provider even when events exist", async () => {
    const { db, close } = openFileDb();
    try {
      const seeded = seedProject(db, "codex");
      bindAttempt(db, seeded, seeded.job, "thr_codex0001");
      const reader = createDashboardUsageReader({
        reads: createInternalRunStoreReads(db),
        catalog: dashboardUsageCatalogFromSql(db),
        events: { listUpdated: async () => fableEvents },
      });
      const listed = await reader.listDashboardUsage(seeded.ctx, {});
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.totals).toBeNull();
      expect(listed.value.rows[0]?.units).toEqual({ unknown: true, reason: "unsupported_usage_semantics" });
      expect(listed.value.rows[0]?.model).toBe("claude-sonnet-4-6");
      expect(listed.value.rows[0]?.modelSource).toBe("snapshot");
      expect(listed.value.days).toEqual([]);
    } finally {
      close();
    }
  });
});
