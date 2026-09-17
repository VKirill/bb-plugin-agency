/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgencyApi } from "../src/app/data/agency-api";
import { persistJobPatch } from "../src/app/data/persist";
import { jobNeedsServerPatch } from "../src/app/data/job-record-patch";
import { addTeamAgentId, parseJobTeamRoles, removeTeamAgentId } from "../src/app/data/job-team";
import type { WorkspaceSnapshot } from "../src/app/data/snapshot";
import { mapDepartments, mapJobs } from "../src/app/data/view-models";
import { JobTeamBlock } from "../src/app/prototype/job-team";
import type { Job } from "../src/app/prototype/data";

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
    leadAgentId: "agt_writer01",
    processVersionId: "prc_editorial",
    revision: 1,
    updatedAt: "2026-09-14T00:00:00Z",
  }],
  agents: [
    {
      id: "agt_writer01",
      name: "Анна",
      state: "active",
      currentVersionId: "ver_writer01",
      revision: 1,
      updatedAt: "2026-09-14T00:00:00Z",
    },
    {
      id: "agt_review01",
      name: "Марк",
      state: "active",
      currentVersionId: "ver_review01",
      revision: 1,
      updatedAt: "2026-09-14T00:00:00Z",
    },
    {
      id: "agt_outside1",
      name: "Чужая",
      state: "active",
      currentVersionId: "ver_out00001",
      revision: 1,
      updatedAt: "2026-09-14T00:00:00Z",
    },
  ],
  jobs: [{
    id: "job_offer0001",
    key: "AG-102",
    bindingId: "bnd_project01",
    departmentId: "dep_editorial",
    title: "Подготовить оффер",
    brief: "Текст оффера",
    acceptance: "Файл приложен",
    state: "review",
    parentJobId: null,
    assignedAgentId: "agt_writer01",
    reviewerAgentIds: [],
    observerAgentIds: [],
    priority: "high",
    dueAt: "2026-09-18T00:00:00Z",
    revision: 3,
    updatedAt: "2026-09-14T00:00:00Z",
  }],
  counts: { review: 1 },
  memberships: [
    { departmentId: "dep_editorial", agentId: "agt_writer01", role: "lead" },
    { departmentId: "dep_editorial", agentId: "agt_review01", role: "executor" },
  ],
  agentVersions: [],
  processVersions: [],
  projectDepartments: [{ bindingId: "bnd_project01", departmentId: "dep_editorial" }],
  policies: [],
};

describe("job team role lists", () => {
  it("keeps empty reviewer/observer as empty, not invented names", () => {
    expect(parseJobTeamRoles({ reviewerAgentIds: [], observerAgentIds: [] })).toEqual({
      reviewerIds: [],
      watcherIds: [],
    });
    expect(addTeamAgentId([], "agt_review01")).toEqual(["agt_review01"]);
    expect(removeTeamAgentId(["agt_review01"], "agt_review01")).toEqual([]);
  });
});

