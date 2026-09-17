import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { fail, ok } from "../src/domain";
import { resolveAlias } from "../src/server/cli/aliases";
import { openMigratedDatabase } from "../src/server/db";
import { assertDependenciesDone, dependencyLinks, readNextStep, removeJobDependency, saveNextStep, sweepNextSteps, type NextStepPorts } from "../src/server/flow/service";
import { WAIT_CODES } from "../src/server/runtime/launch-queue/service";
import { createJobCommandSchema, type Job } from "../src/shared/contracts/job";
import { seed } from "./role-types.test";

const NOW = "2026-09-17T12:00:00.000Z";

function setup() {
  const db = openMigratedDatabase(new Database(":memory:"));
  const s = seed(db);
  const job = (title: string, extra: Record<string, unknown> = {}) => {
    const created = s.store.createJob(
      s.ctx,
      createJobCommandSchema.parse({ requestId: randomUUID(), bindingId: s.ctx.allowedBindingIds[0], departmentId: s.departmentId, title, brief: "Бриф.", acceptance: "Критерий.", assignedAgentId: s.developer, ...extra }),
    );
    if (!created.ok) throw new Error(created.error.message);
    return created.value;
  };
  const setState = (item: Job, state: string) => db.prepare(`UPDATE agency_job SET state = ? WHERE id = ?`).run(state, item.id);
  const depend = (item: Job, on: Job) => {
    const added = s.store.addJobDependency(s.ctx, { requestId: randomUUID(), jobId: item.id, dependsOnJobId: on.id });
    if (!added.ok) throw new Error(added.error.message);
  };
  return { db, s, job, setState, depend };
}

const STEP = { departmentId: "", title: "Проверить в браузере", brief: "Пройти сценарий на принятой версии.", acceptance: "Отчёт со скриншотами." };

describe("job dependencies", () => {
  it("hold a launch until every dependency is done and stop it when one is canceled", () => {
    const { db, job, setState, depend } = setup();
    const design = job("Макет");
    const copy = job("Тексты");
    const page = job("Вёрстка");
    depend(page, design);
    depend(page, copy);

    const waiting = assertDependenciesDone(db, page, false);
    expect(waiting.ok).toBe(false);
    if (waiting.ok) return;
    expect(waiting.error.code).toBe("dependencies_open");
    expect(waiting.error.message).toContain(design.key);
    expect(WAIT_CODES.has(waiting.error.code)).toBe(true);

    setState(design, "done");
    setState(copy, "done");
    expect(assertDependenciesDone(db, page, false).ok).toBe(true);

    setState(copy, "canceled");
    const canceled = assertDependenciesDone(db, page, true);
    expect(canceled.ok || canceled.error.code).toBe("dependency_canceled");
    expect(canceled.ok || WAIT_CODES.has(canceled.error.code)).toBe(false);
  });

  it("shows both directions and can be removed", () => {
    const { db, job, depend } = setup();
    const design = job("Макет");
    const page = job("Вёрстка");
    depend(page, design);
    expect(dependencyLinks(db, page.id).waitsFor.map((link) => link.key)).toEqual([design.key]);
    expect(dependencyLinks(db, design.id).blocks.map((link) => [link.key, link.title, link.state])).toEqual([[page.key, "Вёрстка", page.state]]);
    expect(removeJobDependency(db, page.id, design.id)).toBe(true);
    expect(removeJobDependency(db, page.id, design.id)).toBe(false);
    expect(assertDependenciesDone(db, page, false).ok).toBe(true);
  });

  it("is reachable from the CLI", () => {
    expect(resolveAlias(["job", "depend"])).toBe("addJobDependency");
    expect(resolveAlias(["job", "undepend"])).toBe("removeJobDependency");
    expect(resolveAlias(["job", "next-step"])).toBe("setJobNextStep");
  });
});

