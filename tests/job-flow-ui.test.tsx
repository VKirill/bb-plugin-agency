/** @vitest-environment happy-dom */
import { describe, expect, it } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { dependencyCandidates, JobFlowDialog, JobFlowSection, nextStepStatus } from "../src/app/prototype/job-flow";
import type { Job } from "../src/app/prototype/data";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const job = (id: string, recordId: string, extra: Partial<Job> = {}): Job =>
  ({ id, recordId, title: `Задача ${id}`, state: "backlog", project: "Сайт", department: "Разработка", agent: "", priority: "Обычный", due: "", description: "", comments: [], bindingId: "bnd_a", ...extra }) as Job;

const main = job("AG-1", "job_main");
const design = job("AG-2", "job_design", { parentId: "AG-1", state: "done" });
const page = job("AG-3", "job_page", { parentId: "AG-1" });
const elsewhere = job("AG-4", "job_other", { bindingId: "bnd_b" });
const test = job("AG-5", "job_test", { parentId: "AG-1", bindingId: "bnd_b" });
const jobs = [main, design, page, elsewhere, test];

async function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return { container, root };
}

describe("order of work in the job card", () => {
  it("offers jobs of the same folder or tree only", () => {
    const links = { waitsFor: [{ jobId: "job_design", key: "AG-2", title: "Макет", state: "done" }], blocks: [] };
    expect(dependencyCandidates(page, jobs, links).map((item) => item.id)).toEqual(["AG-1", "AG-5"]);
  });

  it("says what happened to the next step", () => {
    const step = { departmentId: "dep_qa", title: "Проверить", brief: "Б", acceptance: "К", assignment: "lead" as const };
    expect(nextStepStatus({ step, createdJobId: null, outcome: null, updatedAt: "" }, jobs).text).toBe("создастся, когда задача будет готова");
    expect(nextStepStatus({ step, createdJobId: "job_test", outcome: "created", updatedAt: "" }, jobs)).toEqual({ text: "создана AG-5", key: "AG-5" });
    expect(nextStepStatus({ step, createdJobId: null, outcome: "create_failed: Отдел не подключён", updatedAt: "" }, jobs)).toEqual({ text: "не создана: Отдел не подключён", warn: true });
  });

  it("shows waiting jobs and the next step, and stays out of the way when there is nothing", async () => {
    const opened: string[] = [];
    const empty = await mount(createElement(JobFlowSection, { job: page, jobs, links: { waitsFor: [], blocks: [] }, nextStep: null, departments: [], openJob: () => undefined }));
    expect(empty.container.textContent).toBe("");
    await act(async () => empty.root.unmount());

    const { container, root } = await mount(
      createElement(JobFlowSection, {
        job: page,
        jobs,
        links: {
          waitsFor: [
            { jobId: "job_design", key: "AG-2", title: "Макет", state: "done" },
            { jobId: "job_other", key: "AG-4", title: "Тексты", state: "running" },
          ],
          blocks: [],
        },
        nextStep: { step: { departmentId: "dep_qa", title: "Проверить в браузере", brief: "Б", acceptance: "К", assignment: "lead" }, createdJobId: "job_test", outcome: "created", updatedAt: "" },
        departments: [{ id: "dep_qa", name: "Тестирование" }],
        openJob: (id: string) => opened.push(id),
        onEdit: () => undefined,
      }),
    );
    expect(container.textContent).toContain("До запуска должны быть готовы · ждёт 1");
    expect(container.textContent).toContain("Следующий шаг: Проверить в браузере · Тестирование");
    await act(async () => (container.querySelector('[data-testid="job-next-step"]') as HTMLElement).click());
    expect(opened).toEqual(["AG-5"]);
    await act(async () => root.unmount());
  });

  it("adds and removes a dependency and saves the next step through the API", async () => {
    const calls: [string, unknown][] = [];
    const api = {
      addJobDependency: async (input: unknown) => (calls.push(["add", input]), { ok: true as const, value: { jobId: "job_page", dependsOnJobId: "job_main" } }),
      removeJobDependency: async (input: unknown) => (calls.push(["remove", input]), { ok: true as const, value: { removed: true } }),
      setJobNextStep: async (input: unknown) => (calls.push(["step", input]), { ok: true as const, value: null }),
    };
    const notices: string[] = [];
    let changed = 0;
    const { root } = await mount(
      createElement(JobFlowDialog, {
        open: true,
        onOpenChange: () => undefined,
        job: page,
        jobs,
        links: { waitsFor: [{ jobId: "job_design", key: "AG-2", title: "Макет", state: "done" }], blocks: [] },
        nextStep: { step: { departmentId: "dep_qa", title: "Проверить", brief: "Пройти сценарий.", acceptance: "Отчёт.", assignment: "lead" }, createdJobId: null, outcome: null, updatedAt: "" },
        departments: [{ id: "dep_qa", name: "Тестирование" }],
        api,
        notice: (text: string) => notices.push(text),
        onChanged: () => (changed += 1),
      }),
    );
    const button = (label: string) => Array.from(document.querySelectorAll("button")).find((item) => item.textContent === label || item.getAttribute("aria-label") === label) as HTMLButtonElement;
    await act(async () => button("Убрать зависимость от AG-2").click());
    await act(async () => button("Сохранить шаг").click());
    await act(async () => button("Убрать шаг").click());
    expect(calls).toEqual([
      ["remove", { jobId: "job_page", dependsOnJobId: "job_design" }],
      ["step", { jobId: "job_page", step: { departmentId: "dep_qa", assignment: "lead", title: "Проверить", brief: "Пройти сценарий.", acceptance: "Отчёт." } }],
      ["step", { jobId: "job_page", step: null }],
    ]);
    expect(notices).toEqual(["Зависимость убрана.", "Следующий шаг сохранён.", "Следующий шаг убран."]);
    expect(changed).toBe(3);
    await act(async () => root.unmount());
  });
});
