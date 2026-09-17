/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Job } from "../src/app/prototype/data";
import { JobsPage } from "../src/app/prototype/jobs";
import type { JobsArchiveApi } from "../src/app/prototype/jobs-archive";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const active: Job = {
  id: "AG-10",
  title: "Счёт за сентябрь",
  state: "running",
  sourceState: "running",
  project: "P",
  department: "D",
  agent: "A",
  priority: "Обычный",
  due: "",
  description: "d",
  comments: [],
};

function archiveApi(calls: string[]): JobsArchiveApi {
  return {
    searchJobs: async ({ query }) => {
      calls.push(`search:${query}`);
      return {
        ok: true,
        value: [
          { jobId: "job_10", key: "AG-10", title: "Счёт за сентябрь", state: "running", archived: false, field: "title", snippet: "Счёт за сентябрь" },
          { jobId: "job_2", key: "AG-2", title: "Старый отчёт", state: "done", archived: true, field: "comment", snippet: "приложен счёт" },
        ],
      };
    },
    listArchivedJobs: async ({ offset }) => {
      calls.push(`archive:${offset ?? 0}`);
      return {
        ok: true,
        value: {
          total: 1,
          jobs: [{ id: "job_2", key: "AG-2", title: "Старый отчёт", state: "done", departmentId: "dep_1", closedAt: "2026-07-01T00:00:00.000Z", parentJobId: null } as never],
        },
      };
    },
    listSavedViews: async () => ({ ok: true, value: [{ id: "view_1", name: "Готовые", filters: { filter: "done", q: "" }, updatedAt: "2026-09-17T00:00:00.000Z" }] }),
    saveSavedView: async (input) => ({ ok: true, value: { id: "view_2", name: input.name, filters: input.filters, updatedAt: "2026-09-17T00:00:00.000Z" } }),
    deleteSavedView: async () => ({ ok: true, value: { removed: true } }),
  };
}

async function render(api: JobsArchiveApi, opened: string[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(JobsPage, { jobs: [active], setJobs: () => undefined, open: (id) => opened.push(id), archive: { api, count: 1 } }) as ReactNode);
  });
  return { container, root };
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((node) => node.textContent?.includes(text));
  if (!found) throw new Error(`button ${text} not found`);
  return found as HTMLButtonElement;
}

describe("jobs board archive, server search and saved views", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens the archive list and an archived job from it", async () => {
    const calls: string[] = [];
    const opened: string[] = [];
    const { container, root } = await render(archiveApi(calls), opened);
    await act(async () => {
      button(container, "Архив · 1").click();
    });
    expect(calls).toContain("archive:0");
    expect(container.textContent).toContain("Старый отчёт");
    await act(async () => {
      button(container, "AG-2").click();
    });
    expect(opened).toEqual(["AG-2"]);
    await act(async () => root.unmount());
  });

  it("adds server hits that are not already on the board", async () => {
    const calls: string[] = [];
    const opened: string[] = [];
    const { container, root } = await render(archiveApi(calls), opened);
    const input = container.querySelector('input[aria-label="Поиск задач"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "счёт");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(calls).toContain("search:счёт");
    const hits = container.querySelector('section[aria-label="Ещё найдено"]');
    expect(hits?.textContent).toContain("AG-2");
    expect(hits?.textContent).toContain("архив");
    expect(hits?.textContent).not.toContain("AG-10");
    await act(async () => root.unmount());
  });

  it("offers saved views next to the filters", async () => {
    const { container, root } = await render(archiveApi([]), []);
    expect(container.querySelector('button[aria-label="Сохранённый вид"], [aria-label="Сохранённый вид"]')).toBeTruthy();
    expect(button(container, "Сохранить вид")).toBeTruthy();
    await act(async () => root.unmount());
  });
});
