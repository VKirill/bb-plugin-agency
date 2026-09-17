import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrations } from "../src/server/db/migrations";
import { openMigratedDatabase, type SqlDatabase } from "../src/server/db";
import { createDomainStore, type ServiceContext } from "../src/server/services";
import { createMembershipCommandSchema } from "../src/shared/contracts";

export function seed(db: SqlDatabase) {
  const store = createDomainStore(db);
  const bootstrap: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [] };
  const policy = store.createPolicyVersion(bootstrap, {
    requestId: randomUUID(),
    allowedCapabilities: ["read.files"],
    cliHostConstraints: { providerIds: ["claude-code"], hostIds: ["host_mini"] },
    secretRefs: [],
  });
  if (!policy.ok) throw new Error(policy.error.message);
  const agent = (name: string) => {
    const created = store.provisionAgent(bootstrap, {
      requestId: randomUUID(),
      name,
      state: "active",
      version: {
        version: 1,
        role: name,
        instructions: "Работать по процессу отдела.",
        providerId: "claude-code",
        model: "claude-sonnet-5",
        skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
        mcpIds: [],
        policyVersionId: policy.value.id,
      },
    });
    if (!created.ok) throw new Error(created.error.message);
    return created.value.agent.id;
  };
  const lead = agent("Руководитель");
  const developer = agent("Разработчик");
  const reviewer = agent("Проверяющий");
  const department = store.provisionDepartment(bootstrap, {
    requestId: randomUUID(),
    name: "Разработка",
    leadAgentId: lead,
    process: { instructions: "## Принимаем\n- Код", acceptance: "Версия.", reviewPolicy: { required: true } },
  });
  if (!department.ok) throw new Error(department.error.message);
  const departmentId = department.value.department.id;
  for (const [agentId, role] of [[developer, "executor"], [reviewer, "reviewer"]] as const) {
    const added = store.addMembership(bootstrap, { requestId: randomUUID(), departmentId, agentId, role });
    if (!added.ok) throw new Error(added.error.message);
  }
  const binding = store.createProjectBinding(bootstrap, {
    requestId: randomUUID(),
    bbProjectId: "proj_bound",
    environmentId: "env_ucx7sb57rs",
    hostId: "host_mini",
    canonicalRoot: "/work",
    policyVersionId: policy.value.id,
    sectionId: null,
  });
  if (!binding.ok) throw new Error(binding.error.message);
  const ctx: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [binding.value.id] };
  const job = (title: string, assignedAgentId: string) => {
    const created = store.createJob(ctx, {
      requestId: randomUUID(),
      bindingId: binding.value.id,
      departmentId,
      title,
      brief: "Бриф.",
      acceptance: "Критерий.",
      parentJobId: null,
      assignedAgentId,
      priority: "normal",
      dueAt: null,
    });
    if (!created.ok) throw new Error(created.error.message);
    return created.value;
  };
  let artifactNo = 0;
  const input = (targetJobId: string, sourceJobId: string) => {
    artifactNo += 1;
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO agency_job_input_ref (target_job_id, source_job_id, artifact_id, version, hash, host_id, relative_path, accepted, created_at)
       VALUES (?, ?, ?, 1, ?, 'host_mini', 'report.md', 0, '2026-09-16T00:00:00.000Z')`,
    ).run(targetJobId, sourceJobId, `art_${artifactNo}`, "ab".repeat(32));
    db.pragma("foreign_keys = ON");
  };
  const attempt = (jobId: string, state: string) => {
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO agency_run_attempt (id, job_id, attempt_no, snapshot_id, digest, thread_id, launch_id, state, revision, created_at, updated_at)
       VALUES (?, ?, 1, 'snp_fixture', 'digest', 'thr_fixture01', '6f7c2a9e-1d3b-4f5a-8c2e-9b0a1d2c3e4f', ?, 1, '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z')`,
    ).run(`run_${jobId}`, jobId, state);
    db.pragma("foreign_keys = ON");
  };
  return { store, ctx, bootstrap, departmentId, lead, developer, reviewer, job, input, attempt };
}

describe("role types in a department", () => {
  it("reads old member payloads as executor and stores only the three types", () => {
    const parsed = createMembershipCommandSchema.parse({
      requestId: randomUUID(),
      departmentId: "dep_abcd1234",
      agentId: "agt_writer01",
      role: "member",
    });
    expect(parsed.role).toBe("executor");
    expect(createMembershipCommandSchema.safeParse({ ...parsed, role: "observer" }).success).toBe(false);
  });

  it("rebuilds the membership table with member renamed to executor", () => {
    const index = migrations.findIndex((sql) => sql.includes("agency_membership_next"));
    expect(index).toBeGreaterThan(0);
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE agency_department (id TEXT PRIMARY KEY); CREATE TABLE agency_agent (id TEXT PRIMARY KEY);
      INSERT INTO agency_department VALUES ('dep_1'); INSERT INTO agency_agent VALUES ('agt_1'), ('agt_2');
      CREATE TABLE agency_membership (department_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('member', 'lead')), PRIMARY KEY (department_id, agent_id));
      INSERT INTO agency_membership VALUES ('dep_1', 'agt_1', 'lead'), ('dep_1', 'agt_2', 'member');`);
    db.exec(migrations[index]!);
    expect(db.prepare(`SELECT agent_id, role FROM agency_membership ORDER BY agent_id`).all()).toEqual([
      { agent_id: "agt_1", role: "lead" },
      { agent_id: "agt_2", role: "executor" },
    ]);
    expect(() => db.prepare(`INSERT INTO agency_membership VALUES ('dep_1', 'agt_3', 'member')`).run()).toThrow();
    db.close();
  });

  it("lets a reviewer check someone else's work and their own earlier conclusion", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const implementation = s.job("Реализация", s.developer);
    const review = s.job("Проверка", s.reviewer);
    s.input(review.id, implementation.id);
    expect(s.store.assertNotSelfReview(review, [implementation.id]).ok).toBe(true);
    const recheck = s.job("Повторная проверка", s.reviewer);
    expect(s.store.assertNotSelfReview(recheck, [implementation.id, review.id]).ok).toBe(true);
    db.close();
  });

  it("refuses a reviewer checking work they did themselves", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const ownWork = s.job("Реализация не тому", s.reviewer);
    const review = s.job("Проверка", s.reviewer);
    const blocked = s.store.assertNotSelfReview(review, [ownWork.id]);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("self_review");
    // An executor on the same inputs is not a review at all.
    expect(s.store.assertNotSelfReview({ ...review, assignedAgentId: s.developer }, [ownWork.id]).ok).toBe(true);
    db.close();
  });

  it("refuses reassigning a check to the reviewer whose work it holds", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const ownWork = s.job("Реализация", s.reviewer);
    const check = s.job("Проверка", s.developer);
    s.input(check.id, ownWork.id);
    const moved = s.store.updateJob(s.ctx, {
      requestId: randomUUID(),
      jobId: check.id,
      expectedRevision: check.revision,
      assignedAgentId: s.reviewer,
    });
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.error.code).toBe("self_review");
    db.close();
  });
});
