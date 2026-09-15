/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Job } from "../src/app/prototype/data";
import { JobDetail } from "../src/app/prototype/job-detail";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRealtime: () => undefined,
  useBbNavigate: () => ({ toPluginPanel: () => undefined, experimental_openFilePreview: () => false }),
  useRpc: () => ({
    call: async () => ({ ok: true, value: {} }),
  }),
  Markdown: () => null,
  ThreadChat: () => null,
  experimental_useProviders: () => ({ providers: [] }),
  experimental_ProviderIcon: () => null,
  experimental_ProviderModelPicker: () => null,
}));

vi.mock("../src/app/prototype/document-panel", () => ({
  documentSessionId: "session",
  registerDocumentTarget: () => undefined,
  publishDocument: () => undefined,
  useDocumentVisible: () => false,
}));

function makeJob(id: string, title: string, state: Job["state"], agent: string, parentId?: string): Job {
  return {
    id,
    title,
    state,
    project: "BB-сервис",
    department: "Программисты",
    agent,
    priority: "Обычный",
    due: "",
    description: "Описание",
    comments: [],
    parentId,
  };
}

describe("JobDetail subtasks rendering", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders subtask rows with status icon on the left and assignee on the right", async () => {
    const parent = makeJob("AG-2201", "Разработка калькулятора", "review", "Fable");
    const sub1 = makeJob("AG-2202", "AG-2202: Реализация ядра", "done", "Sonnet", "AG-2201");
    const sub2 = makeJob("AG-2203", "Расчет расхода материалов", "running", "Opus", "AG-2201");
    const sub3 = makeJob("AG-2204", "Подготовка спецификации", "review", "Sonnet", "AG-2201");
    const jobs = [parent, sub1, sub2, sub3];

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    const props = {
      agents: [] as never[],
      projects: [],
      departments: [],
      jobs,
      update: () => undefined,
      addJob: () => undefined,
      openJob: () => undefined,
      back: () => undefined,
      notice: () => undefined,
      openRun: () => undefined,
      demoMode: true,
    };

    await act(async () => {
      root.render(createElement(JobDetail, { ...props, job: parent }) as ReactNode);
    });

    const subtaskSection = Array.from(container.querySelectorAll("section")).find(s =>
      s.textContent?.includes("Подзадачи")
    );
    expect(subtaskSection).toBeDefined();

    const buttons = subtaskSection!.querySelectorAll("button.flex.min-h-10");
    expect(buttons.length).toBe(3);

    // Row 1: sub1 (done)
    const btn1 = buttons[0];
    const icon1 = btn1.querySelector("span[data-icon], svg[data-icon]");
    expect(icon1?.getAttribute("data-icon") || icon1?.getAttribute("aria-label")).toBeTruthy();
    expect(btn1.textContent).toContain("AG-2202");
    expect(btn1.textContent).toContain("Реализация ядра");
    expect(btn1.textContent).not.toContain("AG-2202: AG-2202");
    expect(btn1.textContent).toContain("Sonnet · Готово");

    // Check that the status icon is the FIRST child inside the button
    expect(btn1.firstElementChild).toBe(icon1);

    // Row 2: sub2 (running)
    const btn2 = buttons[1];
    expect(btn2.textContent).toContain("AG-2203");
    expect(btn2.textContent).toContain("Расчет расхода материалов");
    expect(btn2.textContent).toContain("Opus · В работе");

    // Row 3: sub3 (review)
    const btn3 = buttons[2];
    expect(btn3.textContent).toContain("AG-2204");
    expect(btn3.textContent).toContain("Подготовка спецификации");
    expect(btn3.textContent).toContain("Sonnet · На проверке");

    await act(async () => {
      root.unmount();
    });
  });
});
