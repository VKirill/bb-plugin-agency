import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { parseJobTeamRoles } from "../src/app/data/job-team";
import { jobSchema } from "../src/shared/contracts";
import { openMigratedDatabase } from "../src/server/db";
import { createDomainStore, type ServiceContext } from "../src/server/services";
import { assertJobTeamMembership, normalizeJobTeamIds } from "../src/server/runtime/job-team";

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

function openDb() {
  const dir = mkdtempSync(join(tmpdir(), "agy-job-team-"));
  tempDirs.push(dir);
  return openMigratedDatabase(new Database(join(dir, "agency.sqlite")));
}

async function seed() {
  const db = openDb();
  const store = createDomainStore(db);
  const bootstrap: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [] };
  const policy = store.createPolicyVersion(bootstrap, {
    requestId: requestId(),
    allowedCapabilities: ["read.files"],
    cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_mini"] },
    secretRefs: ["OPENAI_API_KEY"],
  });
  if (!policy.ok) throw new Error(policy.error.message);
  const editor = store.provisionAgent(bootstrap, {
    requestId: requestId(),
    name: "Редактор",
    state: "active",
    version: {
      version: 1,
      role: "editor",
      instructions: "Править.",
      providerId: "codex",
      model: "gpt-5.6",
      skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
      mcpIds: [],
      policyVersionId: policy.value.id,
    },
  });
  if (!editor.ok) throw new Error(editor.error.message);
  const reviewer = store.provisionAgent(bootstrap, {
    requestId: requestId(),
    name: "Рецензент",
    state: "active",
    version: {
      version: 1,
      role: "reviewer",
      instructions: "Проверять.",
      providerId: "codex",
      model: "gpt-5.6",
      skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
      mcpIds: [],
      policyVersionId: policy.value.id,
    },
  });
  if (!reviewer.ok) throw new Error(reviewer.error.message);
  const outsider = store.provisionAgent(bootstrap, {
    requestId: requestId(),
    name: "Чужой",
    state: "active",
    version: {
      version: 1,
      role: "other",
      instructions: "Не в отделе.",
      providerId: "codex",
      model: "gpt-5.6",
      skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
      mcpIds: [],
      policyVersionId: policy.value.id,
    },
  });
  if (!outsider.ok) throw new Error(outsider.error.message);
  const department = store.provisionDepartment(bootstrap, {
    requestId: requestId(),
    name: "Редактура",
    leadAgentId: editor.value.agent.id,
    process: {
      instructions: "Черновик.",
      acceptance: "Файл принят.",
      reviewPolicy: { required: false },
    },
  });
  if (!department.ok) throw new Error(department.error.message);
  const member = store.addMembership(bootstrap, {
    requestId: requestId(),
    departmentId: department.value.department.id,
    agentId: reviewer.value.agent.id,
    role: "executor",
  });
  if (!member.ok) throw new Error(member.error.message);
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
  return {
    store,
    ctx,
    departmentId: department.value.department.id,
    bindingId: binding.value.id,
    editorId: editor.value.agent.id,
    reviewerId: reviewer.value.agent.id,
    outsiderId: outsider.value.agent.id,
  };
}

