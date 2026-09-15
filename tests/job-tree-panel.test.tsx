/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JobTreePanel } from "../src/app/prototype/job-tree";
import type { Job } from "../src/app/prototype/data";

function job(id: string, title: string, parentId?: string): Job {
  return {
    id,
    title,
    state: "review",
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

async function mount(current: Job, jobs: Job[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(JobTreePanel, {
      job: current,
      jobs,
      dependencies: [],
      openJob: () => undefined,
    }) as ReactNode);
  });
  return { container, root };
}

describe("JobTreePanel rows", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const rootJob = job("AG-2201", "Калькулятор для отдела программистов");
  const child = job("AG-2202", "Проверка формул сложения", "AG-2201");
  const jobs = [rootJob, child];

  it("shows a two-level row: key and wrapping title, then status and agent", async () => {
    const { container, root } = await mount(rootJob, jobs);
    const current = container.querySelector('[data-testid="job-tree-current"]');
    expect(current?.textContent).toContain("Главная задача");
    expect(current?.querySelector(".agency-task-tree-row-key")?.textContent).toBe("AG-2201");
    expect(current?.querySelector(".agency-task-tree-row-title")?.textContent).toBe("Калькулятор для отдела программистов");
    expect(current?.textContent).toContain("На проверке");
    expect(current?.textContent).toContain("Fable");
    expect(container.querySelector('[data-testid="job-tree-breadcrumb"]')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("shows a parent breadcrumb on a child instead of key-only repeats", async () => {
    const { container, root } = await mount(child, jobs);
    const crumb = container.querySelector('[data-testid="job-tree-breadcrumb"]');
    expect(crumb?.textContent).toContain("Главная задача");
    expect(crumb?.textContent).not.toMatch(/AG-2201 AG-2201 AG-2201/);
    expect(container.querySelector('[data-testid="job-tree-current"]')?.querySelector(".agency-task-tree-row-title")?.textContent)
      .toBe("Проверка формул сложения");
    await act(async () => { root.unmount(); });
  });

  it("strips leading duplicate job ID from the title row", async () => {
    const duplicatedTitleChild = job("AG-2203", "AG-2203: Рефакторинг калькулятора", "AG-2201");
    const { container, root } = await mount(duplicatedTitleChild, [rootJob, duplicatedTitleChild]);
    const current = container.querySelector('[data-testid="job-tree-current"]');
    expect(current?.querySelector(".agency-task-tree-row-key")?.textContent).toBe("AG-2203");
    expect(current?.querySelector(".agency-task-tree-row-title")?.textContent).toBe("Рефакторинг калькулятора");
    await act(async () => { root.unmount(); });
  });
});
