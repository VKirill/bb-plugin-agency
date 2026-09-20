import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { ASSISTANTS_PER_EMPLOYEE, assertAssistantLimits } from "../src/domain/membership";
import type { Membership } from "../src/shared/contracts";
import { seed } from "./role-types.test";

const member = (agentId: string, role: Membership["role"], helpsAgentId: string | null = null): Membership => ({
  departmentId: "dep_1",
  agentId,
  role,
  helpsAgentId,
});

describe("assistants in a department", () => {
  it("helps a member of the same department and nobody else", () => {
    const rows = [member("agt_lead", "lead"), member("agt_coder", "executor")];
    expect(assertAssistantLimits(member("agt_help", "assistant", "agt_coder"), [...rows, member("agt_help", "assistant", "agt_coder")]).ok).toBe(true);
    // Someone outside the department is not an employee to help.
    expect(assertAssistantLimits(member("agt_help", "assistant", "agt_stranger"), rows)).toMatchObject({
      ok: false,
      error: { code: "helps_agent_not_in_department" },
    });
    expect(assertAssistantLimits(member("agt_help", "assistant", "agt_help"), rows)).toMatchObject({
      ok: false,
      error: { code: "assistant_self_help" },
    });
  });

  it("does not stack helpers under a helper", () => {
    const rows = [member("agt_lead", "lead"), member("agt_first", "assistant", null)];
    expect(assertAssistantLimits(member("agt_second", "assistant", "agt_first"), rows)).toMatchObject({
      ok: false,
      error: { code: "assistant_helps_assistant" },
    });
  });

  it("stops at three helpers for one employee", () => {
    const rows = [
      member("agt_lead", "lead"),
      member("agt_coder", "executor"),
      ...Array.from({ length: ASSISTANTS_PER_EMPLOYEE }, (_, index) => member(`agt_h${index}`, "assistant", "agt_coder")),
    ];
    expect(assertAssistantLimits(member("agt_extra", "assistant", "agt_coder"), rows)).toMatchObject({
      ok: false,
      error: { code: "assistant_limit_reached" },
    });
  });

  it("keeps «helps whom» for assistants only", () => {
    expect(assertAssistantLimits(member("agt_coder", "executor", "agt_lead"), [])).toMatchObject({
      ok: false,
      error: { code: "helps_not_assistant" },
    });
  });
});

describe("what an assistant may be given", () => {
  it("takes a subtask but not the department's main job", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const ctx = s.ctx;
    const helper = s.store.provisionAgent(ctx, {
      requestId: randomUUID(),
      name: "Разведчик",
      state: "active",
      version: {
        version: 1,
        role: "Помощник разработчика",
        instructions: "Читает и собирает выжимку.",
        providerId: "claude-code",
        model: "claude-haiku-4-5",
        reasoningEffort: "low",
        skillIds: [],
        mcpIds: [],
        policyVersionId: s.policyVersionId,
      },
    } as never);
    if (!helper.ok) throw new Error(helper.error.message);
    const added = s.store.addMembership(ctx, {
      requestId: randomUUID(),
      departmentId: s.departmentId,
      agentId: helper.value.agent.id,
      role: "assistant",
      helpsAgentId: s.developer,
    } as never);
    expect(added.ok).toBe(true);

    const main = s.store.createJob(ctx, {
      requestId: randomUUID(),
      bindingId: s.bindingId,
      departmentId: s.departmentId,
      assignedAgentId: helper.value.agent.id,
      title: "Главная задача помощнику",
      brief: "…",
      acceptance: "…",
    } as never);
    expect(main).toMatchObject({ ok: false, error: { code: "assistant_main_job" } });

    const parent = s.store.createJob(ctx, {
      requestId: randomUUID(),
      bindingId: s.bindingId,
      departmentId: s.departmentId,
      assignedAgentId: s.developer,
      title: "Работа исполнителя",
      brief: "…",
      acceptance: "…",
    } as never);
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;
    const subtask = s.store.createJob(ctx, {
      requestId: randomUUID(),
      bindingId: s.bindingId,
      departmentId: s.departmentId,
      parentJobId: parent.value.id,
      assignedAgentId: helper.value.agent.id,
      title: "Собрать выжимку",
      brief: "…",
      acceptance: "…",
    } as never);
    expect(subtask.ok).toBe(true);
  });
});

