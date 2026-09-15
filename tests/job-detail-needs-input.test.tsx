/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { NeedsInputRecord } from "../src/shared/contracts";
import type { Job } from "../src/app/prototype/data";
import { JobDetail } from "../src/app/prototype/job-detail";

const domainHandlers = new Set<() => void>();
let getJobNeeds: NeedsInputRecord | null = null;

const waitOne: NeedsInputRecord = {
  waitId: "11111111-1111-4111-8111-111111111111",
  jobId: "job_cc1b3e9080f8afeae6f740e9",
  attemptId: "run_7ddd0085a99e0056d91c1b3f",
  launchId: "c039b6a8-d2d5-4af8-8820-4b51c5e9a38c",
  threadId: "thr_x42m4bjg5h",
  requestId: "22222222-2222-4222-8222-222222222222",
  questions: [{
    id: "ASK_CYCLE_ONE",
    text: "Подтвердите ASK_CYCLE_ONE",
    sourceRefs: [{ kind: "job_brief", id: "job_cc1b3e9080f8afeae6f740e9" }],
  }],
  bodyHash: "a".repeat(64),
  jobState: "waiting_input",
  attemptState: "waiting_input",
  jobRevision: 4,
  attemptRevision: 4,
};

const waitTwo: NeedsInputRecord = {
  ...waitOne,
  waitId: "60ee60fd-9919-5feb-8548-cd4c1cac152b",
  requestId: "9d2bd33f-2d25-4e7f-be2d-4a28e784b2a5",
  questions: [{
    id: "ASK_CYCLE_TWO",
    text: "Подтвердите ASK_CYCLE_TWO: разрешено опубликовать notes/qa-answer-two-cycles-1610.md",
    sourceRefs: [{ kind: "job_brief", id: "job_cc1b3e9080f8afeae6f740e9" }],
  }],
  bodyHash: "3fecc437c495f1fd93c2b210fd0ec4755b43668792a87b7bf4ece04aa86b3a38",
  jobRevision: 6,
  attemptRevision: 6,
};

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRealtime: (channel: string, handler: () => void) => {
    if (channel === "domain-changed") domainHandlers.add(handler);
  },
  useBbNavigate: () => ({ toPluginPanel: () => undefined, experimental_openFilePreview: () => false }),
  useRpc: () => ({
    call: async (method: string) => {
      if (method === "getJob") {
        return {
          ok: true,
          value: {
            job: {
              id: "job_cc1b3e9080f8afeae6f740e9",
              key: "AG-1610",
              bindingId: "bnd_776dd73696628ee2a29e099c",
              departmentId: "dep_3822ce03533d177e43f5bd7a",
              title: "QA — два reportNeedsInput",
              brief: "Brief",
              acceptance: "Accept",
              state: getJobNeeds ? "waiting_input" : "running",
              parentJobId: null,
              assignedAgentId: "agt_b1fe6a357a7e8736a896c649",
              priority: "normal",
              dueAt: null,
              revision: getJobNeeds?.jobRevision ?? 5,
              updatedAt: "2026-09-14T09:29:04.937Z",
            },
            binding: {
              id: "bnd_776dd73696628ee2a29e099c",
              bbProjectId: "proj_7e4gc9rb6t",
              environmentId: "env_6y2ryp88u3",
              hostId: "host_j9p6y79cyt",
              canonicalRoot: "/tmp",
              policyVersionId: "pol_fb82860d6360eaffd7602d54",
              sectionId: null,
              revision: 1,
              updatedAt: "2026-09-14T05:07:25.983Z",
            },
            activity: [],
            dependencies: [],
            artifacts: [],
            needsInput: getJobNeeds,
          },
        };
      }
      throw new Error("unknown rpc method");
    },
  }),
  Markdown: () => null,
  ThreadChat: () => null,
  experimental_useProviders: () => ({ providers: [] }),
  experimental_ProviderIcon: () => null,
}));

vi.mock("../src/app/prototype/document-panel", () => ({
  documentSessionId: "session",
  registerDocumentTarget: () => undefined,
  publishDocument: () => undefined,
  useDocumentVisible: () => false,
}));

function cardJob(revision: number, state: Job["state"]): Job {
  return {
    id: "AG-1610",
    recordId: "job_cc1b3e9080f8afeae6f740e9",
    title: "QA — два reportNeedsInput",
    state,
    sourceState: state,
    revision,
    project: "BB-сервис",
    department: "Редакция",
    agent: "Анна",
    priority: "Обычный",
    due: "",
    description: "d",
    comments: [],
  };
}

describe("JobDetail needsInput refresh", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    domainHandlers.clear();
    getJobNeeds = null;
  });

  it("clears the form after confirmed null, then shows the second wait on the same card", async () => {
    const notices: string[] = [];
    getJobNeeds = waitOne;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const props = {
      agents: [] as never[],
      projects: [],
      departments: [],
      jobs: [],
      update: () => undefined,
      addJob: () => undefined,
      openJob: () => undefined,
      back: () => undefined,
      notice: (text: string) => { notices.push(text); },
      openRun: () => undefined,
      demoMode: false,
    };
    await act(async () => {
      root.render(createElement(JobDetail, { ...props, job: cardJob(4, "waiting_input") }) as ReactNode);
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="needs-input-panel"]')?.textContent).toContain("ASK_CYCLE_ONE");
    });
    getJobNeeds = null;
    await act(async () => {
      for (const handler of domainHandlers) handler();
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="needs-input-panel"]')).toBeNull();
    });
    notices.push("Ответ принят. Исполнитель продолжает ту же работу.");
    getJobNeeds = waitTwo;
    await act(async () => {
      root.render(createElement(JobDetail, { ...props, job: cardJob(6, "waiting_input") }) as ReactNode);
    });
    await act(async () => {
      for (const handler of domainHandlers) handler();
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="needs-input-panel"]')?.textContent).toContain("ASK_CYCLE_TWO");
    });
    expect(container.textContent).not.toContain("ASK_CYCLE_ONE");
    expect(notices.at(-1)).toBe("");
    await act(async () => { root.unmount(); });
  });
});
