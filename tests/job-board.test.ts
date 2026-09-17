import { describe, expect, it } from "vitest";
import type { Job, State } from "../src/app/prototype/data";
import {
  displayJobTitle,
  isHiddenFromBoard,
  orderByFamily,
  partitionBoard,
  subtaskProgress,
} from "../src/app/data/job-board";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-16T12:00:00.000Z");
const policy = { hideClosedSubtasksAfterHours: 1, hideClosedMainTasksAfterHours: 24 };

function job(id: string, state: State, options: { parentId?: string; closedHoursAgo?: number; title?: string } = {}): Job {
  const closedAt = options.closedHoursAgo === undefined ? undefined : new Date(NOW - options.closedHoursAgo * HOUR).toISOString();
  return {
    id,
    title: options.title ?? `Задача ${id}`,
    state,
    project: "BB-сервис",
    department: "Программисты",
    agent: "Fable",
    priority: "Обычный",
    due: "",
    description: "",
    comments: [],
    parentId: options.parentId,
    updatedAt: closedAt ?? new Date(NOW).toISOString(),
    ...(closedAt ? { closedAt } : {}),
  };
}

describe("board hiding", () => {
  it("hides a closed subtask after an hour and a closed main job after a day", () => {
    expect(isHiddenFromBoard(job("AG-2", "done", { parentId: "AG-1", closedHoursAgo: 0.5 }), policy, NOW)).toBe(false);
    expect(isHiddenFromBoard(job("AG-2", "done", { parentId: "AG-1", closedHoursAgo: 1 }), policy, NOW)).toBe(true);
    expect(isHiddenFromBoard(job("AG-3", "canceled", { parentId: "AG-1", closedHoursAgo: 2 }), policy, NOW)).toBe(true);
    expect(isHiddenFromBoard(job("AG-1", "done", { closedHoursAgo: 5 }), policy, NOW)).toBe(false);
    expect(isHiddenFromBoard(job("AG-1", "done", { closedHoursAgo: 25 }), policy, NOW)).toBe(true);
  });

  it("never hides open work and honours 0 as never", () => {
    expect(isHiddenFromBoard(job("AG-4", "review", { parentId: "AG-1", closedHoursAgo: 100 }), policy, NOW)).toBe(false);
    const keep = { hideClosedSubtasksAfterHours: 0, hideClosedMainTasksAfterHours: 0 };
    expect(isHiddenFromBoard(job("AG-2", "done", { parentId: "AG-1", closedHoursAgo: 1000 }), keep, NOW)).toBe(false);
  });

  it("splits the board without losing jobs", () => {
    const jobs = [job("AG-1", "running"), job("AG-2", "done", { parentId: "AG-1", closedHoursAgo: 3 })];
    const board = partitionBoard(jobs, policy, NOW);
    expect(board.visible.map((item) => item.id)).toEqual(["AG-1"]);
    expect(board.hidden.map((item) => item.id)).toEqual(["AG-2"]);
  });
});

describe("board order and titles", () => {
  it("keeps a family together and sorts keys as numbers", () => {
    const jobs = [
      job("AG-10", "backlog"),
      job("AG-2203", "done", { parentId: "AG-2201" }),
      job("AG-2", "backlog"),
      job("AG-2201", "done"),
      job("AG-2202", "canceled", { parentId: "AG-2201" }),
    ];
    expect(orderByFamily(jobs).map((item) => item.id)).toEqual(["AG-2", "AG-10", "AG-2201", "AG-2202", "AG-2203"]);
  });

  it("counts closed subtasks per main job", () => {
    const progress = subtaskProgress([
      job("AG-1", "running"),
      job("AG-2", "done", { parentId: "AG-1" }),
      job("AG-3", "canceled", { parentId: "AG-1" }),
      job("AG-4", "running", { parentId: "AG-1" }),
    ]);
    expect(progress.get("AG-1")).toEqual({ total: 3, closed: 2, done: 1 });
  });

  it("drops a key that repeats the key column", () => {
    expect(displayJobTitle(job("AG-2203", "done", { title: "AG-2203 Независимая проверка" }))).toBe("Независимая проверка");
    expect(displayJobTitle(job("AG-2203", "done", { title: "AG-2203: Проверка" }))).toBe("Проверка");
    expect(displayJobTitle(job("AG-1", "done", { title: "Проверить AG-1" }))).toBe("Проверить AG-1");
  });
});
