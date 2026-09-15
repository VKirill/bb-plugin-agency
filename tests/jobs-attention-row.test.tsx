/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Job, State } from "../src/app/prototype/data";
import { JobsPage } from "../src/app/prototype/jobs";

function makeJob(id: string, state: State, hoursAgo: number, title = `Задача ${id}`): Job {
  return {
    id,
    title,
    state,
    sourceState: state,
    project: "BB-сервис",
    department: "Программисты",
    agent: "Fable",
    priority: "Высокий",
    due: "",
    description: "d",
    comments: [],
    updatedAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
  };
}

async function renderList(jobs: Job[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(JobsPage, {
      jobs,
      setJobs: () => undefined,
      open: () => undefined,
      initialView: "Список",
    }) as ReactNode);
  });
  return { container, root };
}

function row(container: HTMLElement, id: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((node) => node.textContent?.includes(id));
}

describe("jobs list attention marker", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("no longer spends the scan column on a priority arrow", async () => {
    const { container, root } = await renderList([makeJob("AG-1", "backlog", 1)]);
    const list = container.querySelector('[aria-label="Список задач по статусам"]') as HTMLElement;
    expect(list.querySelector('[aria-label^="Приоритет"]')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("marks how long a decision has been waiting on the person", async () => {
    const { container, root } = await renderList([makeJob("AG-10", "review", 3)]);
    const marked = row(container, "AG-10")?.querySelector('[aria-label*="Ждёт вашего решения"]');
    expect(marked?.textContent).toBe("3 ч");
    await act(async () => { root.unmount(); });
  });

  it("escalates a decision held for more than a day", async () => {
    const { container, root } = await renderList([makeJob("AG-11", "review", 30)]);
    const marked = row(container, "AG-11")?.querySelector('[aria-label*="Ждёт вашего решения"]') as HTMLElement;
    expect(marked.textContent).toBe("1 дн");
    expect(marked.className).toContain("amber");
    await act(async () => { root.unmount(); });
  });

  it("keeps agency-side work visible but quiet", async () => {
    const { container, root } = await renderList([makeJob("AG-12", "running", 2)]);
    const marked = row(container, "AG-12")?.querySelector('[aria-label*="Исполнитель работает"]') as HTMLElement;
    expect(marked.textContent).toBe("2 ч");
    expect(marked.className).toContain("text-muted-foreground");
    await act(async () => { root.unmount(); });
  });

  it("leaves finished rows unmarked", async () => {
    const { container, root } = await renderList([makeJob("AG-13", "done", 5)]);
    expect(row(container, "AG-13")?.querySelector("[aria-label]")).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("drops the В работе badge that only repeated its own section", async () => {
    const { container, root } = await renderList([makeJob("AG-14", "running", 1)]);
    const section = Array.from(container.querySelectorAll("section")).find((node) => node.getAttribute("aria-label") === "В работе");
    expect(section).toBeTruthy();
    expect(row(container, "AG-14")?.textContent).not.toContain("В работе");
    await act(async () => { root.unmount(); });
  });
});
