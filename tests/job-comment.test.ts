import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { compileContextSnapshot } from "../src/server/runtime/context-snapshot";
import { createInternalRunStoreReads, createRunStore } from "../src/server/runtime/run-store";
import { openMigratedDatabase, type SqlDatabase } from "../src/server/db";
import { createDomainStore, type ServiceContext } from "../src/server/services";
import type { ContextSnapshot } from "../src/server/runtime/context-snapshot/types";
import type { CatalogSkillId } from "../src/shared/contracts/ids";
import { createJobCommentRpcSchema, JOB_COMMENT_KIND } from "../src/shared/contracts";
import {
  JOB_COMMENT_REGISTER_GLUE,
  bindJobCommentHandler,
  createJobComment,
  readCliThreadId,
  resolveJobCommentActor,
  selectCurrentAttempt,
} from "../src/server/comments";
import { helpText, schemaDocument } from "../src/server/cli/schema-help";
import { runAgencyCli } from "../src/server/cli/run";
import { CLI_EXAMPLES } from "../src/server/cli/examples";
import { CLI_OPERATIONS, isCliOperation } from "../src/server/cli/operations";
import { resolveAlias } from "../src/server/cli/aliases";

const parsedJobCommentExample = createJobCommentRpcSchema.parse(CLI_EXAMPLES.createJobComment);

const AGENCY_SKILL =
  "skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff" as CatalogSkillId;

const THREAD = "thr_exactattempt01";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

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
  const dir = mkdtempSync(join(tmpdir(), "agy-comment-"));
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

