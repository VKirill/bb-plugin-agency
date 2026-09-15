import { describe, expect, it } from "vitest";
import type { Job } from "../src/app/prototype/data";
import { jobEditCommit, jobEditDraftFrom } from "../src/app/data/job-edit-draft";
import { UNASSIGNED_AGENT } from "../src/app/data/job-placement";

const agents = [
  { id: "agt_writer01", name: "Анна" },
  { id: "agt_review01", name: "Марк" },
];

function makeJob(patch: Partial<Job> = {}): Job {
  return {
    id: "AG-2201",
    title: "Собрать калькулятор",
    state: "running",
    project: "BB-сервис",
    department: "Программисты",
    agent: "Анна",
    assignedAgentId: "agt_writer01",
    priority: "Обычный",
    due: "",
    description: "Описание",
    comments: [],
    ...patch,
  } as Job;
}

describe("job edit draft", () => {
  it("reads the live job into a draft", () => {
    const draft = jobEditDraftFrom(makeJob(), agents, false);
    expect(draft).toEqual({
      title: "Собрать калькулятор",
      description: "Описание",
      state: "running",
      assignee: "agt_writer01",
      priority: "Обычный",
      due: "",
    });
  });

  it("uses the agent name as assignee in demo mode", () => {
    expect(jobEditDraftFrom(makeJob(), agents, true).assignee).toBe("Анна");
  });

  it("commits nothing when the draft matches the job", () => {
    const job = makeJob();
    expect(jobEditCommit(jobEditDraftFrom(job, agents, false), job, agents, { demoMode: false, statusLocked: false })).toBeNull();
  });

  it("collects every changed field into one patch and one history line", () => {
    const job = makeJob();
    const draft = { ...jobEditDraftFrom(job, agents, false), title: " Новое имя ", priority: "Высокий", due: "2026-10-01" };
    const commit = jobEditCommit(draft, job, agents, { demoMode: false, statusLocked: false });
    expect(commit?.patch).toEqual({ title: "Новое имя", priority: "Высокий", due: "2026-10-01" });
    expect(commit?.summary).toContain("название");
    expect(commit?.summary).toContain("приоритет: Высокий");
    expect(commit?.summary).toContain("срок: 2026-10-01");
  });

  it("keeps the status when the lifecycle locked it", () => {
    const job = makeJob();
    const draft = { ...jobEditDraftFrom(job, agents, false), state: "done" as const };
    expect(jobEditCommit(draft, job, agents, { demoMode: false, statusLocked: true })).toBeNull();
    const open = jobEditCommit(draft, job, agents, { demoMode: false, statusLocked: false });
    expect(open?.patch.state).toBe("done");
  });

  it("maps a live assignee change to both id and name", () => {
    const job = makeJob();
    const draft = { ...jobEditDraftFrom(job, agents, false), assignee: "agt_review01" };
    const commit = jobEditCommit(draft, job, agents, { demoMode: false, statusLocked: false });
    expect(commit?.patch).toEqual({ assignedAgentId: "agt_review01", agent: "Марк" });
  });

  it("clears the assignee when nobody is picked", () => {
    const job = makeJob();
    const draft = { ...jobEditDraftFrom(job, agents, false), assignee: UNASSIGNED_AGENT };
    const commit = jobEditCommit(draft, job, agents, { demoMode: false, statusLocked: false });
    expect(commit?.patch).toEqual({ assignedAgentId: null, agent: "Не назначен" });
  });

  it("does not save a blank title", () => {
    const job = makeJob();
    const draft = { ...jobEditDraftFrom(job, agents, false), title: "   " };
    expect(jobEditCommit(draft, job, agents, { demoMode: false, statusLocked: false })).toBeNull();
  });
});