describe("persistJobPatch team roles", () => {
  it("sends reviewer and observer ids with CAS revision", async () => {
    const [job] = mapJobs(snapshot);
    const calls: unknown[] = [];
    const api = {
      updateJob: async (input: unknown) => {
        calls.push(input);
        return { ok: true as const, value: snapshot.jobs[0] };
      },
    } as AgencyApi;
    const result = await persistJobPatch(api, snapshot, job!, {
      ...job!,
      reviewerAgentIds: ["agt_review01"],
      observerAgentIds: ["agt_writer01"],
    });
    expect(result).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({
      expectedRevision: 3,
      jobId: "job_offer0001",
      reviewerAgentIds: ["agt_review01"],
      observerAgentIds: ["agt_writer01"],
    });
    expect(jobNeedsServerPatch(job!, { ...job!, reviewerAgentIds: ["agt_review01"] })).toBe(true);
    expect(jobNeedsServerPatch(job!, { ...job!, reviewerAgentIds: [] })).toBe(false);
  });

  it("refuses an outsider without calling updateJob", async () => {
    const [job] = mapJobs(snapshot);
    const updateJob = vi.fn();
    const result = await persistJobPatch({ updateJob } as unknown as AgencyApi, snapshot, job!, {
      ...job!,
      reviewerAgentIds: ["agt_outside1"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toMatchObject({ kind: "domain", error: { code: "team_agent_not_member" } });
    expect(updateJob).not.toHaveBeenCalled();
  });

  it("does not send team ids when only title changes", async () => {
    const [job] = mapJobs(snapshot);
    const calls: Array<Record<string, unknown>> = [];
    const api = {
      updateJob: async (input: Record<string, unknown>) => {
        calls.push(input);
        return { ok: true as const, value: snapshot.jobs[0] };
      },
    } as unknown as AgencyApi;
    await persistJobPatch(api, snapshot, job!, { ...job!, title: "Другое" });
    expect(calls[0]).not.toHaveProperty("reviewerAgentIds");
    expect(calls[0]).not.toHaveProperty("observerAgentIds");
  });
});

describe("JobTeamBlock role pickers", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("selects, clears, keeps draft after persist error, and shows empty roles", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const job = mapJobs(snapshot)[0] as Job;
    const departments = mapDepartments(snapshot);
    const persisted: Array<{ reviewerAgentIds: string[]; observerAgentIds: string[] }> = [];
    let failNext = false;
    const persist = vi.fn(async (next: { reviewerAgentIds: string[]; observerAgentIds: string[] }) => {
      persisted.push(next);
      if (failNext) return false;
      return true;
    });
    const agents = [
      { id: "agt_writer01", name: "Анна", role: "Редактор" },
      { id: "agt_review01", name: "Марк", role: "Рецензент" },
    ];
    await act(async () => {
      root.render(createElement(JobTeamBlock, {
        job,
        agents,
        projects: [{ id: "bnd_project01", name: "SelfyStudio" }],
        departments,
        onPersistRoles: persist,
      }) as ReactNode);
    });
    expect(container.textContent).toContain("Не назначены");
    expect(container.textContent).toContain("Команда");
    expect(container.textContent).not.toContain("Статус задачи");
    expect(container.textContent).not.toContain("TEAM_ROLES_PENDING");

    const addReviewer = container.querySelector('select[aria-label="Добавить: проверяющего"]') as HTMLSelectElement | null;
    expect(addReviewer).toBeTruthy();
    await act(async () => {
      addReviewer!.value = "agt_review01";
      addReviewer!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(persist).toHaveBeenCalledWith({ reviewerAgentIds: ["agt_review01"], observerAgentIds: [] });
    expect(container.textContent).toContain("Марк");

    failNext = true;
    const clear = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "Очистить");
    await act(async () => {
      clear?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(persist.mock.calls.at(-1)?.[0]).toEqual({ reviewerAgentIds: [], observerAgentIds: [] });
    expect(container.textContent).toContain("Не назначены");

    failNext = true;
    // The assignee is not offered as a reviewer, so the picker empties and comes back as a new element.
    const addAgain = container.querySelector('select[aria-label="Добавить: проверяющего"]') as HTMLSelectElement | null;
    expect(addAgain?.textContent).not.toContain("Анна");
    await act(async () => {
      addAgain!.value = "agt_review01";
      addAgain!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(persist.mock.calls.at(-1)?.[0]).toEqual({ reviewerAgentIds: ["agt_review01"], observerAgentIds: [] });
    expect(container.textContent).toContain("Марк");
    await act(async () => { root.unmount(); });
  });

  it("shows canceled as current work and historical attempt only in details", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const job = { ...mapJobs(snapshot)[0], state: "canceled" as const, sourceState: "canceled" } as Job;
    await act(async () => {
      root.render(createElement(JobTeamBlock, {
        job,
        agents: [{ id: "agt_writer01", name: "Sonnet", role: "Исполнитель" }],
        projects: [{ id: "bnd_project01", name: "SelfyStudio" }],
        departments: mapDepartments(snapshot),
        attempt: { kind: "state", state: "awaiting_review" },
      }) as ReactNode);
    });
    const currentField = container.querySelector('[data-testid="job-team-block"]');
    const details = currentField?.querySelector("details");
    const withoutDetails = currentField?.textContent?.replace(details?.textContent ?? "", "") ?? "";
    expect(withoutDetails).toContain("Задача отменена");
    expect(withoutDetails).not.toContain("Ожидает проверки");
    expect(details?.textContent).toContain("Последний запуск не принят");
    expect(details?.textContent).toContain("Sonnet · Ожидает проверки");
    await act(async () => { root.unmount(); });
  });
});
