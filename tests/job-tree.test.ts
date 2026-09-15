import { describe, expect, it } from "vitest";
import { MAIN_JOB_LABEL, childProgressLabel, jobParentBreadcrumb, jobTree } from "../src/app/data/job-tree";
import type { Job } from "../src/app/prototype/data";

function job(id: string, title: string, parentId?: string): Job {
  return {
    id,
    title,
    state: "backlog",
    project: "BB-сервис",
    department: "Программисты",
    agent: "Fable",
    priority: "Обычный",
    due: "",
    description: "",
    comments: [],
    parentId,
  };
}

describe("job tree window", () => {
  const root = job("AG-2201", "Калькулятор для отдела программистов");
  const child = job("AG-2202", "Проверка формул сложения", "AG-2201");
  const other = job("AG-2203", "Тесты умножения", "AG-2201");
  const jobs = [root, child, other];

  it("marks the hierarchy root and keeps readable titles", () => {
    const tree = jobTree(jobs, child);
    expect(tree.job.id).toBe("AG-2201");
    expect(tree.job.title).toContain("Калькулятор");
    expect(tree.children.map((node) => node.job.id)).toEqual(["AG-2202", "AG-2203"]);
    expect(MAIN_JOB_LABEL).toBe("Главная задача");
  });

  it("builds a parent breadcrumb for a child, not a key-only path", () => {
    expect(jobParentBreadcrumb(jobs, root)).toEqual([]);
    const crumb = jobParentBreadcrumb(jobs, child);
    expect(crumb).toHaveLength(1);
    expect(crumb[0]?.id).toBe("AG-2201");
    expect(crumb[0]?.title).not.toMatch(/^AG-22/);
  });

  it("labels terminal children without a success fraction", () => {
    expect(childProgressLabel([
      { state: "done" },
      { state: "done" },
      { state: "done" },
      { state: "canceled" },
    ])).toBe("3 готово · 1 отменена");
    expect(childProgressLabel([{ state: "done" }, { state: "done" }, { state: "canceled" }, { state: "canceled" }])).not.toMatch(/\d\/\d/);
  });
});
