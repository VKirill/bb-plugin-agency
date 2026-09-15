import { describe, expect, it } from "vitest";
import {
  planTasksImport,
  resolveTasksImport,
  sourceTaskIdentity,
  TASKS_PLUGIN_SOURCE,
  type TasksImportMappings,
  type TasksImportSnapshot,
  type TasksProject,
  type TasksTask,
} from "../src/server/migration/tasks-import";

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const TASK_1 = "01HZZZZZZZZZZZZZZZZZZZZZT1";
const TASK_2 = "01HZZZZZZZZZZZZZZZZZZZZZT2";
const TASK_3 = "01HZZZZZZZZZZZZZZZZZZZZZT3";
const TASK_DONE = "01HZZZZZZZZZZZZZZZZZZZZZD1";
const BINDING_ID = "bnd_aaaaaaaaaaaa";
const DEPARTMENT_ID = "dep_bbbbbbbbbbbb";
const AGENT_ID = "agt_cccccccccccc";
const FOREIGN_AGENT = "agt_foreigndddd";
const POLICY_ID = "pol_eeeeeeeeeeee";
const PROCESS_ID = "prc_ffffffffffff";
const AGENT_VERSION = "avr_111111111111";
const BATCH_ID = "3d5c9a10-2b7e-4f11-8c4a-9e0d1b2a3c4d";
const HOST_ID = "host_7sea4qaad8";
const ROOT = "/Users/vechkasov/Documents/BB-сервис";
const BB_PROJECT = "proj_ejbam66722";
const STAMP = "2026-09-14T10:00:00.000Z";

