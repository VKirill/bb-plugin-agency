import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyAgencyMigrations, migrations } from "../src/server/db/migrations";
import { openMigratedDatabase, type SqlDatabase } from "../src/server/db";
import { createRepositories } from "../src/server/db/repositories";
import { listJobsForBindings } from "../src/server/api/catalog";
import { createDomainStore, type ServiceContext } from "../src/server/services";
import { formatParentWakeText, PARENT_WAKE_STATES } from "../src/server/runtime/parent-wake/service";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-board-"));
  tempDirs.push(dir);
  return join(dir, "agency.sqlite");
}

function seed(db: SqlDatabase) {
  const store = createDomainStore(db);
  const bootstrap: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [] };
  const policy = store.createPolicyVersion(bootstrap, {
    requestId: randomUUID(),
    allowedCapabilities: ["read.files"],
    cliHostConstraints: { providerIds: ["claude-code"], hostIds: ["host_mini"] },
    secretRefs: [],
  });
  if (!policy.ok) throw new Error(policy.error.message);
  const agent = store.provisionAgent(bootstrap, {
    requestId: randomUUID(),
    name: "Руководитель",
    state: "active",
    version: {
      version: 1,
      role: "lead",
      instructions: "Декомпозировать и проверять.",
      providerId: "claude-code",
      model: "claude-fable-5-1",
      skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
      mcpIds: [],
      policyVersionId: policy.value.id,
    },
  });
  if (!agent.ok) throw new Error(agent.error.message);
  const department = store.provisionDepartment(bootstrap, {
    requestId: randomUUID(),
    name: "Программисты",
    leadAgentId: agent.value.agent.id,
    process: { instructions: "Разработка и проверка.", acceptance: "Принятая версия.", reviewPolicy: { required: true } },
  });
  if (!department.ok) throw new Error(department.error.message);
  const binding = store.createProjectBinding(bootstrap, {
    requestId: randomUUID(),
    bbProjectId: "proj_trusted",
    environmentId: "env_ucx7sb57rs",
    hostId: "host_mini",
    canonicalRoot: "/agency/selfy",
    policyVersionId: policy.value.id,
    sectionId: null,
  });
  if (!binding.ok) throw new Error(binding.error.message);
  const ctx: ServiceContext = { actor: { kind: "user", userId: "user_kirill" }, allowedBindingIds: [binding.value.id] };
  const linked = store.linkDepartment(ctx, {
    requestId: randomUUID(),
    bindingId: binding.value.id,
    departmentId: department.value.department.id,
  });
  if (!linked.ok) throw new Error(linked.error.message);
  return { store, ctx, bindingId: binding.value.id, departmentId: department.value.department.id, agentId: agent.value.agent.id };
}

describe("delegation-friendly createJob", () => {
  it("assigns the next free key and defaults optional placement fields", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const seeded = seed(db);
    const explicit = seeded.store.createJob(seeded.ctx, {
      requestId: randomUUID(),
      key: "AG-9",
      bindingId: seeded.bindingId,
      departmentId: seeded.departmentId,
      title: "Явный ключ",
      brief: "Бриф.",
      acceptance: "Критерий.",
      parentJobId: null,
      assignedAgentId: null,
      priority: "high",
      dueAt: null,
    });
    expect(explicit.ok).toBe(true);
    const minimal = seeded.store.createJob(seeded.ctx, {
      requestId: randomUUID(),
      bindingId: seeded.bindingId,
      departmentId: seeded.departmentId,
      assignedAgentId: seeded.agentId,
      title: "Поручение из чата",
      brief: "Собрать отчёт.",
      acceptance: "Отчёт опубликован версией.",
    } as Parameters<typeof seeded.store.createJob>[1]);
    expect(minimal.ok).toBe(true);
    if (!minimal.ok) return;
    expect(minimal.value).toMatchObject({ key: "AG-10", priority: "normal", dueAt: null, parentJobId: null });
    expect(listJobsForBindings(db, [seeded.bindingId]).map((job) => job.key)).toEqual(["AG-9", "AG-10"]);
    db.close();
  });
});

