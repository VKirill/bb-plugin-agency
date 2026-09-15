/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgencyApi } from "../src/app/data/agency-api";
import type { IsolationReadiness, LaunchCoordinatorView, LaunchReceiptView, PrepareLaunchView, RunAttemptView } from "../src/app/data/launch-rpc";
import { LAUNCH_RPC_UNREGISTERED } from "../src/app/data/launch-rpc";
import type { WorkspaceSnapshot } from "../src/app/data/snapshot";
import { mapJobs } from "../src/app/data/view-models";
import { JobLaunchPanel } from "../src/app/prototype/job-launch-panel";

let domainChanged: ((payload: unknown) => void) | undefined;

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRealtime: (channel: string, handler: (payload: unknown) => void) => {
    if (channel === "domain-changed") domainChanged = handler;
  },
  experimental_useProviders: () => ({ providers: [] }),
  experimental_ProviderIcon: () => null,
  ThreadChat: (props: { threadId: string }) => createElement("div", { "data-testid": "thread-chat", "data-thread": props.threadId }),
  useBbNavigate: () => ({ toThread: () => undefined }),
}));

const snapshot: WorkspaceSnapshot = {
  contractVersion: "agency.domain.stage1.v1",
  isolation: { catalogSkillsIsolated: false, catalogMcpIsolated: false, execution: "unavailable", reason: "closed" },
  bindings: [{
    id: "bnd_project01",
    bbProjectId: "proj_selfy",
    bbProjectName: "SelfyStudio",
    environmentName: "локально",
    hostName: "Mac mini",
    environmentId: "env_local",
    hostId: "host_mini",
    canonicalRoot: "/agency/selfy",
    policyVersionId: "pol_default1",
    sectionId: null,
    revision: 1,
    updatedAt: "2026-09-14T00:00:00Z",
  }],
  departments: [{
    id: "dep_editorial",
    name: "Редакция",
    leadAgentId: "agt_b1fe6a357a7e8736a896c649",
    processVersionId: "prc_editorial",
    revision: 1,
    updatedAt: "2026-09-14T00:00:00Z",
  }],
  agents: [{
    id: "agt_b1fe6a357a7e8736a896c649",
    name: "Анна",
    state: "active",
    currentVersionId: "ver_writer01",
    revision: 1,
    updatedAt: "2026-09-14T00:00:00Z",
  }],
  jobs: [{
    id: "job_2de115e5c5e8bd8b555a71a3",
    key: "AG-1604",
    bindingId: "bnd_project01",
    departmentId: "dep_editorial",
    title: "Live start",
    brief: "Brief",
    acceptance: "Done",
    state: "backlog",
    parentJobId: null,
    assignedAgentId: "agt_b1fe6a357a7e8736a896c649",
    priority: "normal",
    dueAt: null,
    revision: 5,
    updatedAt: "2026-09-14T00:00:00Z",
  }],
  counts: { backlog: 1 },
  memberships: [{ departmentId: "dep_editorial", agentId: "agt_b1fe6a357a7e8736a896c649", role: "member" }],
  agentVersions: [{
    id: "ver_writer01",
    agentId: "agt_b1fe6a357a7e8736a896c649",
    version: 1,
    role: "Редактор",
    instructions: "Править тексты.",
    providerId: "claude",
    model: "opus",
    skillIds: [],
    mcpIds: [],
    policyVersionId: "pol_default1",
  }],
  processVersions: [],
  projectDepartments: [{ bindingId: "bnd_project01", departmentId: "dep_editorial" }],
  policies: [],
};

const readyReadiness: IsolationReadiness = {
  handshakeReady: true,
  executionAvailable: true,
  isolationReady: true,
  isolatedSpawnFields: true,
  sdkTypedSpawnReady: true,
  provenIsolationProviders: ["claude"],
  assignedProvider: {
    jobId: "job_2de115e5c5e8bd8b555a71a3",
    agentId: "agt_b1fe6a357a7e8736a896c649",
    agentVersionId: "ver_writer01",
    providerId: "claude",
    source: "live_assigned_agent_version",
  },
  launchAllowedForAssigned: true,
  reason: "ready",
};

