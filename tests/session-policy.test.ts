import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase, type SqlDatabase } from "../src/server/db";
import { createDomainStore, type ServiceContext } from "../src/server/services";
import { buildAgencyInstructions } from "../src/server/delegation/instructions";
import { resolveSessionPolicy, saveSessionPolicy } from "../src/server/delegation/session-policy";
import { resolveAlias } from "../src/server/cli/aliases";
import { userSessionChoice, userSessionLabel } from "../src/app/session-mode-copy";

function seedProject(db: SqlDatabase) {
  const store = createDomainStore(db);
  const bootstrap: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [] };
  const policy = store.createPolicyVersion(bootstrap, {
    requestId: randomUUID(),
    allowedCapabilities: ["read.files"],
    cliHostConstraints: { providerIds: ["claude-code"], hostIds: ["host_mini"] },
    secretRefs: [],
  });
  if (!policy.ok) throw new Error(policy.error.message);
  const lead = store.provisionAgent(bootstrap, {
    requestId: randomUUID(),
    name: "Lead",
    state: "active",
    version: {
      version: 1,
      role: "lead",
      instructions: "Orchestrate.",
      providerId: "claude-code",
      model: "claude-sonnet-5",
      skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
      mcpIds: [],
      policyVersionId: policy.value.id,
    },
  });
  if (!lead.ok) throw new Error(lead.error.message);
  const department = store.provisionDepartment(bootstrap, {
    requestId: randomUUID(),
    name: "Разработка",
    leadAgentId: lead.value.agent.id,
    process: { instructions: "Пишет код.", acceptance: "Тесты зелёные.", reviewPolicy: { required: true } },
  });
  if (!department.ok) throw new Error(department.error.message);
  const binding = store.createProjectBinding(bootstrap, {
    requestId: randomUUID(),
    bbProjectId: "proj_bound",
    environmentId: "env_one",
    hostId: "host_mini",
    canonicalRoot: "/work/app",
    policyVersionId: policy.value.id,
    sectionId: null,
  });
  if (!binding.ok) throw new Error(binding.error.message);
  const ctx: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [binding.value.id] };
  const linked = store.linkDepartment(ctx, {
    requestId: randomUUID(),
    bindingId: binding.value.id,
    departmentId: department.value.department.id,
  });
  if (!linked.ok) throw new Error(linked.error.message);
  return { store, policyId: policy.value.id, bindingId: binding.value.id, leadId: lead.value.agent.id };
}

