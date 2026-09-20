import { describe, expect, it } from "vitest";
import type { WorkspaceSnapshot } from "../src/app/data/snapshot";
import { mapJobs } from "../src/app/data/view-models";

const snapshot: WorkspaceSnapshot = {
  contractVersion: "agency.domain.stage1.v1",
  isolation: { catalogSkillsIsolated: false, catalogMcpIsolated: false, execution: "unavailable", reason: "closed" },
  bindings: [{
    id: "bnd_project01",
    bbProjectId: "proj_selfy",
    bbProjectName: "SelfyStudio",
    environmentName: "локально",
    hostName: "Mac mini",
    environmentId: "env_local",
    hostId: "host_mini",
    canonicalRoot: "/agency/selfy",
    policyVersionId: "pol_default1",
    sectionId: null,
    revision: 1,
    updatedAt: "2026-09-14T00:00:00Z",
  }],
  departments: [{
    id: "dep_editorial",
    name: "Редакция",
    leadAgentId: "agt_b1fe6a357a7e8736a896c649",
    processVersionId: "prc_editorial",
    revision: 1,
    updatedAt: "2026-09-14T00:00:00Z",
  }],
  agents: [{
    id: "agt_b1fe6a357a7e8736a896c649",
    name: "Анна",
    state: "active",
    currentVersionId: "ver_writer01",
    revision: 1,
    updatedAt: "2026-09-14T00:00:00Z",
  }],
  jobs: [{
    id: "job_2de115e5c5e8bd8b555a71a3",
    key: "AG-1604",
    bindingId: "bnd_project01",
    departmentId: "dep_editorial",
    title: "Live start",
    brief: "Brief",
    acceptance: "Done",
    state: "backlog",
    parentJobId: null,
    assignedAgentId: "agt_b1fe6a357a7e8736a896c649",
    priority: "normal",
    dueAt: null,
    revision: 5,
    updatedAt: "2026-09-14T00:00:00Z",
  }],
  counts: { backlog: 1 },
  memberships: [{ departmentId: "dep_editorial", agentId: "agt_b1fe6a357a7e8736a896c649", role: "executor" }],
  agentVersions: [],
  processVersions: [],
  projectDepartments: [{ bindingId: "bnd_project01", departmentId: "dep_editorial" }],
  policies: [],
};

describe("mapJobs originThreadId", () => {
  it("copies a non-empty originThreadId from the snapshot", () => {
    const [job] = mapJobs({
      ...snapshot,
      jobs: [{ ...snapshot.jobs[0]!, originThreadId: "  thr_originchat01  " }],
    });
    expect(job?.originThreadId).toBe("thr_originchat01");
  });

  it("omits originThreadId when the snapshot field is empty", () => {
    const [blank] = mapJobs({
      ...snapshot,
      jobs: [{ ...snapshot.jobs[0]!, originThreadId: "   " }],
    });
    const [missing] = mapJobs(snapshot);
    expect(blank?.originThreadId).toBeUndefined();
    expect(missing?.originThreadId).toBeUndefined();
  });
});
