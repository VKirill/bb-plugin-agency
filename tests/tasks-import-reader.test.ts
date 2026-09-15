import { describe, expect, it } from "vitest";
import {
  readTasksSnapshot,
  TASKS_PAGE_MAX_LIMIT,
  TASKS_PLUGIN_SOURCE,
  type TasksAttachment,
  type TasksComment,
  type TasksLabel,
  type TasksListTasksReadInput,
  type TasksProject,
  type TasksSnapshotReadPorts,
  type TasksTask,
  type TasksThread,
} from "../src/server/migration/tasks-import";

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const TASK_1 = "01HZZZZZZZZZZZZZZZZZZZZZT1";
const TASK_2 = "01HZZZZZZZZZZZZZZZZZZZZZT2";
const TASK_3 = "01HZZZZZZZZZZZZZZZZZZZZZT3";
const LABEL_1 = "01HZZZZZZZZZZZZZZZZZZZZZK1";
const COMMENT_1 = "01HZZZZZZZZZZZZZZZZZZZZZC1";
const ATTACH_TASK = "01HZZZZZZZZZZZZZZZZZZZZZA1";
const ATTACH_COMMENT = "01HZZZZZZZZZZZZZZZZZZZZZA2";
const THREAD_1 = "01HZZZZZZZZZZZZZZZZZZZZZH1";

function project(): TasksProject {
  return {
    id: PROJECT_ID,
    name: "Agency",
    prefix: "AGY",
    nextTaskNumber: 4,
    color: "#445566",
    folderId: null,
    linkedBbProjectId: "proj_ejbam66722",
    createdAt: "2026-09-14T00:00:00.000Z",
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
    labelIds: [LABEL_1],
    ...overrides,
  };
}

function label(): TasksLabel {
  return { id: LABEL_1, projectId: PROJECT_ID, name: "import", color: "blue" };
}

function comment(): TasksComment {
  return {
    id: COMMENT_1,
    taskId: TASK_1,
    kind: "user",
    authorName: "You",
    presetName: null,
    threadId: "thr_7ddibu9cnt",
    body: "Не отключать Tasks.",
    notifiedCount: 0,
    createdAt: "2026-09-14T11:00:00.000Z",
  };
}

function displayComment() {
  return {
    ...comment(),
    threadTitle: "Side chat",
    provider: {
      id: "claude-code",
      name: "Claude Code",
      logoUrl: null,
      icon: { glyph: "Sparkles" },
      strings: { iconTint: null },
    },
  };
}

function taskAttachment(): TasksAttachment {
  return {
    id: ATTACH_TASK,
    taskId: TASK_1,
    commentId: null,
    fileName: "notes.md",
    mime: "text/markdown",
    sizeBytes: 12,
    isImage: false,
    createdAt: "2026-09-14T11:01:00.000Z",
  };
}

function commentAttachment(): TasksAttachment {
  return {
    id: ATTACH_COMMENT,
    taskId: null,
    commentId: COMMENT_1,
    fileName: "clip.png",
    mime: "image/png",
    sizeBytes: 4,
    isImage: true,
    createdAt: "2026-09-14T11:01:30.000Z",
  };
}

function thread(): TasksThread {
  return {
    id: THREAD_1,
    taskId: TASK_1,
    threadId: "thr_2sgqe4rmmd",
    presetName: "Claude",
    title: "Worker",
    liveStatus: "idle",
    attachedAt: "2026-09-14T11:02:00.000Z",
    updatedAt: "2026-09-14T11:02:00.000Z",
  };
}

type Store = {
  tasks: TasksTask[];
  projects: TasksProject[];
  labels: TasksLabel[];
  comments: ReturnType<typeof displayComment>[];
  attachments: TasksAttachment[];
  threads: TasksThread[];
};

function pageTasks(tasks: readonly TasksTask[], input: TasksListTasksReadInput): { tasks: TasksTask[]; nextCursor: string | null } {
  const start = input.cursor === undefined ? 0 : Number(input.cursor);
  const slice = tasks.slice(start, start + input.limit);
  const next = start + input.limit;
  return {
    tasks: slice,
    nextCursor: next < tasks.length ? String(next) : null,
  };
}