describe("next step", () => {
  function ports(ctx: ReturnType<typeof setup>, overrides: Partial<NextStepPorts> = {}) {
    const comments: [string, string][] = [];
    const queued: string[] = [];
    const base: NextStepPorts = {
      db: ctx.db,
      getJob: (id) => ctx.s.store.getJob(id),
      createJob: (source, step) =>
        ctx.s.store.createJob(ctx.s.ctx, {
          requestId: randomUUID(),
          bindingId: source.bindingId,
          departmentId: step.departmentId,
          title: step.title,
          brief: step.brief,
          acceptance: step.acceptance,
          parentJobId: source.parentJobId,
          assignedAgentId: null,
          assignment: step.assignment,
          priority: source.priority,
          dueAt: null,
        }),
      attachAccepted: async () => ok(2),
      queue: (item) => {
        queued.push(item.id);
        return ok(item.id);
      },
      comment: (item, text) => {
        comments.push([item.key, text]);
      },
      now: () => NOW,
      en: () => false,
      ...overrides,
    };
    return { base, comments, queued };
  }

  it("creates the follow-up job next to the done one, once, for the department lead", async () => {
    const ctx = setup();
    const parent = ctx.job("Лендинг");
    const build = ctx.job("Сверстать", { parentJobId: parent.id });
    const saved = saveNextStep(ctx.db, build, { ...STEP, departmentId: ctx.s.departmentId }, NOW, false);
    expect(saved.ok && saved.value?.step.assignment).toBe("lead");

    const run = ports(ctx);
    expect(await sweepNextSteps(run.base)).toEqual([]);

    ctx.setState(build, "done");
    const created = await sweepNextSteps(run.base);
    expect(created).toHaveLength(1);
    const view = readNextStep(ctx.db, build.id);
    expect(view?.outcome).toBe("created");
    const next = ctx.s.store.getJob(view?.createdJobId ?? "");
    expect(next).toMatchObject({ title: STEP.title, parentJobId: parent.id, bindingId: build.bindingId, assignedAgentId: ctx.s.lead });
    expect(run.queued).toEqual([next?.id]);
    expect(run.comments.find(([key]) => key === build.key)?.[1]).toBe(`Следующий шаг: создана ${next?.key}, приложено принятых версий: 2, поставлена в очередь запуска.`);
    expect(run.comments.find(([key]) => key === next?.key)?.[1]).toContain(`после готовности ${build.key}`);

    expect(await sweepNextSteps(run.base)).toEqual([]);
    const locked = saveNextStep(ctx.db, build, null, NOW, true);
    expect(locked.ok || locked.error.code).toBe("next_step_done");
  });

  it("drops the step of a canceled job and reports a failed create on the source", async () => {
    const ctx = setup();
    const canceled = ctx.job("Отменённая");
    const failing = ctx.job("Не создаётся");
    saveNextStep(ctx.db, canceled, { ...STEP, departmentId: ctx.s.departmentId }, NOW, false);
    saveNextStep(ctx.db, failing, { ...STEP, departmentId: ctx.s.departmentId }, NOW, false);
    ctx.setState(canceled, "canceled");
    ctx.setState(failing, "done");
    const run = ports(ctx, { createJob: () => fail("department_unavailable", "Отдел не подключён к проекту") });
    expect(await sweepNextSteps(run.base)).toEqual([]);
    expect(readNextStep(ctx.db, canceled.id)?.outcome).toBe("source_canceled");
    expect(readNextStep(ctx.db, failing.id)?.outcome).toBe("create_failed: Отдел не подключён к проекту");
    expect(run.comments).toEqual([[failing.key, "Следующий шаг не создан: Отдел не подключён к проекту"]]);
  });

  it("names what did not work on the new job: inputs and queue", async () => {
    const ctx = setup();
    const source = ctx.job("Исследование");
    saveNextStep(ctx.db, source, { ...STEP, departmentId: ctx.s.departmentId, assignment: "executor" }, NOW, true);
    ctx.setState(source, "done");
    const run = ports(ctx, {
      en: () => true,
      attachAccepted: async () => fail("host_offline", "machine is offline"),
      queue: () => fail("illegal_job_state", "not in backlog"),
    });
    const [key] = await sweepNextSteps(run.base);
    expect(run.comments.find(([item]) => item === source.key)?.[1]).toBe(`Next step: created ${key}.`);
    expect(run.comments.find(([item]) => item === key)?.[1]).toBe(
      `Created as the next step after ${source.key} was done.\nInputs were not attached: machine is offline\nNot queued for launch: not in backlog`,
    );
  });

  it("is not set on a closed job", () => {
    const ctx = setup();
    const closed = ctx.job("Закрыта");
    ctx.setState(closed, "done");
    const refused = saveNextStep(ctx.db, ctx.s.store.getJob(closed.id)!, { ...STEP, departmentId: ctx.s.departmentId }, NOW, false);
    expect(refused.ok || refused.error.code).toBe("job_closed");
  });
});
