import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { listJobsForBindings } from "../src/server/api/catalog";
import { createJobCommandSchema, updateJobCommandSchema, workKindSchema } from "../src/shared/contracts/job";
import { seed } from "./role-types.test";

function setup() {
  const db = openMigratedDatabase(new Database(":memory:"));
  const s = seed(db);
  return { db, s };
}

function create(s: ReturnType<typeof seed>, extra: Record<string, unknown> = {}) {
  return s.store.createJob(
    s.ctx,
    createJobCommandSchema.parse({
      requestId: randomUUID(),
      bindingId: s.ctx.allowedBindingIds[0],
      departmentId: s.departmentId,
      title: extra.title ?? "Задача",
      brief: "Бриф.",
      acceptance: "Критерий.",
      assignedAgentId: extra.assignedAgentId ?? s.developer,
      ...extra,
    }),
  );
}

describe("Job.workKind", () => {
  it("stores the field, defaults to null, and rejects an unknown value", () => {
    expect(workKindSchema.parse("feature")).toBe("feature");
    expect(workKindSchema.safeParse("hotfix").success).toBe(false);
    expect(createJobCommandSchema.safeParse({
      requestId: randomUUID(),
      bindingId: "binding_aaaaaaaa",
      departmentId: "departme_aaaaaaaa",
      title: "Карточка",
      brief: "Собрать.",
      acceptance: "Текст принят.",
      workKind: "unknown",
    }).success).toBe(false);

    const { db, s } = setup();
    const withKind = create(s, { title: "С видом", workKind: "feature" });
    expect(withKind.ok && withKind.value.workKind).toBe("feature");
    expect(s.store.getJob(withKind.ok ? withKind.value.id : "")?.workKind).toBe("feature");
    expect(listJobsForBindings(db, s.ctx.allowedBindingIds).find((job) => job.id === (withKind.ok ? withKind.value.id : ""))?.workKind).toBe("feature");

    const omitted = create(s, { title: "Без вида" });
    expect(omitted.ok && (omitted.value.workKind ?? null)).toBeNull();
    expect(s.store.getJob(omitted.ok ? omitted.value.id : "")?.workKind).toBeNull();
    expect(listJobsForBindings(db, s.ctx.allowedBindingIds).find((job) => job.id === (omitted.ok ? omitted.value.id : ""))?.workKind).toBeNull();
  });

  it("lets update set workKind and lets anyone raise it to new-program", () => {
    const { s } = setup();
    const created = create(s, { title: "Поставить вид" });
    if (!created.ok) throw new Error(created.error.message);
    const updated = s.store.updateJob(s.ctx, {
      requestId: randomUUID(),
      expectedRevision: created.value.revision,
      jobId: created.value.id,
      workKind: "bugfix",
    });
    expect(updated.ok && updated.value.workKind).toBe("bugfix");
    expect(s.store.getJob(created.value.id)?.workKind).toBe("bugfix");

    const raised = s.store.updateJob(
      {
        ...s.ctx,
        caller: { threadId: "thr_workkind01", attemptId: "run_workkind01", jobId: created.value.id, agentId: s.developer },
      },
      {
        requestId: randomUUID(),
        expectedRevision: updated.ok ? updated.value.revision : created.value.revision,
        jobId: created.value.id,
        workKind: "new-program",
      },
    );
    expect(raised.ok && raised.value.workKind).toBe("new-program");
  });

  it("blocks an agent from lowering new-program and lets the owner do it", () => {
    const { s } = setup();
    const created = create(s, { title: "Новая программа", workKind: "new-program" });
    if (!created.ok) throw new Error(created.error.message);
    expect(updateJobCommandSchema.safeParse({
      requestId: randomUUID(),
      expectedRevision: 1,
      jobId: created.value.id,
      workKind: "feature",
    }).success).toBe(true);

    const agentCtx = {
      ...s.ctx,
      caller: { threadId: "thr_workkind02", attemptId: "run_workkind02", jobId: created.value.id, agentId: s.developer },
    };
    const denied = s.store.updateJob(agentCtx, {
      requestId: randomUUID(),
      expectedRevision: created.value.revision,
      jobId: created.value.id,
      workKind: "feature",
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("expected work_kind_owner_only");
    expect(denied.error.code).toBe("work_kind_owner_only");
    expect(denied.error.message).toMatch(/owner|владелец/i);
    expect(s.store.getJob(created.value.id)?.workKind).toBe("new-program");

    const clearedByAgent = s.store.updateJob(agentCtx, {
      requestId: randomUUID(),
      expectedRevision: created.value.revision,
      jobId: created.value.id,
      workKind: null,
    });
    expect(clearedByAgent.ok).toBe(false);
    if (clearedByAgent.ok) throw new Error("expected work_kind_owner_only");
    expect(clearedByAgent.error.code).toBe("work_kind_owner_only");

    const owner = s.store.updateJob(s.ctx, {
      requestId: randomUUID(),
      expectedRevision: created.value.revision,
      jobId: created.value.id,
      workKind: "feature",
    });
    expect(owner.ok && owner.value.workKind).toBe("feature");
    expect(s.store.getJob(created.value.id)?.workKind).toBe("feature");
  });
});