function createPorts(store: Store, hooks?: { onListTasks?: (call: number, input: TasksListTasksReadInput) => void }): TasksSnapshotReadPorts & { listTasksCalls: TasksListTasksReadInput[] } {
  let listTasksCalls = 0;
  const calls: TasksListTasksReadInput[] = [];
  return {
    listTasksCalls: calls,
    listTasks(input) {
      listTasksCalls += 1;
      calls.push(input);
      hooks?.onListTasks?.(listTasksCalls, input);
      return pageTasks(store.tasks, input);
    },
    listProjects(input) {
      expect(input).toEqual({});
      return { projects: store.projects };
    },
    listLabels(input) {
      return { labels: store.labels.filter((row) => row.projectId === input.projectId) };
    },
    listComments(input) {
      return { comments: store.comments.filter((row) => row.taskId === input.taskId) };
    },
    listAttachments(input) {
      if ("taskId" in input) {
        return { attachments: store.attachments.filter((row) => row.taskId === input.taskId) };
      }
      return { attachments: store.attachments.filter((row) => row.commentId === input.commentId) };
    },
    listTaskThreads(input) {
      return { taskThreads: store.threads.filter((row) => row.taskId === input.taskId) };
    },
  };
}

const relatedStore = (): Store => ({
  tasks: [
    task(),
    task({
      id: TASK_2,
      number: 2,
      key: "AGY-2",
      title: "Подзадача",
      parentTaskId: TASK_1,
      position: 2,
      labelIds: [],
    }),
  ],
  projects: [project()],
  labels: [label()],
  comments: [displayComment()],
  attachments: [taskAttachment(), commentAttachment()],
  threads: [thread()],
});

