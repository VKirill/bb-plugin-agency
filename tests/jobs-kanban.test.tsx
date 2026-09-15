/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Job } from "../src/app/prototype/data";
import { JobsPage } from "../src/app/prototype/jobs";
import { WAITING_INPUT_STATUS_NOTICE } from "../src/app/data/job-lifecycle";

const waiting: Job = {
  id: "AG-1607",
  title: "Wait",
  state: "waiting_input",
  sourceState: "waiting_input",
  project: "P",
  department: "D",
  agent: "A",
  priority: "Обычный",
  due: "",
  description: "d",
  comments: [],
};

describe("kanban waiting_input guard", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not persist a drop out of waiting_input", async () => {
    const persisted: Job[] = [];
    const notices: string[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(JobsPage, {
        jobs: [waiting],
        setJobs: () => undefined,
        open: () => undefined,
        persist: (job) => { persisted.push(job); },
        notice: (text) => { notices.push(text); },
        initialView: "Канбан",
      }) as ReactNode);
    });
    const board = container.querySelector('[data-testid="jobs-kanban"]');
    expect(board).toBeTruthy();
    const card = Array.from(board!.querySelectorAll("button")).find((node) => node.textContent?.includes("AG-1607"));
    expect(card?.getAttribute("draggable")).toBe("false");
    const drop = Array.from(board!.querySelectorAll("section")).find((node) => node.getAttribute("aria-label") === "Готово");
    await act(async () => {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { getData: () => "AG-1607" } });
      drop?.dispatchEvent(event);
    });
    expect(persisted).toEqual([]);
    expect(notices).toContain(WAITING_INPUT_STATUS_NOTICE);
    await act(async () => { root.unmount(); });
  });
});
