import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase, type SqlDatabase } from "../src/server/db";
import { createDomainStore, type ServiceContext } from "../src/server/services";

const system: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [] };

function seed(db: SqlDatabase) {
  const store = createDomainStore(db);
  const policy = store.createPolicyVersion(system, {
    requestId: randomUUID(),
    allowedCapabilities: ["read.files"],
    cliHostConstraints: { providerIds: ["claude-code"], hostIds: ["host_mini"] },
    secretRefs: [],
  });
  if (!policy.ok) throw new Error(policy.error.message);
  const agent = store.provisionAgent(system, {
    requestId: randomUUID(),
    name: "Руководитель",
    state: "active",
    version: {
      version: 1,
      role: "lead",
      instructions: "Оркестрирует.",
      providerId: "claude-code",
      model: "claude-fable-5-1",
      skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
      mcpIds: [],
      policyVersionId: policy.value.id,
    },
  });
  if (!agent.ok) throw new Error(agent.error.message);
  const department = store.provisionDepartment(system, {
    requestId: randomUUID(),
    name: "Программисты",
    leadAgentId: agent.value.agent.id,
    process: { instructions: "## Принимаем\n- Код", acceptance: "Принято.", reviewPolicy: { required: false } },
  });
  if (!department.ok) throw new Error(department.error.message);
  const bind = (root: string, environmentId = "env_ucx7sb57rs") => {
    const binding = store.createProjectBinding(system, {
      requestId: randomUUID(),
      bbProjectId: "proj_trusted",
      environmentId,
      hostId: "host_mini",
      canonicalRoot: root,
      policyVersionId: policy.value.id,
      sectionId: null,
    });
    if (!binding.ok) throw new Error(binding.error.message);
    return binding.value;
  };
  const main = bind("/work/site");
  const spare = bind("/work/spare", "env_spare0001");
  const ctx: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [main.id, spare.id] };
  return { store, ctx, policy: policy.value, agentId: agent.value.agent.id, department: department.value.department, main, spare, bind };
}

function job(seeded: ReturnType<typeof seed>, bindingId: string, departmentId = seeded.department.id) {
  return seeded.store.createJob(seeded.ctx, {
    requestId: randomUUID(),
    bindingId,
    departmentId,
    assignedAgentId: seeded.agentId,
    title: "Поручение",
    brief: "Бриф.",
    acceptance: "Критерий.",
  } as Parameters<typeof seeded.store.createJob>[1]);
}

describe("departments open to all projects", () => {
  it("take jobs in any connected project without a link, and a restricted one only where linked", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const seeded = seed(db);
    expect(seeded.department).not.toHaveProperty("availability");
    expect(job(seeded, seeded.main.id).ok).toBe(true);

    const restricted = seeded.store.setDepartmentAvailability(seeded.ctx, {
      requestId: randomUUID(),
      expectedRevision: seeded.department.revision,
      departmentId: seeded.department.id,
      availability: "selected",
    });
    expect(restricted).toMatchObject({ ok: false, error: { code: "department_in_use" } });

    const linked = seeded.store.linkDepartment(seeded.ctx, {
      requestId: randomUUID(),
      bindingId: seeded.main.id,
      departmentId: seeded.department.id,
    });
    expect(linked.ok).toBe(true);
    const nowRestricted = seeded.store.setDepartmentAvailability(seeded.ctx, {
      requestId: randomUUID(),
      expectedRevision: seeded.department.revision,
      departmentId: seeded.department.id,
      availability: "selected",
    });
    expect(nowRestricted).toMatchObject({ ok: true, value: { availability: "selected", revision: seeded.department.revision + 1 } });
    expect(job(seeded, seeded.spare.id)).toMatchObject({ ok: false, error: { code: "department_not_on_binding" } });
    expect(job(seeded, seeded.main.id).ok).toBe(true);

    const unlink = seeded.store.unlinkDepartment(seeded.ctx, {
      requestId: randomUUID(),
      bindingId: seeded.main.id,
      departmentId: seeded.department.id,
    });
    expect(unlink).toMatchObject({ ok: false, error: { code: "department_in_use" } });
    db.close();
  });
});

describe("project connection lifecycle", () => {
  it("disconnects a project with history, stops new jobs and links, and reconnects it", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const seeded = seed(db);
    expect(job(seeded, seeded.main.id).ok).toBe(true);

    const archived = seeded.store.archiveProjectBinding(seeded.ctx, {
      requestId: randomUUID(),
      expectedRevision: seeded.main.revision,
      bindingId: seeded.main.id,
    });
    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    expect(archived.value.archivedAt).toBeTruthy();
    expect(job(seeded, seeded.main.id)).toMatchObject({ ok: false, error: { code: "binding_archived" } });
    expect(
      seeded.store.linkDepartment(seeded.ctx, { requestId: randomUUID(), bindingId: seeded.main.id, departmentId: seeded.department.id }),
    ).toMatchObject({ ok: false, error: { code: "binding_archived" } });
    expect(
      seeded.store.deleteProjectBinding(seeded.ctx, {
        requestId: randomUUID(),
        expectedRevision: archived.value.revision,
        bindingId: seeded.main.id,
      }),
    ).toMatchObject({ ok: false, error: { code: "binding_in_use" } });

    // The same folder can be connected again while the old connection stays archived.
    const again = seeded.bind("/work/site");
    expect(again.id).not.toBe(seeded.main.id);
    expect(
      seeded.store.restoreProjectBinding(seeded.ctx, {
        requestId: randomUUID(),
        expectedRevision: archived.value.revision,
        bindingId: seeded.main.id,
      }),
    ).toMatchObject({ ok: false, error: { code: "binding_duplicate" } });
    db.close();
  });

  it("deletes an unused connection and refuses a duplicate of an active one", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const seeded = seed(db);
    expect(() => seeded.bind("/work/spare", "env_spare0001")).toThrow(/already connected/);
    const deleted = seeded.store.deleteProjectBinding(seeded.ctx, {
      requestId: randomUUID(),
      expectedRevision: seeded.spare.revision,
      bindingId: seeded.spare.id,
    });
    expect(deleted).toEqual({ ok: true, value: { bindingId: seeded.spare.id } });
    expect(seeded.store.getBinding(seeded.spare.id)).toBeUndefined();
    expect(seeded.bind("/work/spare", "env_spare0001").id).not.toBe(seeded.spare.id);
    db.close();
  });
});