describe("saving a department with assistants", () => {
  it("keeps «helps whom» through the department profile", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const helper = s.store.provisionAgent(s.ctx, {
      requestId: randomUUID(),
      name: "Помощник",
      state: "active",
      version: {
        version: 1,
        role: "Помощник разработчика",
        instructions: "Читает и собирает.",
        providerId: "claude-code",
        model: "claude-haiku-4-5",
        reasoningEffort: "low",
        skillIds: [],
        mcpIds: [],
        policyVersionId: s.policyVersionId,
      },
    } as never);
    if (!helper.ok) throw new Error(helper.error.message);
    const department = s.store.getDepartment(s.departmentId)!;
    const saved = s.store.saveDepartmentProfile(s.ctx, {
      requestId: randomUUID(),
      expectedRevision: department.revision,
      departmentId: s.departmentId,
      name: department.name,
      leadAgentId: department.leadAgentId,
      memberships: [
        { agentId: s.lead, role: "lead" },
        { agentId: s.developer, role: "executor" },
        { agentId: s.reviewer, role: "reviewer" },
        { agentId: helper.value.agent.id, role: "assistant", helpsAgentId: s.developer },
      ],
    } as never);
    expect(saved.ok).toBe(true);
    const rows = s.store.listMemberships(s.departmentId);
    expect(rows.find((row) => row.agentId === helper.value.agent.id)).toMatchObject({
      role: "assistant",
      helpsAgentId: s.developer,
    });
    // An executor never carries the field, whatever the caller sends.
    expect(rows.find((row) => row.agentId === s.developer)?.helpsAgentId).toBeNull();
  });

  it("retargets whom an existing assistant helps without changing the role", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const helper = s.store.provisionAgent(s.ctx, {
      requestId: randomUUID(),
      name: "Помощник",
      state: "active",
      version: {
        version: 1,
        role: "Секретарь руководителя",
        instructions: "Читает и собирает.",
        providerId: "claude-code",
        model: "claude-haiku-4-5",
        reasoningEffort: "low",
        skillIds: [],
        mcpIds: [],
        policyVersionId: s.policyVersionId,
      },
    } as never);
    if (!helper.ok) throw new Error(helper.error.message);
    const department = s.store.getDepartment(s.departmentId)!;
    const first = s.store.saveDepartmentProfile(s.ctx, {
      requestId: randomUUID(),
      expectedRevision: department.revision,
      departmentId: s.departmentId,
      name: department.name,
      leadAgentId: department.leadAgentId,
      memberships: [
        { agentId: s.lead, role: "lead" },
        { agentId: s.developer, role: "executor" },
        { agentId: s.reviewer, role: "reviewer" },
        { agentId: helper.value.agent.id, role: "assistant", helpsAgentId: s.developer },
      ],
    } as never);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const retargeted = s.store.saveDepartmentProfile(s.ctx, {
      requestId: randomUUID(),
      expectedRevision: first.value.department.revision,
      departmentId: s.departmentId,
      name: department.name,
      leadAgentId: department.leadAgentId,
      memberships: [
        { agentId: s.lead, role: "lead" },
        { agentId: s.developer, role: "executor" },
        { agentId: s.reviewer, role: "reviewer" },
        { agentId: helper.value.agent.id, role: "assistant", helpsAgentId: s.lead },
      ],
    } as never);
    expect(retargeted.ok).toBe(true);
    const rows = s.store.listMemberships(s.departmentId);
    expect(rows.find((row) => row.agentId === helper.value.agent.id)).toMatchObject({
      role: "assistant",
      helpsAgentId: s.lead,
    });
  });
});
