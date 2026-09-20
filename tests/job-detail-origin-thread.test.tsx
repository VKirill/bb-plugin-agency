/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Job } from "../src/app/prototype/data";
import { JobDetail } from "../src/app/prototype/job-detail";
import { JobWorkTimeline } from "../src/app/prototype/job-work-timeline";

const nav = vi.hoisted(() => ({
  toThread: vi.fn<(threadId: string) => void>(),
  enableToThread: true,
}));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRealtime: () => undefined,
  useBbNavigate: () => (nav.enableToThread ? { toThread: nav.toThread } : {}),
  useRpc: () => ({ call: async () => ({ ok: true, value: { activity: [], dependencies: [], artifacts: [], needsInput: null } }) }),
  Markdown: () => null,
  ThreadChat: (props: { threadId: string }) => createElement("div", { "data-testid": "thread-chat", "data-thread": props.threadId }),
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

const ORIGIN = "thr_originchat01";
const WORK = "thr_workattempt01";

const agents = [
  { id: "agt_lead0001", name: "Руководитель программистов — Fable" },
  { id: "agt_review001", name: "Проверяющий — Opus" },
] as never[];

const projects = [{ id: "bnd_one", name: "BB-сервис · plugins · MAC Mini", hostName: "MAC Mini", members: ["dep_dev"] }];
const departments = [{ id: "dep_dev", name: "Программисты", members: ["agt_lead0001", "agt_review001"], lead: "agt_lead0001" }];

function makeJob(extra: Partial<Job> = {}): Job {
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
    ...extra,
  } as Job;
}

function railRow(container: HTMLElement, label: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll(".agency-rail-row")).find(
    (node) => (node.querySelector(".agency-rail-label")?.textContent ?? "").startsWith(label),
  ) as HTMLElement | undefined;
}

function detailProps(job: Job, demoMode = false) {
  return {
    agents,
    projects,
    departments,
    job,
    jobs: [job],
    update: () => undefined,
    addJob: () => undefined,
    openJob: () => undefined,
    back: () => undefined,
    notice: () => undefined,
    openRun: () => undefined,
    demoMode,
  };
}

async function renderDetail(job: Job, demoMode = false) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(JobDetail, detailProps(job, demoMode)) as ReactNode);
  });
  return { container, root };
}

describe("JobDetail origin chat rail", () => {
  afterEach(() => {
    nav.toThread.mockReset();
    nav.enableToThread = true;
    document.body.innerHTML = "";
  });

  it("opens the origin thread from «Чат постановки», not the work thread", async () => {
    const job = makeJob({ originThreadId: ORIGIN });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement("div", null,
        createElement(JobDetail, detailProps(job)),
        createElement(JobWorkTimeline, { threadId: WORK }),
      ) as ReactNode);
    });

    const originRow = railRow(container, "Чат постановки");
    expect(originRow).toBeTruthy();
    const openChat = Array.from(originRow!.querySelectorAll("button")).find((node) => node.textContent === "Открыть чат");
    expect(openChat).toBeTruthy();
    await act(async () => {
      openChat?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(nav.toThread).toHaveBeenCalledTimes(1);
    expect(nav.toThread).toHaveBeenCalledWith(ORIGIN);

    const openWork = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "Открыть тред");
    expect(openWork).toBeTruthy();
    await act(async () => {
      openWork?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(nav.toThread.mock.calls.map((call) => call[0])).toEqual([ORIGIN, WORK]);

    await act(async () => { root.unmount(); });
  });

  it("hides «Чат постановки» when originThreadId is missing", async () => {
    const { container, root } = await renderDetail(makeJob());
    expect(railRow(container, "Чат постановки")).toBeUndefined();
    await act(async () => { root.unmount(); });
  });

  it("hides «Чат постановки» in demo mode even when origin is set", async () => {
    const { container, root } = await renderDetail(makeJob({ originThreadId: ORIGIN }), true);
    expect(railRow(container, "Чат постановки")).toBeUndefined();
    await act(async () => { root.unmount(); });
  });

  it("shows the origin id as text when toThread is unavailable", async () => {
    nav.enableToThread = false;
    const { container, root } = await renderDetail(makeJob({ originThreadId: ORIGIN }));
    const row = railRow(container, "Чат постановки");
    expect(row?.querySelector(".agency-rail-value")?.textContent).toBe(ORIGIN);
    expect(Array.from(row?.querySelectorAll("button") ?? []).some((node) => node.textContent === "Открыть чат")).toBe(false);
    await act(async () => { root.unmount(); });
  });
});