describe("closed_at", () => {
  it("records when a job closes and clears it when the job reopens", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const seeded = seed(db);
    const created = seeded.store.createJob(seeded.ctx, {
      requestId: randomUUID(),
      bindingId: seeded.bindingId,
      departmentId: seeded.departmentId,
      title: "Отменяемая",
      brief: "Бриф.",
      acceptance: "Критерий.",
    } as Parameters<typeof seeded.store.createJob>[1]);
    if (!created.ok) throw new Error(created.error.message);
    expect(listJobsForBindings(db, [seeded.bindingId])[0]).not.toHaveProperty("closedAt");

    const canceled = seeded.store.transitionJob(seeded.ctx, {
      requestId: randomUUID(),
      expectedRevision: created.value.revision,
      jobId: created.value.id,
      to: "canceled",
    });
    if (!canceled.ok) throw new Error(canceled.error.message);
    const listed = listJobsForBindings(db, [seeded.bindingId])[0];
    expect(listed.closedAt).toBe(canceled.value.updatedAt);

    const repos = createRepositories(db);
    const later = "2099-01-01T00:00:00.000Z";
    repos.job.update({ ...canceled.value, title: "Переименована", revision: canceled.value.revision + 1, updatedAt: later });
    expect(listJobsForBindings(db, [seeded.bindingId])[0].closedAt).toBe(canceled.value.updatedAt);

    repos.job.update({ ...canceled.value, state: "review", revision: canceled.value.revision + 2, updatedAt: later });
    expect(listJobsForBindings(db, [seeded.bindingId])[0]).not.toHaveProperty("closedAt");
    db.close();
  });

  it("backfills closed jobs from the transition journal", () => {
    const path = tempPath();
    const raw = new Database(path);
    const closedMigration = migrations.findIndex((sql) => sql.includes("ADD COLUMN closed_at"));
    applyAgencyMigrations(raw, { throughId: closedMigration - 1 });
    const seeded = seed(raw);
    // Rows as an older plugin wrote them: no closed_at column yet.
    const insertJob = raw.prepare(
      `INSERT INTO agency_job (id, key, binding_id, department_id, title, brief, acceptance, state, parent_job_id,
         assigned_agent_id, priority, due_at, revision, updated_at)
       VALUES (?, ?, ?, ?, 'Старая', 'Бриф.', 'Критерий.', ?, NULL, NULL, 'normal', NULL, 3, '2099-01-01T00:00:00.000Z')`,
    );
    const insertActivity = raw.prepare(
      `INSERT INTO agency_activity (id, job_id, actor, kind, causation_id, timestamp, references_json)
       VALUES (?, ?, '{"kind":"system"}', 'job_transitioned', NULL, ?, ?)`,
    );
    insertJob.run("job_closed0001", "AG-1", seeded.bindingId, seeded.departmentId, "canceled");
    insertActivity.run("act_old00001", "job_closed0001", "2026-09-14T10:00:00.000Z", '[{"type":"job_state","id":"blocked"}]');
    insertActivity.run("act_old00002", "job_closed0001", "2026-09-14T11:00:00.000Z", '[{"type":"job_state","id":"canceled"}]');
    insertJob.run("job_closed0002", "AG-2", seeded.bindingId, seeded.departmentId, "done");
    insertJob.run("job_open000003", "AG-3", seeded.bindingId, seeded.departmentId, "running");

    applyAgencyMigrations(raw);
    const closedAt = (id: string) =>
      (raw.prepare(`SELECT closed_at FROM agency_job WHERE id = ?`).get(id) as { closed_at: string | null }).closed_at;
    expect(closedAt("job_closed0001")).toBe("2026-09-14T11:00:00.000Z");
    expect(closedAt("job_closed0002")).toBe("2099-01-01T00:00:00.000Z");
    expect(closedAt("job_open000003")).toBeNull();
    raw.close();
  });
});

describe("parent wake on closing subtasks", () => {
  it("wakes the lead when a subtask is accepted or canceled, with a next step", () => {
    expect(PARENT_WAKE_STATES.has("done")).toBe(true);
    expect(PARENT_WAKE_STATES.has("canceled")).toBe(true);
    const done = formatParentWakeText({ key: "AG-7", state: "done" }, "act_1");
    expect(done.split("\n")).toEqual([
      "AG-7 → done.",
      "Прочитайте ребёнка getJob. Это не приёмка и не доступ к артефактам.",
      "Подзадача закрыта. Если открытых подзадач не осталось, соберите итог главной задачи.",
      "agency.parentWake:act_1",
    ]);
    expect(formatParentWakeText({ key: "AG-7", state: "review" }, "act_2").split("\n")).toHaveLength(3);
  });
});