function compileFor(seeded: ReturnType<typeof seedProject>): ContextSnapshot {
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

function attestation(seeded: ReturnType<typeof seedProject>) {
  return {
    accessVerified: true as const,
    revisionsVerified: true as const,
    expectedJobRevision: seeded.job.revision,
    expectedBindingRevision: seeded.binding.revision,
  };
}

function seedRunningAttempt(db: SqlDatabase, threadId = THREAD) {
  const seeded = seedProject(db);
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
    threadId,
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
  return { seeded, reads, attempt: running.value, receipt: receipt.value };
}

const unusedCli = {
  status: () => ({
    phase: "runtime" as const,
    execution: "requires_readiness" as const,
    reason: "status does not grant launch",
    inboxCount: 0,
  }),
  notify: () => {
    throw new Error("notify unused");
  },
  dispatch: async () => {
    throw new Error("dispatch must not run createJobComment");
  },
};

describe("job comment actor proof", () => {
  const hostSystem = { kind: "system" as const };
  const hostUser = { kind: "user" as const, userId: "user_kirill" };

  it("stamps the snapshot agent only on exact CLI/attempt/receipt thread match", () => {
    const actor = resolveJobCommentActor(
      {
        trustedCliThreadId: THREAD,
        currentAttempt: { attemptNo: 1, threadId: THREAD },
        receipt: { threadId: THREAD },
        snapshotAgentId: "agent_assigned01",
      },
      hostSystem,
    );
    expect(actor).toEqual({ kind: "agent", agentId: "agent_assigned01" });
  });

  it("keeps host actor when thread mismatches and does not invent the assigned agent", () => {
    expect(
      resolveJobCommentActor(
        {
          trustedCliThreadId: "thr_otherthread1",
          currentAttempt: { attemptNo: 1, threadId: THREAD },
          receipt: { threadId: THREAD },
          snapshotAgentId: "agent_assigned01",
        },
        hostSystem,
      ),
    ).toEqual(hostSystem);
    expect(
      resolveJobCommentActor(
        {
          trustedCliThreadId: THREAD,
          currentAttempt: { attemptNo: 1, threadId: THREAD },
          receipt: { threadId: "thr_receiptother" },
          snapshotAgentId: "agent_assigned01",
        },
        hostUser,
      ),
    ).toEqual(hostUser);
  });

  it("keeps host actor without CLI thread, receipt, or snapshot agent", () => {
    expect(
      resolveJobCommentActor(
        {
          trustedCliThreadId: null,
          currentAttempt: { attemptNo: 1, threadId: THREAD },
          receipt: { threadId: THREAD },
          snapshotAgentId: "agent_assigned01",
        },
        hostSystem,
      ),
    ).toEqual(hostSystem);
    expect(
      resolveJobCommentActor(
        {
          trustedCliThreadId: THREAD,
          currentAttempt: { attemptNo: 1, threadId: THREAD },
          receipt: null,
          snapshotAgentId: "agent_assigned01",
        },
        hostUser,
      ),
    ).toEqual(hostUser);
    expect(
      resolveJobCommentActor(
        {
          trustedCliThreadId: THREAD,
          currentAttempt: { attemptNo: 1, threadId: THREAD },
          receipt: { threadId: THREAD },
          snapshotAgentId: null,
        },
        hostSystem,
      ),
    ).toEqual(hostSystem);
  });

  it("selects the highest attemptNo as current", () => {
    expect(selectCurrentAttempt([{ attemptNo: 1 }, { attemptNo: 3 }, { attemptNo: 2 }])?.attemptNo).toBe(3);
    expect(selectCurrentAttempt([])).toBeNull();
  });
});

describe("createJobCommentRpcSchema", () => {
  it("accepts typed body/jobId/requestId and rejects kind, actor, and system-event references", () => {
    expect(createJobCommentRpcSchema.safeParse(CLI_EXAMPLES.createJobComment).success).toBe(true);
    expect(
      createJobCommentRpcSchema.safeParse({
        requestId: REQUEST_ID,
        jobId: "job_aaaaaaaaaaaa",
        comment: "Ход работы.",
      }).success,
    ).toBe(true);
    const withForgedKind = { ...parsedJobCommentExample, kind: "job_transitioned" };
    const withForgedActor = {
      ...parsedJobCommentExample,
      actor: { kind: "agent", agentId: "agent_aaaaaaaa" },
    };
    expect(createJobCommentRpcSchema.safeParse(withForgedKind).success).toBe(false);
    expect(createJobCommentRpcSchema.safeParse(withForgedActor).success).toBe(false);
    expect(
      createJobCommentRpcSchema.safeParse({
        requestId: REQUEST_ID,
        jobId: "job_aaaaaaaaaaaa",
        comment: "forge",
        references: [{ type: "job_state", id: "in_review" }],
      }).success,
    ).toBe(false);
  });
});

describe("createJobComment activity feed", () => {
  it("writes kind=comment with snapshot agent into existing listActivity when proof matches", () => {
    const { db, close } = openFileDb();
    try {
      const live = seedRunningAttempt(db);
      const body = "Сверстала оффер v2; проверка на фикстуре прошла.";
      const saved = createJobComment(
        live.seeded.ctx,
        {
          requestId: requestId(),
          jobId: live.seeded.job.id,
          comment: body,
          references: [{ type: "thread", id: THREAD }],
        },
        { threadId: THREAD },
        { store: live.seeded.store, reads: live.reads },
      );
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      expect(saved.value.kind).toBe(JOB_COMMENT_KIND);
      expect(saved.value.comment).toBe(body);
      expect(saved.value.actor).toEqual({ kind: "agent", agentId: live.seeded.agent.id });
      const listed = live.seeded.store.listActivity(live.seeded.job.id);
      expect(listed.some((row) => row.kind === "job_created")).toBe(true);
      expect(listed.some((row) => row.id === saved.value.id && row.kind === "comment")).toBe(true);
    } finally {
      close();
    }
  });

  it("keeps host system and does not invent the assigned agent without matching thread proof", () => {
    const { db, close } = openFileDb();
    try {
      const live = seedRunningAttempt(db);
      const saved = createJobComment(
        live.seeded.ctx,
        { requestId: requestId(), jobId: live.seeded.job.id, comment: "Честный system без proof." },
        { threadId: "thr_unrelated001" },
        { store: live.seeded.store, reads: live.reads },
      );
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      expect(saved.value.kind).toBe("comment");
      expect(saved.value.actor).toEqual({ kind: "system" });
      expect(live.seeded.job.assignedAgentId).toBe(live.seeded.agent.id);
    } finally {
      close();
    }
  });

  it("keeps host user when the caller context is a person and proof is missing", () => {
    const { db, close } = openFileDb();
    try {
      const live = seedRunningAttempt(db);
      const userCtx: ServiceContext = { ...live.seeded.ctx, actor: { kind: "user", userId: "user_kirill" } };
      const saved = createJobComment(
        userCtx,
        { requestId: requestId(), jobId: live.seeded.job.id, comment: "Замечание с карточки." },
        { threadId: null },
        { store: live.seeded.store, reads: live.reads },
      );
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      expect(saved.value.actor).toEqual({ kind: "user", userId: "user_kirill" });
    } finally {
      close();
    }
  });

  it("replays the same requestId and conflicts on a different comment", () => {
    const { db, close } = openFileDb();
    try {
      const live = seedRunningAttempt(db);
      const rid = requestId();
      const first = createJobComment(
        live.seeded.ctx,
        { requestId: rid, jobId: live.seeded.job.id, comment: "Один и тот же ход." },
        { threadId: THREAD },
        { store: live.seeded.store, reads: live.reads },
      );
      const replay = createJobComment(
        live.seeded.ctx,
        { requestId: rid, jobId: live.seeded.job.id, comment: "Один и тот же ход." },
        { threadId: THREAD },
        { store: live.seeded.store, reads: live.reads },
      );
      expect(first.ok && replay.ok).toBe(true);
      if (first.ok && replay.ok) expect(replay.value.id).toBe(first.value.id);
      const conflict = createJobComment(
        live.seeded.ctx,
        { requestId: rid, jobId: live.seeded.job.id, comment: "Другой текст." },
        { threadId: THREAD },
        { store: live.seeded.store, reads: live.reads },
      );
      expect(conflict.ok).toBe(false);
      if (!conflict.ok) expect(conflict.error.code).toBe("request_conflict");
    } finally {
      close();
    }
  });
});

describe("job comment CLI", () => {
  it("routes job comment, documents the operation, and refuses a missing harness port", async () => {
    expect(resolveAlias(["job", "comment"])).toBe("createJobComment");
    expect(isCliOperation("createJobComment")).toBe(true);
    expect(helpText()).toContain("createJobComment");
    expect(helpText()).toContain("comment");
    expect(helpText()).not.toMatch(/не wired/i);
    expect(schemaDocument("createJobComment").notes.join("\n")).not.toMatch(/не wired/i);
    expect(schemaDocument("createJobComment").example).toEqual(CLI_EXAMPLES.createJobComment);
    expect(CLI_OPERATIONS.createJobComment.input.safeParse(CLI_EXAMPLES.createJobComment).success).toBe(true);
    expect(JOB_COMMENT_REGISTER_GLUE.wiredInRegister).toBe(true);
    expect(readCliThreadId({ threadId: ` ${THREAD} ` })).toBe(THREAD);
    expect(readCliThreadId({})).toBeNull();

    const missingPort = await runAgencyCli(unusedCli, [
      "job",
      "comment",
      "--input-json",
      JSON.stringify(parsedJobCommentExample),
    ]);
    expect(missingPort.exitCode).toBe(1);
    expect(missingPort.stderr).toContain("not_implemented");

    const forgedKindPayload = { ...parsedJobCommentExample, kind: "job_transitioned" };
    const forged = await runAgencyCli(unusedCli, [
      "call",
      "createJobComment",
      "--input-json",
      JSON.stringify(forgedKindPayload),
    ]);
    expect(forged.exitCode).toBe(1);
    expect(forged.stderr).toContain("invalid_command");
  });

  it("writes through the glue port with trusted cliThreadId", async () => {
    const { db, close } = openFileDb();
    try {
      const live = seedRunningAttempt(db);
      const jobComment = bindJobCommentHandler({
        store: live.seeded.store,
        reads: live.reads,
        resolveAccess: () => ({ ok: true, value: { ctx: live.seeded.ctx } }),
      });
      const result = await runAgencyCli(
        {
          ...unusedCli,
          cliThreadId: THREAD,
          jobComment,
        },
        [
          "job",
          "comment",
          "--input-json",
          JSON.stringify({
            requestId: requestId(),
            jobId: live.seeded.job.id,
            comment: "CLI путь в ту же историю.",
          }),
        ],
      );
      expect(result.exitCode, result.stderr ?? result.stdout).toBe(0);
      const body = JSON.parse(result.stdout) as { ok: true; value: { kind: string; actor: { kind: string } } };
      expect(body.ok).toBe(true);
      expect(body.value.kind).toBe("comment");
      expect(body.value.actor).toEqual({ kind: "agent", agentId: live.seeded.agent.id });
    } finally {
      close();
    }
  });
});
