/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Job } from "../src/app/prototype/data";
import { JobDetail } from "../src/app/prototype/job-detail";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRealtime: () => undefined,
  useBbNavigate: () => ({ toPluginPanel: () => undefined, experimental_openFilePreview: () => false }),
  useRpc: () => ({ call: async () => ({ ok: true, value: { activity: [], dependencies: [], artifacts: [], needsInput: null } }) }),
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

const agents = [
  { id: "agt_lead0001", name: "Руководитель программистов — Fable" },
  { id: "agt_review001", name: "Проверяющий — Opus" },
] as never[];

const projects = [{ id: "bnd_one", name: "BB-сервис · plugins · MAC Mini", hostName: "MAC Mini", members: ["dep_dev"] }];
const departments = [{ id: "dep_dev", name: "Программисты", members: ["agt_lead0001", "agt_review001"], lead: "agt_lead0001" }];

function makeJob(): Job {
  return {
    id: "AG-2201",
    title: "Создать калькулятор",
    state: "done",
    project: "BB-сервис",
    department: "Программисты",
    agent: "Руководитель программистов — Fable",
    assignedAgentId: "agt_lead0001",
    reviewerAgentIds: ["agt_review001"],
    bindingId: "bnd_one",
    departmentId: "dep_dev",
    priority: "Высокий",
    due: "",
    description: "Описание",
    comments: [],
  } as Job;
}

async function renderRail() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(JobDetail, {
      agents,
      projects,
      departments,
      job: makeJob(),
      jobs: [makeJob()],
      update: () => undefined,
      addJob: () => undefined,
      openJob: () => undefined,
      back: () => undefined,
      notice: () => undefined,
      openRun: () => undefined,
      demoMode: false,
    }) as ReactNode);
  });
  return { container, root };
}

function cardTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".agency-rail-card-title")).map((node) => node.textContent ?? "");
}

function railRow(container: HTMLElement, label: string): string {
  const row = Array.from(container.querySelectorAll(".agency-rail-row")).find(
    (node) => node.querySelector(".agency-rail-label")?.textContent === label,
  );
  return row?.querySelector(".agency-rail-value")?.textContent ?? "";
}

describe("JobDetail rail", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("states team, parameters, files and runtime as read-only cards", async () => {
    const { container, root } = await renderRail();
    expect(cardTitles(container)).toEqual([
      "Команда",
      "Параметры",
      "Файлы (0)",
      "Среда запуска",
      "Иерархия и связи",
    ]);
    expect(railRow(container, "Руководитель")).toBe("Fable");
    expect(railRow(container, "Исполнитель")).toBe("Fable");
    expect(railRow(container, "Проверяющий")).toBe("Opus");
    expect(railRow(container, "Проект")).toBe("BB-сервис");
    expect(railRow(container, "Отдел")).toBe("Программисты");
    expect(railRow(container, "Приоритет")).toBe("Высокий");
    expect(railRow(container, "Срок")).toBe("не задан");
    expect(railRow(container, "Хост")).toBe("MAC Mini");
    await act(async () => { root.unmount(); });
  });

  it("keeps form controls out of the rail", async () => {
    const { container, root } = await renderRail();
    const rail = container.querySelector(".agency-task-sidebar-content") as HTMLElement;
    // The only input left is the hidden file field behind "+ Добавить".
    expect(rail.querySelectorAll("select, [role=combobox], input:not([type=file])").length).toBe(0);
    expect(rail.querySelectorAll('input[type=file]').length).toBe(1);
    await act(async () => { root.unmount(); });
  });

  it("opens the edit dialog with the properties the rail no longer edits", async () => {
    const { container, root } = await renderRail();
    const edit = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "Редактировать");
    await act(async () => {
      edit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const dialog = document.querySelector('[data-testid="job-edit-dialog"]');
    expect(dialog).toBeTruthy();
    const text = dialog?.textContent ?? "";
    for (const label of ["Название", "Описание и критерии", "Статус", "Приоритет", "Исполнитель", "Срок", "Проект и отдел"]) {
      expect(text).toContain(label);
    }
    await act(async () => { root.unmount(); });
  });
});