function project(overrides: Partial<TasksProject> = {}): TasksProject {
  return {
    id: PROJECT_ID,
    name: "Agency",
    prefix: "AGY",
    nextTaskNumber: 4,
    color: "#445566",
    folderId: null,
    linkedBbProjectId: BB_PROJECT,
    createdAt: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

function task(overrides: Partial<TasksTask> = {}): TasksTask {
  return {
    id: TASK_1,
    projectId: PROJECT_ID,
    number: 1,
    key: "AGY-1",
    title: "Собрать снимок Tasks",
    description: "Сохранить исходный текст поручения без выдуманной приёмки.",
    status: "backlog",
    priority: "high",
    dueDate: null,
    parentTaskId: null,
    position: 1,
    createdAt: STAMP,
    updatedAt: STAMP,
    labelIds: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<TasksImportSnapshot> = {}): TasksImportSnapshot {
  return {
    source: TASKS_PLUGIN_SOURCE,
    tasks: [task()],
    projects: [project()],
    labels: [],
    comments: [],
    attachments: [],
    threads: [],
    ...overrides,
  };
}

function parentChildSnapshot(): TasksImportSnapshot {
  return snapshot({
    tasks: [
      task(),
      task({
        id: TASK_2,
        number: 2,
        key: "AGY-2",
        title: "Подзадача",
        parentTaskId: TASK_1,
        position: 2,
      }),
    ],
  });
}

function planOf(input: unknown) {
  const result = planTasksImport(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected plan");
  return result.value;
}

function workspace(overrides: Partial<TasksImportMappings["workspace"]> = {}): TasksImportMappings["workspace"] {
  return {
    bindings: [
      {
        id: BINDING_ID,
        bbProjectId: BB_PROJECT,
        environmentId: "env_mkd7xx32bf",
        hostId: HOST_ID,
        canonicalRoot: ROOT,
        policyVersionId: POLICY_ID,
        sectionId: null,
        revision: 1,
        updatedAt: STAMP,
      },
    ],
    departments: [
      {
        id: DEPARTMENT_ID,
        name: "Разработка",
        leadAgentId: AGENT_ID,
        processVersionId: PROCESS_ID,
        revision: 1,
        updatedAt: STAMP,
      },
    ],
    agents: [
      {
        id: AGENT_ID,
        name: "Grok",
        state: "active",
        currentVersionId: AGENT_VERSION,
        revision: 1,
        updatedAt: STAMP,
      },
    ],
    memberships: [{ departmentId: DEPARTMENT_ID, agentId: AGENT_ID, role: "lead" }],
    projectDepartments: [{ bindingId: BINDING_ID, departmentId: DEPARTMENT_ID }],
    ...overrides,
  };
}

function mappings(overrides: Partial<TasksImportMappings> = {}): TasksImportMappings {
  return {
    batchId: BATCH_ID,
    expectedHostId: HOST_ID,
    expectedCanonicalRoot: ROOT,
    claimedBbProjectId: BB_PROJECT,
    workspace: workspace(),
    projects: [
      {
        sourceProjectId: PROJECT_ID,
        bindingId: BINDING_ID,
        departmentId: DEPARTMENT_ID,
        expectedBindingRevision: 1,
        expectedDepartmentRevision: 1,
      },
    ],
    tasks: [
      {
        sourceTaskId: TASK_1,
        assignedAgentId: AGENT_ID,
        expectedAgentRevision: 1,
        acceptance: "Источник Tasks сохранён; приёмка задана явно.",
        jobKey: "AG-1",
      },
      {
        sourceTaskId: TASK_2,
        assignedAgentId: AGENT_ID,
        expectedAgentRevision: 1,
        acceptance: "Подзадача принята только после явной приёмки.",
        jobKey: "AG-2",
      },
    ],
    ...overrides,
  };
}

function resolveOf(plan: unknown, mapped: unknown) {
  const result = resolveTasksImport(plan, mapped);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected resolution");
  return result.value;
}

describe("tasks-import resolver", () => {
  it("maps explicit fields into a ready root draft and keeps the child deferred until a parent job exists", () => {
    const planned = planOf(parentChildSnapshot());
    const resolved = resolveOf(planned, mappings());
    expect(resolved.dryRun).toBe(true);
    expect(resolved.mutatesDatabase).toBe(false);
    expect(resolved.createsAcceptedArtifacts).toBe(false);
    expect(resolved.applyOrder).toEqual([sourceTaskIdentity(TASK_1), sourceTaskIdentity(TASK_2)]);
    expect(resolved.summary.tasks).toBe(2);
    expect(resolved.summary.drafts).toBe(1);
    expect(resolved.summary.createJobReady).toBe(1);
    expect(resolved.drafts.map((row) => row.key)).toEqual(["AG-1"]);
    expect(resolved.drafts[0]).toEqual({
      requestId: resolved.drafts[0]?.requestId,
      key: "AG-1",
      bindingId: BINDING_ID,
      departmentId: DEPARTMENT_ID,
      title: "Собрать снимок Tasks",
      brief: "Сохранить исходный текст поручения без выдуманной приёмки.",
      acceptance: "Источник Tasks сохранён; приёмка задана явно.",
      parentJobId: null,
      assignedAgentId: AGENT_ID,
      priority: "high",
      dueAt: null,
    });
    expect(resolved.drafts[0]?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(resolved.items[0]?.createJobReady).toBe(true);
    expect(resolved.items[0]?.createJob?.parentJobId).toBeNull();
    expect(resolved.items[0]?.deferred).toBeNull();
    expect(resolved.items[1]?.createJobReady).toBe(false);
    expect(resolved.items[1]?.createJob).toBeNull();
    expect(resolved.items[1]?.parentSourceIdentity).toBe(sourceTaskIdentity(TASK_1));
    expect(resolved.items[1]?.blockers.map((row) => row.code)).toContain("parent_binding_pending");
    expect(resolved.items[1]?.deferred).toEqual({
      parentSourceIdentity: sourceTaskIdentity(TASK_1),
      payload: {
        key: "AG-2",
        bindingId: BINDING_ID,
        departmentId: DEPARTMENT_ID,
        title: "Подзадача",
        brief: "Сохранить исходный текст поручения без выдуманной приёмки.",
        acceptance: "Подзадача принята только после явной приёмки.",
        assignedAgentId: AGENT_ID,
        priority: "high",
        dueAt: null,
      },
      contentPin: resolved.items[1]?.deferred?.contentPin,
    });
    expect(resolved.globalBlockers.map((row) => row.code)).toEqual(
      expect.arrayContaining(["no_acceptance_in_tasks", "no_bindings_invented"]),
    );
  });

  it("reports missing mapping without fabricating binding or agent ids", () => {
    const planned = planOf(parentChildSnapshot());
    const resolved = resolveOf(
      planned,
      mappings({
        projects: [],
        tasks: [],
      }),
    );
    expect(resolved.drafts).toEqual([]);
    expect(resolved.items[0]?.bindingId).toBeNull();
    expect(resolved.items[0]?.assignedAgentId).toBeNull();
    expect(resolved.items[0]?.blockers.map((row) => row.code)).toEqual(
      expect.arrayContaining(["missing_project_mapping", "missing_task_mapping"]),
    );
    expect(JSON.stringify(resolved)).not.toContain("bnd_");
    expect(JSON.stringify(resolved)).not.toContain("agt_");
  });

  it("rejects a foreign binding whose host or root does not match the supplied workspace claim", () => {
    const planned = planOf(snapshot());
    const resolved = resolveOf(
      planned,
      mappings({
        tasks: [
          {
            sourceTaskId: TASK_1,
            assignedAgentId: AGENT_ID,
            expectedAgentRevision: 1,
            acceptance: "Явная приёмка.",
            jobKey: "AG-1",
          },
        ],
        workspace: workspace({
          bindings: [
            {
              id: BINDING_ID,
              bbProjectId: BB_PROJECT,
              environmentId: "env_mkd7xx32bf",
              hostId: "host_otherhost01",
              canonicalRoot: ROOT,
              policyVersionId: POLICY_ID,
              sectionId: null,
              revision: 1,
              updatedAt: STAMP,
            },
          ],
        }),
      }),
    );
    expect(resolved.drafts).toEqual([]);
    expect(resolved.items[0]?.blockers.map((row) => row.code)).toContain("foreign_binding");
  });

  it("rejects an assignee who is not a member of the mapped department", () => {
    const planned = planOf(snapshot());
    const resolved = resolveOf(
      planned,
      mappings({
        tasks: [
          {
            sourceTaskId: TASK_1,
            assignedAgentId: FOREIGN_AGENT,
            expectedAgentRevision: 1,
            acceptance: "Явная приёмка.",
            jobKey: "AG-1",
          },
        ],
        workspace: workspace({
          agents: [
            {
              id: AGENT_ID,
              name: "Grok",
              state: "active",
              currentVersionId: AGENT_VERSION,
              revision: 1,
              updatedAt: STAMP,
            },
            {
              id: FOREIGN_AGENT,
              name: "Other",
              state: "active",
              currentVersionId: AGENT_VERSION,
              revision: 1,
              updatedAt: STAMP,
            },
          ],
        }),
      }),
    );
    expect(resolved.drafts).toEqual([]);
    expect(resolved.items[0]?.blockers.map((row) => row.code)).toContain("assignee_not_member");
    expect(resolved.items[0]?.assignedAgentId).toBeNull();
  });

  it("rejects stale binding, department, and agent revisions against supplied workspace records", () => {
    const planned = planOf(snapshot());
    const staleBinding = resolveOf(
      planned,
      mappings({
        tasks: [
          {
            sourceTaskId: TASK_1,
            assignedAgentId: AGENT_ID,
            expectedAgentRevision: 1,
            acceptance: "Явная приёмка.",
            jobKey: "AG-1",
          },
        ],
        workspace: workspace({
          bindings: [
            {
              id: BINDING_ID,
              bbProjectId: BB_PROJECT,
              environmentId: "env_mkd7xx32bf",
              hostId: HOST_ID,
              canonicalRoot: ROOT,
              policyVersionId: POLICY_ID,
              sectionId: null,
              revision: 2,
              updatedAt: STAMP,
            },
          ],
        }),
      }),
    );
    expect(staleBinding.items[0]?.blockers.map((row) => row.code)).toContain("stale_binding");

    const staleAgent = resolveOf(
      planned,
      mappings({
        tasks: [
          {
            sourceTaskId: TASK_1,
            assignedAgentId: AGENT_ID,
            expectedAgentRevision: 1,
            acceptance: "Явная приёмка.",
            jobKey: "AG-1",
          },
        ],
        workspace: workspace({
          agents: [
            {
              id: AGENT_ID,
              name: "Grok",
              state: "active",
              currentVersionId: AGENT_VERSION,
              revision: 2,
              updatedAt: STAMP,
            },
          ],
        }),
      }),
    );
    expect(staleAgent.items[0]?.blockers.map((row) => row.code)).toContain("stale_agent");

    const missing = resolveOf(
      planned,
      mappings({
        projects: [
          {
            sourceProjectId: PROJECT_ID,
            bindingId: "bnd_missing00000",
            departmentId: DEPARTMENT_ID,
            expectedBindingRevision: 1,
            expectedDepartmentRevision: 1,
          },
        ],
        tasks: [
          {
            sourceTaskId: TASK_1,
            assignedAgentId: AGENT_ID,
            expectedAgentRevision: 1,
            acceptance: "Явная приёмка.",
            jobKey: "AG-1",
          },
        ],
      }),
    );
    expect(missing.items[0]?.blockers.map((row) => row.code)).toContain("binding_not_found");
    expect(missing.drafts).toEqual([]);
  });

  it("returns the same JSON for repeated identical plan and mappings", () => {
    const planned = planOf(parentChildSnapshot());
    const mapped = mappings();
    const first = resolveOf(planned, mapped);
    const second = resolveOf(planned, mapped);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.drafts[0]?.requestId).toBe(second.drafts[0]?.requestId);
  });

  it("propagates a blocked parent to the child and keeps done items unresolved without accept", () => {
    const planned = planOf(parentChildSnapshot());
    const childOnly = resolveOf(
      planned,
      mappings({
        tasks: [
          {
            sourceTaskId: TASK_2,
            assignedAgentId: AGENT_ID,
            expectedAgentRevision: 1,
            acceptance: "Подзадача принята только после явной приёмки.",
            jobKey: "AG-2",
          },
        ],
      }),
    );
    expect(childOnly.drafts).toEqual([]);
    expect(childOnly.items[0]?.blockers.map((row) => row.code)).toContain("missing_task_mapping");
    expect(childOnly.items[1]?.blockers.map((row) => row.code)).toEqual(
      expect.arrayContaining(["parent_blocked", "parent_binding_pending"]),
    );
    expect(childOnly.items[1]?.parentSourceIdentity).toBe(sourceTaskIdentity(TASK_1));
    expect(childOnly.items[1]?.createJob).toBeNull();
    expect(childOnly.items[1]?.createJobReady).toBe(false);

    const donePlan = planOf(
      snapshot({
        tasks: [task({ id: TASK_DONE, number: 3, key: "AGY-3", title: "Закрытая", status: "done" })],
      }),
    );
    const done = resolveOf(
      donePlan,
      mappings({
        tasks: [
          {
            sourceTaskId: TASK_DONE,
            assignedAgentId: AGENT_ID,
            expectedAgentRevision: 1,
            acceptance: "Нельзя автоaccept.",
            jobKey: "AG-3",
          },
        ],
      }),
    );
    expect(done.drafts).toEqual([]);
    expect(done.items[0]?.blockers.map((row) => row.code)).toEqual(
      expect.arrayContaining(["needs_archival_policy", "done_is_not_agency_done", "done_is_not_accepted_artifact"]),
    );
    expect(done.items[0]?.createJob).toBeNull();
    expect(done.createsAcceptedArtifacts).toBe(false);
  });

  it("keeps graph-cycle items visible with planner conflicts instead of omitting them from applyOrder", () => {
    const cyclic = planOf(
      snapshot({
        tasks: [
          task({ parentTaskId: TASK_2 }),
          task({ id: TASK_2, number: 2, key: "AGY-2", title: "B", parentTaskId: TASK_1 }),
        ],
      }),
    );
    expect(cyclic.applyOrder).toEqual([]);
    const resolved = resolveOf(cyclic, mappings());
    expect(resolved.summary.tasks).toBe(2);
    expect(resolved.items).toHaveLength(2);
    expect(resolved.applyOrder).toEqual([]);
    expect(resolved.items.every((item) => item.blockers.some((row) => row.code === "parent_cycle"))).toBe(true);
    expect(resolved.conflicts).toEqual(
      cyclic.conflicts.map((row) => ({
        code: row.code,
        sourceIdentity: row.sourceIdentity,
        sourceTaskId: row.sourceTaskId,
        message: row.message,
        sourceValue: row.sourceValue,
      })),
    );
    expect(resolved.conflicts.some((row) => row.code === "parent_cycle")).toBe(
      cyclic.conflicts.some((row) => row.code === "parent_cycle"),
    );
    expect(resolved.drafts).toEqual([]);
  });

  it("rejects duplicate source identities, missing applyOrder refs, and duplicate workspace ids", () => {
    const planned = planOf(snapshot());
    const duplicateIdentity = {
      ...planned,
      items: [planned.items[0], planned.items[0]],
    };
    const dupSource = resolveTasksImport(duplicateIdentity, mappings({ tasks: mappings().tasks.slice(0, 1) }));
    expect(dupSource).toEqual({ ok: false, error: { code: "inconsistent_plan", message: "duplicate_identity" } });

    const ghostOrder = { ...planned, applyOrder: ["builtin:tasks:task:missing-order-ref"] };
    const missingRef = resolveTasksImport(ghostOrder, mappings({ tasks: mappings().tasks.slice(0, 1) }));
    expect(missingRef).toEqual({ ok: false, error: { code: "inconsistent_plan", message: "missing_apply_order_ref" } });

    const mismatched = {
      ...planned,
      items: [{ ...planned.items[0], sourceIdentity: sourceTaskIdentity(TASK_2) }],
    };
    const mismatch = resolveTasksImport(mismatched, mappings({ tasks: mappings().tasks.slice(0, 1) }));
    expect(mismatch).toEqual({ ok: false, error: { code: "inconsistent_plan", message: "mismatched_source_identity" } });

    const base = workspace();
    const dupWorkspace = resolveTasksImport(
      planned,
      mappings({
        tasks: mappings().tasks.slice(0, 1),
        workspace: { ...base, bindings: [base.bindings[0]!, base.bindings[0]!] },
      }),
    );
    expect(dupWorkspace).toEqual({
      ok: false,
      error: { code: "duplicate_workspace_id", message: "duplicate_workspace_id" },
    });
  });

  it("does not flatten a parent link into a ready child command and changes pin when parent identity changes", () => {
    const underFirst = planOf(parentChildSnapshot());
    const first = resolveOf(underFirst, mappings());
    expect(first.drafts).toHaveLength(1);
    expect(first.items[1]?.createJob).toBeNull();
    expect(first.items[1]?.deferred?.parentSourceIdentity).toBe(sourceTaskIdentity(TASK_1));

    const underThird = planOf(
      snapshot({
        tasks: [
          task(),
          task({ id: TASK_3, number: 3, key: "AGY-3", title: "Другой корень" }),
          task({
            id: TASK_2,
            number: 2,
            key: "AGY-2",
            title: "Подзадача",
            parentTaskId: TASK_3,
            position: 2,
          }),
        ],
      }),
    );
    const second = resolveOf(
      underThird,
      mappings({
        tasks: [
          ...mappings().tasks,
          {
            sourceTaskId: TASK_3,
            assignedAgentId: AGENT_ID,
            expectedAgentRevision: 1,
            acceptance: "Второй корень.",
            jobKey: "AG-3",
          },
        ],
      }),
    );
    const child = second.items.find((row) => row.sourceTaskId === TASK_2);
    expect(child?.createJobReady).toBe(false);
    expect(child?.createJob).toBeNull();
    expect(child?.deferred?.parentSourceIdentity).toBe(sourceTaskIdentity(TASK_3));
    expect(child?.deferred?.contentPin).not.toBe(first.items[1]?.deferred?.contentPin);
    expect(second.drafts.every((row) => row.parentJobId === null)).toBe(true);
    expect(second.drafts.map((row) => row.key).sort()).toEqual(["AG-1", "AG-3"]);

    const withUnrelatedSibling = planOf(
      snapshot({
        tasks: [
          task(),
          task({ id: TASK_3, number: 3, key: "AGY-3", title: "Чужой sibling того же binding" }),
          task({
            id: TASK_2,
            number: 2,
            key: "AGY-2",
            title: "Подзадача",
            parentTaskId: TASK_1,
            position: 2,
          }),
        ],
      }),
    );
    const siblingSameBinding = resolveOf(
      withUnrelatedSibling,
      mappings({
        tasks: [
          ...mappings().tasks,
          {
            sourceTaskId: TASK_3,
            assignedAgentId: AGENT_ID,
            expectedAgentRevision: 1,
            acceptance: "Чужой корень, не родитель.",
            jobKey: "AG-3",
          },
        ],
      }),
    );
    const siblingChild = siblingSameBinding.items.find((row) => row.sourceTaskId === TASK_2);
    expect(siblingChild?.parentSourceIdentity).toBe(sourceTaskIdentity(TASK_1));
    expect(siblingChild?.createJobReady).toBe(false);
    expect(siblingChild?.createJob).toBeNull();
    expect(siblingChild?.deferred).not.toBeNull();
    expect(siblingChild?.blockers.map((row) => row.code)).toContain("parent_binding_pending");
    expect(siblingSameBinding.drafts.every((row) => row.parentJobId === null)).toBe(true);
    expect(siblingSameBinding.drafts.map((row) => row.key).sort()).toEqual(["AG-1", "AG-3"]);

    const sneakyParent = {
      ...mappings(),
      tasks: mappings().tasks.map((row) =>
        row.sourceTaskId === TASK_2 ? { ...row, existingParentJobId: "job_sibling00000" } : row,
      ),
    };
    expect(resolveTasksImport(underFirst, sneakyParent)).toEqual({
      ok: false,
      error: { code: "invalid_mappings", message: "schema_invalid" },
    });
    const sneakyJobs = {
      ...mappings(),
      workspace: { ...workspace(), jobs: [{ id: "job_sibling00000", bindingId: BINDING_ID }] },
    };
    expect(resolveTasksImport(underFirst, sneakyJobs)).toEqual({
      ok: false,
      error: { code: "invalid_mappings", message: "schema_invalid" },
    });
  });
});