describe("job team ids", () => {
  it("rejects duplicates and unknown members without reading a brief", () => {
    expect(normalizeJobTeamIds(["agt_aaaa1111", "agt_aaaa1111"]).ok).toBe(false);
    const denied = assertJobTeamMembership({
      departmentId: "dep_abcd1234",
      reviewerAgentIds: ["agt_zzzz9999"],
      observerAgentIds: [],
      isMember: () => false,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("team_agent_not_member");
    expect(parseJobTeamRoles({ brief: "reviewer agt_aaaa1111", title: "agt_bbbb2222" })).toEqual({
      reviewerIds: [],
      watcherIds: [],
    });
    expect(parseJobTeamRoles({ reviewerAgentIds: ["agt_aaaa1111"], observerAgentIds: ["agt_bbbb2222"] })).toEqual({
      reviewerIds: ["agt_aaaa1111"],
      watcherIds: ["agt_bbbb2222"],
    });
  });

  it("stores exact ids on create, reads them on getJob, and defaults omitted lists to empty", async () => {
    const live = await seed();
    const created = live.store.createJob(live.ctx, {
      requestId: requestId(),
      key: "AG-301",
      bindingId: live.bindingId,
      departmentId: live.departmentId,
      title: "Карточка",
      brief: "Проверяющий agt_shouldnotparse и наблюдатель в тексте.",
      acceptance: "Списки из полей, не из брифа.",
      parentJobId: null,
      assignedAgentId: live.editorId,
      reviewerAgentIds: [live.reviewerId],
      observerAgentIds: [live.editorId],
      priority: "normal",
      dueAt: null,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.message);
    const parsed = jobSchema.parse(created.value);
    expect(parsed.reviewerAgentIds).toEqual([live.reviewerId]);
    expect(parsed.observerAgentIds).toEqual([live.editorId]);
    const got = live.store.getJob(created.value.id);
    expect(got?.reviewerAgentIds).toEqual([live.reviewerId]);
    expect(got?.observerAgentIds).toEqual([live.editorId]);

    const bare = live.store.createJob(live.ctx, {
      requestId: requestId(),
      key: "AG-302",
      bindingId: live.bindingId,
      departmentId: live.departmentId,
      title: "Без ролей",
      brief: "Пустые списки.",
      acceptance: "Пусто.",
      parentJobId: null,
      assignedAgentId: live.editorId,
      priority: "normal",
      dueAt: null,
    });
    expect(bare.ok && bare.value.reviewerAgentIds).toEqual([]);
    expect(bare.ok && bare.value.observerAgentIds).toEqual([]);
  });

  it("rejects a non-member before insert and keeps CAS on update", async () => {
    const live = await seed();
    const denied = live.store.createJob(live.ctx, {
      requestId: requestId(),
      key: "AG-303",
      bindingId: live.bindingId,
      departmentId: live.departmentId,
      title: "Чужой",
      brief: "Не член.",
      acceptance: "Отказ.",
      parentJobId: null,
      assignedAgentId: live.editorId,
      reviewerAgentIds: [live.outsiderId],
      priority: "normal",
      dueAt: null,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("team_agent_not_member");
    expect(live.store.getJobByKey("AG-303")).toBeUndefined();

    const job = live.store.createJob(live.ctx, {
      requestId: requestId(),
      key: "AG-304",
      bindingId: live.bindingId,
      departmentId: live.departmentId,
      title: "CAS",
      brief: "Списки.",
      acceptance: "Ок.",
      parentJobId: null,
      assignedAgentId: live.editorId,
      priority: "normal",
      dueAt: null,
    });
    expect(job.ok).toBe(true);
    if (!job.ok) throw new Error(job.error.message);
    const stale = live.store.updateJob(live.ctx, {
      requestId: requestId(),
      jobId: job.value.id,
      expectedRevision: job.value.revision + 1,
      reviewerAgentIds: [live.reviewerId],
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("revision_conflict");
    expect(live.store.getJob(job.value.id)?.reviewerAgentIds).toEqual([]);

    const updated = live.store.updateJob(live.ctx, {
      requestId: requestId(),
      jobId: job.value.id,
      expectedRevision: job.value.revision,
      reviewerAgentIds: [live.reviewerId],
      observerAgentIds: [],
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error(updated.error.message);
    expect(updated.value.revision).toBe(job.value.revision + 1);
    expect(updated.value.reviewerAgentIds).toEqual([live.reviewerId]);
    expect(updated.value.observerAgentIds).toEqual([]);
    expect(live.store.getJob(job.value.id)?.reviewerAgentIds).toEqual([live.reviewerId]);
  });
});
