/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Job } from "../src/app/prototype/data";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({ features: { projectFolders: true, fileGateway: true } }));
const rpc = vi.hoisted(() => ({
  call: async (method: string) =>
    method === "listPlugins"
      ? { ok: true, value: { plugins: [], features: state.features } }
      : { ok: true, value: { activity: [], dependencies: [], artifacts: [], needsInput: null } },
}));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRealtime: () => undefined,
  useBbNavigate: () => ({ toPluginPanel: () => undefined, experimental_openFilePreview: () => false }),
  useRpc: () => rpc,
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

const { JobDetail } = await import("../src/app/prototype/job-detail");
const { resetPluginFeaturesCache } = await import("../src/app/prototype/use-plugin-features");

const agents = [
  { id: "agt_lead0001", name: "Руководитель", workplaceBindingId: undefined },
  { id: "agt_tester01", name: "Тестировщик", workplaceBindingId: "bnd_desk" },
] as never[];
const projects = [
  { id: "bnd_ovh", recordId: "bnd_ovh", name: "Сайт", hostName: "OVH", bbProjectId: "proj_site", members: [] },
  { id: "bnd_mini", recordId: "bnd_mini", name: "Сайт", hostName: "Mac mini", bbProjectId: "proj_site", members: [] },
  { id: "bnd_desk", recordId: "bnd_desk", name: "Рабочее место · Mac mini", hostName: "Mac mini", bbProjectId: "proj_desk", members: [] },
];
const departments = [{ id: "dep_qa", name: "Проверка", lead: "agt_lead0001", members: ["agt_lead0001", "agt_tester01"], memberRoles: { agt_tester01: "executor" as const } }];

function job(): Job {
  return { id: "AG-10", recordId: "job_10", title: "Сайт", state: "running", project: "Сайт", department: "Проверка", agent: "Руководитель", assignedAgentId: "agt_lead0001", bindingId: "bnd_ovh", departmentId: "dep_qa", priority: "Обычный", due: "", description: "Бриф", comments: [] } as Job;
}

async function open(addJob: (job: Job) => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(JobDetail, { agents, projects, departments, job: job(), jobs: [job()], update: () => undefined, addJob, openJob: () => undefined, back: () => undefined, notice: () => undefined, openRun: () => undefined, demoMode: false }) as ReactNode);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const add = Array.from(container.querySelectorAll("button")).find((node) => /подзадач/i.test(node.getAttribute("aria-label") ?? node.textContent ?? ""));
  await act(async () => add?.click());
  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = "";
  resetPluginFeaturesCache();
});

describe("subtask placement form", () => {
  it("offers another folder of the project only with Projects & Sections", async () => {
    state.features = { projectFolders: true, fileGateway: false };
    const { root } = await open(() => undefined);
    expect(document.body.textContent).toContain("Папка проекта");
    await act(async () => root.unmount());
    resetPluginFeaturesCache();
    state.features = { projectFolders: false, fileGateway: false };
    const second = await open(() => undefined);
    expect(document.body.textContent).not.toContain("Папка проекта");
    await act(async () => second.root.unmount());
  });

  it("routes a subtask for an employee with a workplace to that folder", async () => {
    state.features = { projectFolders: false, fileGateway: true };
    const created: Job[] = [];
    const { root } = await open((next) => {
      created.push(next);
    });
    const note = document.querySelector('[data-testid="child-workplace"]');
    expect(note?.textContent).toContain("Рабочее место · Mac mini");
    await act(async () => root.unmount());
  });
});
