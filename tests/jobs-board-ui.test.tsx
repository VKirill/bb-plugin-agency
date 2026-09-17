/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Job, State } from "../src/app/prototype/data";
import { JobsPage } from "../src/app/prototype/jobs";

const HOUR = 60 * 60 * 1000;

function makeJob(id: string, state: State, options: { parentId?: string; closedHoursAgo?: number; title?: string } = {}): Job {
  const at = new Date(Date.now() - (options.closedHoursAgo ?? 0) * HOUR).toISOString();
  return {
    id,
    title: options.title ?? `Задача ${id}`,
    state,
    sourceState: state,
    project: "BB-сервис",
    department: "Программисты",
    agent: "Fable",
    priority: "Обычный",
    due: "",
    description: "d",
    comments: [],
    parentId: options.parentId,
    updatedAt: at,
    ...(state === "done" || state === "canceled" ? { closedAt: at } : {}),
  };
}

async function render(jobs: Job[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(JobsPage, { jobs, setJobs: () => undefined, open: () => undefined, initialView: "Список" }) as ReactNode);
  });
  return { container, root };
}

function rowOf(container: HTMLElement, id: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>("button[data-job-kind]")).find((node) => node.textContent?.startsWith(id));
}

describe("jobs board hierarchy and hygiene", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("marks main jobs bold with subtask progress and nests subtasks under them", async () => {
    const { container, root } = await render([
      makeJob("AG-19", "running", { title: "Самостоятельная" }),
      makeJob("AG-20", "running", { title: "AG-20 Главная работа" }),
      makeJob("AG-21", "running", { parentId: "AG-20" }),
      makeJob("AG-22", "done", { parentId: "AG-20", closedHoursAgo: 0.2 }),
    ]);
    const main = rowOf(container, "AG-20") as HTMLElement;
    expect(main.dataset.jobKind).toBe("main");
    expect(main.querySelector(".font-semibold")?.textContent).toBe("Главная работа");
    expect(main.textContent).toContain("1/2");
    const nested = rowOf(container, "AG-21") as HTMLElement;
    expect(nested.dataset.jobKind).toBe("subtask");
    // Same row grid; a subtask steps right inside the lead cell with the arrow before its key.
    expect(main.className).toBe(nested.className);
    const nestedKey = nested.querySelector(".agency-job-lead")?.firstElementChild as HTMLElement;
    expect(nestedKey.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    expect(nestedKey.textContent).toBe("AG-21");
    expect(nestedKey.className).toContain("pl-1");
    const mainKey = main.querySelector(".agency-job-lead")?.firstElementChild as HTMLElement;
    expect(mainKey.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(mainKey.className).not.toContain("pl-1");
    const section = container.querySelector('section[aria-label="В работе"]') as HTMLElement;
    expect(Array.from(section.querySelectorAll("button[data-job-kind]")).map((node) => node.textContent?.slice(0, 5))).toEqual(["AG-19", "AG-20", "AG-21"]);
    const single = rowOf(container, "AG-19") as HTMLElement;
    expect(single.dataset.jobKind).toBe("single");
    expect(single.querySelector(".font-semibold")).toBeNull();
    const separate = rowOf(container, "AG-22") as HTMLElement;
    expect(separate.textContent).toContain("AG-20");
    await act(async () => { root.unmount(); });
  });

  it("hides closed subtasks after an hour and shows them on request", async () => {
    const { container, root } = await render([
      makeJob("AG-30", "running"),
      makeJob("AG-31", "done", { parentId: "AG-30", closedHoursAgo: 2 }),
      makeJob("AG-32", "done", { closedHoursAgo: 2 }),
    ]);
    expect(rowOf(container, "AG-31")).toBeUndefined();
    expect(rowOf(container, "AG-32")).toBeTruthy();
    expect(container.textContent).toContain("Скрыто завершённых: 1");
    const toggle = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "Показать") as HTMLElement;
    await act(async () => { toggle.click(); });
    expect(rowOf(container, "AG-31")).toBeTruthy();
    await act(async () => { root.unmount(); });
  });
});