describe("tasks-import reader", () => {
  const sourceChanged = {
    ok: false as const,
    error: { code: "source_changed", message: "optimistic_double_read_mismatch", retryable: true },
  };

  it("loads related projects, labels, comments, attachments and thread links from Tasks RPC shapes", async () => {
    const result = await readTasksSnapshot(createPorts(relatedStore()));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.source).toBe(TASKS_PLUGIN_SOURCE);
    expect(result.value.tasks.map((row) => row.id)).toEqual([TASK_1, TASK_2]);
    expect(result.value.projects).toEqual([project()]);
    expect(result.value.labels).toEqual([label()]);
    expect(result.value.comments).toEqual([comment()]);
    expect(result.value.comments[0]).not.toHaveProperty("threadTitle");
    expect(result.value.comments[0]).not.toHaveProperty("provider");
    expect(result.value.attachments.map((row) => row.id)).toEqual([ATTACH_TASK, ATTACH_COMMENT]);
    expect(result.value.threads).toEqual([thread()]);
  });

  it("follows listTasks nextCursor until null instead of stopping at the first page", async () => {
    const store = relatedStore();
    store.tasks = [
      task(),
      task({ id: TASK_2, number: 2, key: "AGY-2", title: "Two", labelIds: [] }),
      task({ id: TASK_3, number: 3, key: "AGY-3", title: "Three", labelIds: [] }),
    ];
    const ports = createPorts(store);
    const result = await readTasksSnapshot(ports, { pageLimit: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.tasks.map((row) => row.id)).toEqual([TASK_1, TASK_2, TASK_3]);
    const firstPass = ports.listTasksCalls.slice(0, 3);
    expect(firstPass).toEqual([
      { sort: "manual", limit: 1 },
      { sort: "manual", limit: 1, cursor: "1" },
      { sort: "manual", limit: 1, cursor: "2" },
    ]);
    expect(ports.listTasksCalls.length).toBe(6);
  });

  it("rejects port failure and unknown fields instead of returning an empty snapshot", async () => {
    const broken: TasksSnapshotReadPorts = {
      ...createPorts(relatedStore()),
      listComments() {
        throw new Error("token=sk-live-secret comments unavailable");
      },
    };
    const failed = await readTasksSnapshot(broken);
    expect(failed).toEqual({
      ok: false,
      error: { code: "list_comments_failed", message: "port_threw", retryable: false },
    });
    expect(JSON.stringify(failed)).not.toContain("sk-live-secret");
    expect(JSON.stringify(failed)).not.toContain("comments unavailable");

    const thrownText: TasksSnapshotReadPorts = {
      ...createPorts(relatedStore()),
      listComments() {
        throw "token=sk-live-secret";
      },
    };
    const textFailed = await readTasksSnapshot(thrownText);
    expect(textFailed).toEqual({
      ok: false,
      error: { code: "list_comments_failed", message: "port_threw", retryable: false },
    });
    expect(JSON.stringify(textFailed)).not.toContain("sk-live-secret");

    const extra: TasksSnapshotReadPorts = {
      ...createPorts(relatedStore()),
      listTasks() {
        return { tasks: [task({ labelIds: [] })], nextCursor: null, leaked: true };
      },
    };
    const unknown = await readTasksSnapshot(extra);
    expect(unknown.ok).toBe(false);
    if (unknown.ok) throw new Error("expected invalid_list_tasks");
    expect(unknown.error).toEqual({ code: "invalid_list_tasks", message: "schema_invalid", retryable: false });
    expect(JSON.stringify(unknown.error)).not.toContain("leaked");

    const blob: TasksSnapshotReadPorts = {
      ...createPorts(relatedStore()),
      listAttachments() {
        return {
          attachments: [{ ...taskAttachment(), blobPath: "/secret/blob" }],
        };
      },
    };
    const secret = await readTasksSnapshot(blob);
    expect(secret.ok).toBe(false);
    if (secret.ok) throw new Error("expected invalid attachments");
    expect(secret.error).toEqual({ code: "invalid_list_attachments", message: "schema_invalid", retryable: false });
    expect(JSON.stringify(secret.error)).not.toContain("blobPath");
    expect(JSON.stringify(secret.error)).not.toContain("/secret/blob");
  });

  it("rejects a changed task.updatedAt between two full reads", async () => {
    const store = relatedStore();
    const ports = createPorts(store, {
      onListTasks(call) {
        if (call === 2) {
          store.tasks = store.tasks.map((row) =>
            row.id === TASK_1 ? { ...row, updatedAt: "2026-09-14T12:00:00.000Z" } : row,
          );
        }
      },
    });
    const result = await readTasksSnapshot(ports, { pageLimit: 10 });
    expect(result).toEqual(sourceChanged);
  });

  it("rejects a comment body change that leaves task.updatedAt unchanged", async () => {
    const store = relatedStore();
    const ports = createPorts(store, {
      onListTasks(call) {
        if (call === 2) {
          store.comments = store.comments.map((row) => ({ ...row, body: "текст сменили без updatedAt" }));
        }
      },
    });
    const result = await readTasksSnapshot(ports, { pageLimit: 10 });
    expect(result).toEqual(sourceChanged);
    expect(store.tasks.every((row) => row.updatedAt === "2026-09-14T10:00:00.000Z")).toBe(true);
  });

  it("rejects an attachment rename that leaves task.updatedAt unchanged", async () => {
    const store = relatedStore();
    const ports = createPorts(store, {
      onListTasks(call) {
        if (call === 2) {
          store.attachments = store.attachments.map((row) =>
            row.id === ATTACH_TASK ? { ...row, fileName: "renamed.md" } : row,
          );
        }
      },
    });
    const result = await readTasksSnapshot(ports, { pageLimit: 10 });
    expect(result).toEqual(sourceChanged);
    expect(store.tasks.every((row) => row.updatedAt === "2026-09-14T10:00:00.000Z")).toBe(true);
  });

  it("rejects a project rename that leaves task.updatedAt unchanged", async () => {
    const store = relatedStore();
    const ports = createPorts(store, {
      onListTasks(call) {
        if (call === 2) {
          store.projects = store.projects.map((row) => ({ ...row, name: "Renamed without task touch" }));
        }
      },
    });
    const result = await readTasksSnapshot(ports, { pageLimit: 10 });
    expect(result).toEqual(sourceChanged);
    expect(store.tasks.every((row) => row.updatedAt === "2026-09-14T10:00:00.000Z")).toBe(true);
  });

  it("rejects a pageLimit above the Tasks RPC maximum", async () => {
    const result = await readTasksSnapshot(createPorts(relatedStore()), { pageLimit: TASKS_PAGE_MAX_LIMIT + 1 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid_page_limit");
    expect(result.error.code).toBe("invalid_page_limit");
  });
});