describe("session policy for ordinary chats", () => {
  it("falls back to the Agency-wide mode and lets a project force the manager role", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    seedProject(db);
    expect(resolveSessionPolicy(db, { bbProjectId: "proj_bound" }, "delegate").effective).toBe("pm");
    expect(resolveSessionPolicy(db, { bbProjectId: "proj_bound" }, "off").effective).toBe("ordinary");
    expect(saveSessionPolicy(db, { scope: "project", scopeId: "proj_bound", mode: "pm" }, "2026-09-19T12:00:00.000Z").ok).toBe(true);
    const route = resolveSessionPolicy(db, { bbProjectId: "proj_bound", threadId: "thr_one" }, "off");
    expect(route.effective).toBe("pm");
    expect(route.source).toBe("project");
    const text = buildAgencyInstructions(db, { threadId: "thr_one", projectId: "proj_bound" }, "off");
    expect(text).toContain("## BB Agency: you are the project manager");
    expect(text).toContain("You do not implement");
    expect(text).toContain("Create the job now:");
    expect(text).toContain("Creating the job puts it in the launch queue");
    expect(saveSessionPolicy(db, { scope: "thread", scopeId: "thr_one", mode: "ordinary" }, "2026-09-19T12:01:00.000Z").ok).toBe(true);
    expect(buildAgencyInstructions(db, { threadId: "thr_one", projectId: "proj_bound" }, "off")).toBeNull();
    expect(resolveSessionPolicy(db, { bbProjectId: "proj_bound", threadId: "thr_one" }, "off").source).toBe("thread");
    db.close();
  });

  it("keeps a new-chat draft off the project default and pins it on first send", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    seedProject(db);
    const now = new Date().toISOString();
    expect(saveSessionPolicy(db, { scope: "project", scopeId: "proj_bound", mode: "pm" }, now).ok).toBe(true);
    expect(saveSessionPolicy(db, { scope: "pending", scopeId: "proj_bound", mode: "ordinary" }, now).ok).toBe(true);
    expect(resolveSessionPolicy(db, { bbProjectId: "proj_bound" }, "delegate")).toMatchObject({
      effective: "pm",
      source: "project",
      pending: "ordinary",
    });
    expect(buildAgencyInstructions(db, { threadId: "thr_new", projectId: "proj_bound" }, "delegate")).toBeNull();
    expect(resolveSessionPolicy(db, { bbProjectId: "proj_bound", threadId: "thr_new" }, "delegate")).toMatchObject({
      effective: "ordinary",
      source: "thread",
      pending: "inherit",
    });
    expect(buildAgencyInstructions(db, { threadId: "thr_other", projectId: "proj_bound" }, "delegate")).toContain("you are the project manager");
    db.close();
  });

  it("applies a folder override only when that folder is the only live connection", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const seeded = seedProject(db);
    expect(saveSessionPolicy(db, { scope: "binding", scopeId: seeded.bindingId, mode: "suggest" }, "2026-09-19T12:00:00.000Z").ok).toBe(true);
    expect(resolveSessionPolicy(db, { bbProjectId: "proj_bound" }, "delegate")).toMatchObject({
      effective: "suggest",
      source: "binding",
    });
    const second = seeded.store.createProjectBinding({ actor: { kind: "system" }, allowedBindingIds: [] }, {
      requestId: randomUUID(),
      bbProjectId: "proj_bound",
      environmentId: "env_two",
      hostId: "host_ovh",
      canonicalRoot: "/other/app",
      policyVersionId: seeded.policyId,
      sectionId: "sec_ads",
    });
    expect(second.ok).toBe(true);
    expect(resolveSessionPolicy(db, { bbProjectId: "proj_bound" }, "delegate")).toMatchObject({
      effective: "pm",
      source: "agency",
      bindingId: null,
    });
    expect(resolveSessionPolicy(db, { bbProjectId: "proj_bound", bindingId: seeded.bindingId }, "delegate")).toMatchObject({
      effective: "pm",
      source: "agency",
      bindingId: null,
    });
    db.close();
  });

  it("thread-only lookup stays disconnected until the BB project id is known", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    seedProject(db);
    expect(resolveSessionPolicy(db, { threadId: "thr_zkfbf5sx27" }, "delegate")).toMatchObject({
      connected: false,
      bbProjectId: null,
      effective: "pm",
    });
    expect(resolveSessionPolicy(db, { bbProjectId: "proj_bound", threadId: "thr_zkfbf5sx27" }, "delegate")).toMatchObject({
      connected: true,
      bbProjectId: "proj_bound",
    });
    db.close();
  });

  it("shows three user-facing modes", () => {
    expect(userSessionChoice("inherit")).toBe("pm");
    expect(userSessionChoice("pm")).toBe("pm");
    expect(userSessionChoice("delegate")).toBe("pm");
    expect(userSessionChoice("suggest")).toBe("suggest");
    expect(userSessionChoice("ordinary")).toBe("ordinary");
    expect(userSessionLabel("delegate")).toBe("Агентство");
    expect(userSessionLabel("suggest")).toBe("По запросу");
    expect(userSessionLabel("ordinary")).toBe("Сам сделает");
  });

  it("routes CLI aliases for session get and save", () => {
    expect(resolveAlias(["session", "get"])).toBe("getSessionPolicy");
    expect(resolveAlias(["session", "save"])).toBe("saveSessionPolicy");
    expect(resolveAlias(["project", "session", "get"])).toBe("getSessionPolicy");
  });
});