function launchApi(prepare: AgencyApi["prepareLaunch"]): AgencyApi {
  return {
    getIsolationReadiness: async () => ({ ok: true as const, value: readyReadiness }),
    listJobAttempts: async () => ({ ok: true as const, value: [] }),
    getLaunch: async () => ({ ok: false as const, failure: { kind: "domain", error: { code: "not_found", message: "нет" } } }),
    prepareLaunch: prepare,
  } as unknown as AgencyApi;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountPanel(api: AgencyApi, notices: string[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const job = mapJobs(snapshot)[0];
  await act(async () => {
    root.render(createElement(JobLaunchPanel, {
      job,
      api,
      notice: (text: string) => { notices.push(text); },
      openRun: () => undefined,
      onChanged: () => undefined,
    }) as ReactNode);
    await Promise.resolve();
  });
  await flush();
  return { container, root, job };
}

describe("JobLaunchPanel mapped click", () => {
  afterEach(async () => {
    domainChanged = undefined;
    document.body.innerHTML = "";
  });

  it("clicks Запустить on mapped Job, calls prepareLaunch, keeps RPC error after domain-changed", async () => {
    const calls: unknown[] = [];
    const notices: string[] = [];
    const api = launchApi(async (input) => {
      calls.push(input);
      return { ok: false, failure: { kind: "unavailable", message: LAUNCH_RPC_UNREGISTERED } };
    });
    const { container, root, job } = await mountPanel(api, notices);
    const button = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "Запустить");
    expect(button).toBeTruthy();
    expect(button?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      jobId: job.recordId,
      expectedRevision: 5,
    });
    const outcome = container.querySelector('[data-testid="launch-outcome"]');
    expect(outcome?.textContent).toBe(LAUNCH_RPC_UNREGISTERED);
    expect(notices.at(-1)).toBe(LAUNCH_RPC_UNREGISTERED);

    await act(async () => {
      domainChanged?.({});
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="launch-outcome"]')?.textContent).toBe(LAUNCH_RPC_UNREGISTERED);
    await act(async () => { root.unmount(); });
  });

  it("disables Сверить публикацию when job is waiting_input", async () => {
    const interpret = vi.fn();
    const api = {
      getIsolationReadiness: async () => ({ ok: true as const, value: readyReadiness }),
      listJobAttempts: async () => ({
        ok: true as const,
        value: [{
          attempt: {
            attemptId: "run_wait01",
            jobId: "job_2de115e5c5e8bd8b555a71a3",
            attemptNo: 1,
            snapshotId: "snp",
            digest: "a".repeat(64),
            threadId: "thr_x",
            launchId: "11111111-1111-4111-8111-111111111111",
            state: "waiting_input",
            reportedState: "waiting_input",
            revision: 2,
          },
          receipt: { launchId: "11111111-1111-4111-8111-111111111111" },
        }],
      }),
      getLaunch: async () => ({
        ok: true as const,
        value: { launchId: "11111111-1111-4111-8111-111111111111", needsReconciliation: false },
      }),
      interpretWorkerCompletion: interpret,
    } as unknown as AgencyApi;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const job = { ...mapJobs(snapshot)[0], state: "waiting_input" as const, sourceState: "waiting_input" };
    await act(async () => {
      root.render(createElement(JobLaunchPanel, {
        job,
        api,
        notice: () => undefined,
        openRun: () => undefined,
        needsInput: true,
      }) as ReactNode);
    });
    await flush();
    const button = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "Сверить публикацию");
    expect(button?.hasAttribute("disabled")).toBe(true);
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(interpret).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });

  it("hides ready hint and job-state guard while attempt is active, keeps outcome after refresh", async () => {
    const notices: string[] = [];
    const startedAttempt: RunAttemptView = {
      attemptId: "run_started01",
      jobId: "job_2de115e5c5e8bd8b555a71a3",
      attemptNo: 1,
      snapshotId: "snp",
      digest: "d".repeat(64),
      threadId: "thr_started01",
      launchId: "11111111-1111-4111-8111-111111111111",
      state: "running",
      reportedState: "running",
      revision: 6,
    };
    const startedReceipt: LaunchReceiptView = {
      launchId: "11111111-1111-4111-8111-111111111111",
      attemptId: startedAttempt.attemptId,
      jobId: startedAttempt.jobId,
      snapshotId: startedAttempt.snapshotId,
      digest: startedAttempt.digest,
      threadId: "thr_started01",
      spawnKind: "spawned",
      persistError: null,
      jobBindState: "bound",
      needsReconciliation: false,
    };
    const startedLaunch: LaunchCoordinatorView = {
      kind: "running",
      attempt: startedAttempt,
      receipt: startedReceipt,
    };
    const startedPrepare: PrepareLaunchView = {
      handshakeReady: true,
      snapshotId: startedAttempt.snapshotId,
      digest: startedAttempt.digest,
      attemptId: startedAttempt.attemptId,
      launched: startedLaunch,
      reason: "verified bind applied",
      reasonCode: "ok",
    };
    const api = launchApi(async () => ({
      ok: true,
      value: startedPrepare,
    }));
    const { container, root } = await mountPanel(api, notices);
    const button = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "Запустить");
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="launch-outcome"]')?.textContent).toBe("Запуск начат");
    expect(container.querySelector('[data-testid="last-launch-outcome"]')).toBeNull();
    expect(container.querySelector("details")?.textContent).toMatch(/prepareLaunch|verified bind applied/);
    await act(async () => {
      domainChanged?.({});
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="launch-outcome"]')?.textContent).toBe("Запуск начат");
    await act(async () => { root.unmount(); });
  });

  it("embeds exact attempt thread and fails closed on receipt mismatch", async () => {
    const matching = {
      getIsolationReadiness: async () => ({ ok: true as const, value: readyReadiness }),
      listJobAttempts: async () => ({
        ok: true as const,
        value: [{
          attempt: {
            attemptId: "run_live01",
            jobId: "job_2de115e5c5e8bd8b555a71a3",
            attemptNo: 1,
            snapshotId: "snp",
            digest: "a".repeat(64),
            threadId: "thr_exact_run",
            launchId: "11111111-1111-4111-8111-111111111111",
            state: "running",
            reportedState: "running",
            revision: 2,
          },
          receipt: { launchId: "11111111-1111-4111-8111-111111111111", threadId: "thr_exact_run" },
        }],
      }),
      getLaunch: async () => ({
        ok: true as const,
        value: { launchId: "11111111-1111-4111-8111-111111111111", threadId: "thr_exact_run", needsReconciliation: false },
      }),
      prepareLaunch: async () => ({ ok: false as const, failure: { kind: "unavailable" as const, message: "no" } }),
    } as unknown as AgencyApi;
    const { container, root, job } = await mountPanel(matching, []);
    const running = { ...job, state: "running" as const, sourceState: "running" };
    await act(async () => {
      root.render(createElement(JobLaunchPanel, {
        job: running,
        api: matching,
        notice: () => undefined,
        openRun: () => undefined,
      }) as ReactNode);
    });
    await flush();
    expect(container.querySelector('[data-testid="thread-chat"]')?.getAttribute("data-thread")).toBe("thr_exact_run");
    expect(container.textContent).not.toContain("Готово к запуску");
    expect(container.textContent).not.toContain("Запуск доступен из бэклога");
    expect(container.querySelector("dl")?.textContent).not.toContain("run_live01");
    expect(container.querySelector("dl")?.textContent).not.toContain("thr_exact_run");

    const mismatch = {
      ...matching,
      listJobAttempts: async () => ({
        ok: true as const,
        value: [{
          attempt: {
            attemptId: "run_live02",
            jobId: "job_2de115e5c5e8bd8b555a71a3",
            attemptNo: 2,
            snapshotId: "snp",
            digest: "b".repeat(64),
            threadId: "thr_attempt_only",
            launchId: "22222222-2222-4222-8222-222222222222",
            state: "running",
            reportedState: "running",
            revision: 3,
          },
          receipt: { launchId: "22222222-2222-4222-8222-222222222222", threadId: "thr_receipt_other" },
        }],
      }),
      getLaunch: async () => ({
        ok: true as const,
        value: { launchId: "22222222-2222-4222-8222-222222222222", threadId: "thr_receipt_other", needsReconciliation: false },
      }),
    } as unknown as AgencyApi;
    await act(async () => {
      root.render(createElement(JobLaunchPanel, {
        job: running,
        api: mismatch,
        notice: () => undefined,
        openRun: () => undefined,
      }) as ReactNode);
    });
    await flush();
    expect(container.querySelector('[data-testid="thread-chat"]')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("shows environment readiness only in backlog or queued", async () => {
    const api = launchApi(async () => ({ ok: false as const, failure: { kind: "unavailable" as const, message: "no" } }));
    const notices: string[] = [];
    const { container, root, job } = await mountPanel(api, notices);
    expect(container.textContent).toContain("Готово к запуску");
    const launch = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "Запустить");
    expect(launch?.hasAttribute("disabled")).toBe(false);

    for (const state of ["review", "done"] as const) {
      await act(async () => {
        root.render(createElement(JobLaunchPanel, {
          job: { ...job, state, sourceState: state },
          api,
          notice: () => undefined,
          openRun: () => undefined,
        }) as ReactNode);
      });
      await flush();
      expect(container.textContent).not.toContain("Готово к запуску");
      expect(container.textContent).not.toContain("Запуск доступен из бэклога");
      const stillLaunch = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "Запустить");
      expect(stillLaunch?.hasAttribute("disabled")).toBe(true);
    }

    await act(async () => {
      root.render(createElement(JobLaunchPanel, {
        job: { ...job, state: "queued", sourceState: "queued" },
        api,
        notice: () => undefined,
        openRun: () => undefined,
      }) as ReactNode);
    });
    await flush();
    expect(container.textContent).toContain("Готово к запуску");
    await act(async () => { root.unmount(); });
  });

  it("treats canceled job as closed and keeps historical awaiting_review out of current work", async () => {
    const interpret = vi.fn();
    const api = {
      getIsolationReadiness: async () => ({ ok: true as const, value: readyReadiness }),
      listJobAttempts: async () => ({
        ok: true as const,
        value: [{
          attempt: {
            attemptId: "run_hist01",
            jobId: "job_2de115e5c5e8bd8b555a71a3",
            attemptNo: 1,
            snapshotId: "snp",
            digest: "a".repeat(64),
            threadId: "thr_hist01",
            launchId: "11111111-1111-4111-8111-111111111111",
            state: "awaiting_review",
            reportedState: "awaiting_review",
            revision: 6,
          },
          receipt: { launchId: "11111111-1111-4111-8111-111111111111", threadId: "thr_hist01" },
        }],
      }),
      getLaunch: async () => ({
        ok: true as const,
        value: { launchId: "11111111-1111-4111-8111-111111111111", threadId: "thr_hist01", needsReconciliation: false },
      }),
      interpretWorkerCompletion: interpret,
    } as unknown as AgencyApi;
    const notices: string[] = [];
    const { container, root, job } = await mountPanel(api, notices);
    await act(async () => {
      root.render(createElement(JobLaunchPanel, {
        job: { ...job, state: "canceled" as const, sourceState: "canceled" },
        api,
        notice: () => undefined,
        openRun: () => undefined,
      }) as ReactNode);
    });
    await flush();
    expect(container.querySelector('[data-testid="job-launch-current"]')?.textContent).toBe("Задача отменена");
    expect(container.querySelector("dl")?.textContent).not.toContain("Состояние: Ожидает проверки");
    expect(container.textContent).toContain("Последний запуск не принят");
    expect(container.querySelector("details")?.textContent).toContain("awaiting_review");
    const interpretBtn = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "Сверить публикацию");
    expect(interpretBtn?.hasAttribute("disabled")).toBe(true);
    await act(async () => {
      interpretBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(interpret).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("можно на review");
    await act(async () => { root.unmount(); });
  });
});
