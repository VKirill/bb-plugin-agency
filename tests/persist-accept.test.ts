import { describe, expect, it, vi } from "vitest";
import { ACCEPT_THEN_DONE_NOTICE } from "../src/app/data/job-lifecycle";
import { persistAcceptThenDone, persistJobPatch } from "../src/app/data/persist";
import type { AgencyApi } from "../src/app/data/agency-api";
import type { WorkspaceSnapshot } from "../src/app/data/snapshot";
import { mapJobs } from "../src/app/data/view-models";

const snapshot: WorkspaceSnapshot = {
  contractVersion: "agency.domain.stage1.v1",
  isolation: { catalogSkillsIsolated: false, catalogMcpIsolated: false, execution: "unavailable", reason: "closed" },
  bindings: [],
  departments: [],
  agents: [],
  jobs: [{
    id: "job_aaaaaaaaaaaaaaaaaaaaaaaa",
    key: "AG-QA",
    bindingId: "bnd_project01",
    departmentId: "dep_editorial",
    title: "Review",
    brief: "b",
    acceptance: "a",
    state: "review",
    parentJobId: null,
    assignedAgentId: null,
    priority: "normal",
    dueAt: null,
    revision: 4,
    updatedAt: "2026-09-14T00:00:00Z",
  }],
  counts: { review: 1 },
  memberships: [],
  agentVersions: [],
  processVersions: [],
  projectDepartments: [],
  policies: [],
};

describe("accept then done", () => {
  it("refuses persistJobPatch directly to done", async () => {
    const job = mapJobs(snapshot)[0];
    const transitionJob = vi.fn();
    const result = await persistJobPatch({ transitionJob } as unknown as AgencyApi, snapshot, job, { ...job, state: "done" });
    expect(transitionJob).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, failure: { kind: "domain", error: { code: "lifecycle_guard", message: ACCEPT_THEN_DONE_NOTICE } } });
  });

  it("accepts exact version/hash and skips a second transition when the store already closed", async () => {
    const hash = "e".repeat(64);
    const api = {
      acceptArtifactVersion: vi.fn(async (input: { version: number; hash: string }) => ({
        ok: true as const,
        value: { artifactId: "art_eeeeeeeeeeeeeeee", jobId: "job_aaaaaaaaaaaaaaaaaaaaaaaa", version: input.version, hash: input.hash },
      })),
      getJob: vi.fn(async () => ({
        ok: true as const,
        value: { job: { ...snapshot.jobs[0], revision: 5, state: "done" }, artifacts: [], activity: [], needsInput: null },
      })),
      transitionJob: vi.fn(),
    } as unknown as AgencyApi;
    const result = await persistAcceptThenDone(api, {
      expectedRevision: 4,
      jobId: "job_aaaaaaaaaaaaaaaaaaaaaaaa",
      artifactId: "art_eeeeeeeeeeeeeeee",
      version: 2,
      hash,
    });
    expect(result).toEqual({ ok: true });
    expect(api.acceptArtifactVersion).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job_aaaaaaaaaaaaaaaaaaaaaaaa",
      artifactId: "art_eeeeeeeeeeeeeeee",
      version: 2,
      hash,
      expectedRevision: 4,
    }));
    expect(api.transitionJob).not.toHaveBeenCalled();
  });
});
