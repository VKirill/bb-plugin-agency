import { describe, expect, it } from "vitest";
import {
  planTasksImport,
  sourceTaskIdentity,
  TASKS_IMPORT_INTEGRATION_PORTS,
  TASKS_PLUGIN_SOURCE,
  type TasksImportSnapshot,
  type TasksProject,
  type TasksTask,
} from "../src/server/migration/tasks-import";

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const TASK_1 = "01HZZZZZZZZZZZZZZZZZZZZZT1";
const TASK_2 = "01HZZZZZZZZZZZZZZZZZZZZZT2";
const TASK_3 = "01HZZZZZZZZZZZZZZZZZZZZZT3";
const TASK_4 = "01HZZZZZZZZZZZZZZZZZZZZZT4";
const LABEL_1 = "01HZZZZZZZZZZZZZZZZZZZZZK1";
const COMMENT_1 = "01HZZZZZZZZZZZZZZZZZZZZZC1";
const ATTACH_1 = "01HZZZZZZZZZZZZZZZZZZZZZA1";
const THREAD_1 = "01HZZZZZZZZZZZZZZZZZZZZZH1";
const OTHER_PROJECT = "01HZZZZZZZZZZZZZZZZZZZZZP2";

function project(overrides: Partial<TasksProject> = {}): TasksProject {
  return {
    id: PROJECT_ID,
    name: "Agency",
    prefix: "AGY",
    nextTaskNumber: 4,
    color: "#445566",
    folderId: null,
    linkedBbProjectId: "proj_ejbam66722",
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
    createdAt: "2026-09-14T10:00:00.000Z",
    updatedAt: "2026-09-14T10:00:00.000Z",
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

function planOf(input: unknown) {
  const result = planTasksImport(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("tasks-import planner", () => {
  it("maps a parent then subtask on real Tasks RPC shapes without inventing bindings or acceptance", () => {
    const parent = task();
    const child = task({
      id: TASK_2,
      number: 2,
      key: "AGY-2",
      title: "Подзадача",
      parentTaskId: TASK_1,
      position: 2,
    });
    const planned = planOf(
      snapshot({
        tasks: [child, parent],
        labels: [{ id: LABEL_1, projectId: PROJECT_ID, name: "import", color: "blue" }],
        comments: [
          {
            id: COMMENT_1,
            taskId: TASK_1,
            kind: "user",
            authorName: "You",
            presetName: null,
            threadId: "thr_7ddibu9cnt",
            body: "Не отключать Tasks.",
            notifiedCount: 0,
            createdAt: "2026-09-14T11:00:00.000Z",
          },
        ],
        attachments: [
          {
            id: ATTACH_1,
            taskId: TASK_1,
            commentId: null,
            fileName: "notes.md",
            mime: "text/markdown",
            sizeBytes: 12,
            isImage: false,
            createdAt: "2026-09-14T11:01:00.000Z",
          },
        ],
        threads: [
          {
            id: THREAD_1,
            taskId: TASK_1,
            threadId: "thr_2sgqe4rmmd",
            presetName: "Claude",
            title: "Worker",
            liveStatus: "idle",
            attachedAt: "2026-09-14T11:02:00.000Z",
            updatedAt: "2026-09-14T11:02:00.000Z",
          },
        ],
      }),
    );

    expect(planned.dryRun).toBe(true);
    expect(planned.mutatesDatabase).toBe(false);
    expect(planned.disablesTasks).toBe(false);
    expect(planned.createsAcceptedArtifacts).toBe(false);
    expect(planned.applyOrder).toEqual([sourceTaskIdentity(TASK_1), sourceTaskIdentity(TASK_2)]);
    expect(planned.summary.createJobReady).toBe(0);
    expect(planned.items.map((item) => item.sourceTaskId)).toEqual([TASK_1, TASK_2]);

    const parentItem = planned.items[0]!;
    expect(parentItem.graphOk).toBe(true);
    expect(parentItem.createJobReady).toBe(false);
    expect(parentItem.proposed).toEqual({
      title: "Собрать снимок Tasks",
      brief: "Сохранить исходный текст поручения без выдуманной приёмки.",
      acceptance: null,
      assignedAgentId: null,
      bindingId: null,
      departmentId: null,
      parentSourceIdentity: null,
      jobKey: null,
      priority: "high",
      dueAt: null,
      jobState: "backlog",
      acceptArtifact: false,
    });
    expect(parentItem.source.description).toContain("исходный текст");
    expect(parentItem.source.status).toBe("backlog");
    expect(parentItem.preserved.comments[0]?.body).toBe("Не отключать Tasks.");
    expect(parentItem.preserved.attachments[0]?.fileName).toBe("notes.md");
    expect(parentItem.preserved.threads[0]?.threadId).toBe("thr_2sgqe4rmmd");
    expect(parentItem.preserved.links).toEqual([
      { kind: "bb_project", value: "proj_ejbam66722" },
      { kind: "comment_thread", value: "thr_7ddibu9cnt" },
      { kind: "thread", value: "thr_2sgqe4rmmd" },
    ]);
    expect(parentItem.blockers.map((row) => row.code)).toEqual([
      "missing_acceptance",
      "missing_assignee",
      "missing_binding",
      "missing_department",
    ]);
    expect(parentItem.unsupported.map((row) => row.field)).toEqual([
      "attachments",
      "comments",
      "key",
      "position",
      "project.linkedBbProjectId",
      "threads",
    ]);
    expect(planned.items[1]?.proposed.parentSourceIdentity).toBe(sourceTaskIdentity(TASK_1));
    expect(TASKS_IMPORT_INTEGRATION_PORTS).toEqual([
      "TasksSnapshotReader",
      "ProjectBindingResolver",
      "DepartmentResolver",
      "AcceptanceAuthor",
      "JobApplyExecutor",
      "AttachmentLocator",
    ]);
  });

  it("repeats the same snapshot with identical JSON", () => {
    const input = snapshot({
      tasks: [
        task({ id: TASK_2, number: 2, key: "AGY-2", parentTaskId: TASK_1, title: "Child" }),
        task(),
      ],
    });
    expect(JSON.stringify(planOf(input))).toBe(JSON.stringify(planOf(structuredClone(input))));
  });

  it("records duplicate source ids as conflicts and keeps them out of applyOrder", () => {
    const planned = planOf(snapshot({ tasks: [task(), task({ title: "Copy" })] }));
    expect(planned.summary.tasks).toBe(2);
    expect(planned.summary.uniqueTasks).toBe(1);
    expect(planned.applyOrder).toEqual([]);
    expect(planned.conflicts).toEqual([
      {
        code: "duplicate_source_id",
        sourceIdentity: sourceTaskIdentity(TASK_1),
        sourceTaskId: TASK_1,
        message: "source task id occurs more than once",
        sourceValue: TASK_1,
      },
    ]);
    expect(planned.items[0]?.graphOk).toBe(false);
    expect(planned.items[0]?.blockers.some((row) => row.code === "duplicate_source_id")).toBe(true);
  });

  it("blocks missing parent, cycles, depth > 1, and cross-project parent links", () => {
    const missing = planOf(snapshot({ tasks: [task({ parentTaskId: TASK_2 })] }));
    expect(missing.applyOrder).toEqual([]);
    expect(missing.items[0]?.blockers.some((row) => row.code === "missing_parent")).toBe(true);

    const self = planOf(snapshot({ tasks: [task({ parentTaskId: TASK_1 })] }));
    expect(self.items[0]?.blockers.some((row) => row.code === "task_parent_invalid")).toBe(true);

    const emptyBrief = planOf(snapshot({ tasks: [task({ description: "" })] }));
    expect(emptyBrief.items[0]?.source.description).toBe("");
    expect(emptyBrief.items[0]?.proposed.brief).toBeNull();
    expect(emptyBrief.items[0]?.blockers.some((row) => row.code === "missing_brief")).toBe(true);

    const cyclic = planOf(
      snapshot({
        tasks: [
          task({ parentTaskId: TASK_2 }),
          task({ id: TASK_2, number: 2, key: "AGY-2", title: "B", parentTaskId: TASK_1 }),
        ],
      }),
    );
    expect(cyclic.applyOrder).toEqual([]);
    expect(cyclic.items.every((item) => item.blockers.some((row) => row.code === "parent_cycle"))).toBe(true);

    const deep = planOf(
      snapshot({
        tasks: [
          task(),
          task({ id: TASK_2, number: 2, key: "AGY-2", title: "Child", parentTaskId: TASK_1 }),
          task({ id: TASK_3, number: 3, key: "AGY-3", title: "Grandchild", parentTaskId: TASK_2 }),
        ],
      }),
    );
    expect(deep.applyOrder).toEqual([sourceTaskIdentity(TASK_1), sourceTaskIdentity(TASK_2)]);
    expect(deep.items.find((item) => item.sourceTaskId === TASK_3)?.blockers.some((row) => row.code === "subtask_depth_exceeded")).toBe(
      true,
    );

    const cross = planOf(
      snapshot({
        projects: [project(), project({ id: OTHER_PROJECT, prefix: "OTH", name: "Other", linkedBbProjectId: null })],
        tasks: [
          task(),
          task({
            id: TASK_2,
            projectId: OTHER_PROJECT,
            number: 1,
            key: "OTH-1",
            title: "Foreign child",
            parentTaskId: TASK_1,
          }),
        ],
      }),
    );
    expect(cross.items.find((item) => item.sourceTaskId === TASK_2)?.blockers.some((row) => row.code === "subtask_project_mismatch")).toBe(
      true,
    );
  });

  it("keeps unsupported statuses and metadata instead of coercing them into Agency running/review/done/accept", () => {
    const done = planOf(snapshot({ tasks: [task({ status: "done" })] }));
    expect(done.items[0]?.source.status).toBe("done");
    expect(done.items[0]?.proposed.jobState).toBe("backlog");
    expect(done.items[0]?.proposed.acceptArtifact).toBe(false);
    expect(done.createsAcceptedArtifacts).toBe(false);
    expect(done.items[0]?.blockers.map((row) => row.code)).toEqual(
      expect.arrayContaining(["done_is_not_agency_done", "done_is_not_accepted_artifact"]),
    );

    const working = planOf(
      snapshot({
        tasks: [
          task({
            status: "in_progress",
            priority: "none",
            dueDate: "2026-09-20",
            labelIds: [LABEL_1],
            key: "AG-12",
            number: 12,
          }),
        ],
        projects: [project({ prefix: "AG", nextTaskNumber: 13 })],
        labels: [{ id: LABEL_1, projectId: PROJECT_ID, name: "live", color: "red" }],
      }),
    );
    const item = working.items[0]!;
    expect(item.proposed.jobState).toBe("backlog");
    expect(item.proposed.assignedAgentId).toBeNull();
    expect(item.proposed.bindingId).toBeNull();
    expect(item.proposed.dueAt).toBeNull();
    expect(item.proposed.priority).toBeNull();
    expect(item.proposed.jobKey).toBe("AG-12");
    expect(item.blockers.some((row) => row.code === "in_progress_is_not_agency_running")).toBe(true);
    expect(item.unsupported.map((row) => row.field)).toEqual(
      expect.arrayContaining(["dueDate", "labelIds", "position", "priority", "status"]),
    );
    expect(item.preserved.labels[0]?.name).toBe("live");

    const review = planOf(snapshot({ tasks: [task({ status: "in_review", priority: "medium" })] }));
    expect(review.items[0]?.blockers.some((row) => row.code === "in_review_is_not_agency_review")).toBe(true);
    expect(review.items[0]?.unsupported.some((row) => row.field === "priority" && row.sourceValue === "medium")).toBe(true);

    const todo = planOf(snapshot({ tasks: [task({ status: "todo" })] }));
    expect(todo.items[0]?.blockers.some((row) => row.code === "todo_is_not_agency_queued")).toBe(true);

    const canceled = planOf(snapshot({ tasks: [task({ status: "canceled" })] }));
    expect(canceled.items[0]?.proposed.jobState).toBe("canceled");
    expect(canceled.items[0]?.unsupported.some((row) => row.field === "status")).toBe(false);
  });

  it("rejects extra keys and invalid ULIDs instead of stripping them", () => {
    const extra = planTasksImport({
      source: TASKS_PLUGIN_SOURCE,
      tasks: [{ ...task(), extra: "drop-me" }],
    });
    expect(extra.ok).toBe(false);
    if (extra.ok) throw new Error("expected invalid snapshot");
    expect(extra.error.code).toBe("invalid_snapshot");

    const badId = planTasksImport(snapshot({ tasks: [task({ id: "task_not_a_ulid" })] }));
    expect(badId.ok).toBe(false);
    if (badId.ok) throw new Error("expected invalid snapshot");
    expect(badId.error.code).toBe("invalid_snapshot");

    const blobPath = planTasksImport({
      source: TASKS_PLUGIN_SOURCE,
      tasks: [task()],
      attachments: [
        {
          id: ATTACH_1,
          taskId: TASK_1,
          commentId: null,
          fileName: "notes.md",
          mime: "text/markdown",
          sizeBytes: 1,
          isImage: false,
          createdAt: "2026-09-14T00:00:00.000Z",
          blobPath: "/secret/blob",
        },
      ],
    });
    expect(blobPath.ok).toBe(false);
  });

  it("does not treat an unused sibling as a parent cycle", () => {
    const planned = planOf(
      snapshot({
        tasks: [task(), task({ id: TASK_4, number: 4, key: "AGY-4", title: "Sibling" })],
      }),
    );
    expect(planned.applyOrder).toEqual([sourceTaskIdentity(TASK_1), sourceTaskIdentity(TASK_4)]);
    expect(planned.conflicts).toEqual([]);
  });
});
