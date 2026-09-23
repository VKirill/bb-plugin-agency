import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { DEFAULT_WORK_RULES } from "../src/shared/contracts/work-rules";
import { seed } from "./role-types.test";

function open() {
  return openMigratedDatabase(new Database(":memory:"));
}

describe("work rules", () => {
  it("moves only canceled work into a new plan while retaining its rework limit", () => {
    const db = open();
    const s = seed(db);
    s.store.saveWorkRules(s.bootstrap, { requestId: randomUUID(), scope: `department:${s.departmentId}`, expectedRevision: 0, rules: { reworkLimit: 1 } });
    const source = s.job("Previous plan", s.lead);
    const parent = s.job("New plan", s.lead);
    const replacement = () => s.store.createJob(s.ctx, {
      requestId: randomUUID(), bindingId: source.bindingId, departmentId: s.departmentId,
      title: "Transferred remainder", brief: "Keep accepted evidence", acceptance: "Complete remaining criteria",
      parentJobId: parent.id, assignedAgentId: s.developer, reworkOfJobId: source.id, priority: "normal", dueAt: null,
    });
    expect(replacement()).toMatchObject({ ok: false, error: { code: "invalid_rework_source" } });
    const canceled = s.store.transitionJob(s.ctx, { requestId: randomUUID(), jobId: source.id, expectedRevision: source.revision, to: "canceled" });
    expect(canceled.ok).toBe(true);
    const moved = replacement();
    expect(moved).toMatchObject({ ok: true, value: { reworkOfJobId: source.id, parentJobId: parent.id } });
    expect(replacement()).toMatchObject({ ok: false, error: { code: "rework_limit_reached" } });
    expect(s.store.getJob(source.id)?.state).toBe("canceled");
    db.close();
  });

  it("inherits agency values into a department and keeps limits per scope", () => {
    const db = open();
    const s = seed(db);
    const agency = s.store.saveWorkRules(s.bootstrap, {
      requestId: randomUUID(),
      scope: "agency",
      expectedRevision: 0,
      rules: { reworkLimit: 4, watchStallMinutes: 45, concurrencyLimit: 8, defaultModelExecutor: "claude-haiku-4-5" },
    });
    expect(agency.ok).toBe(true);
    const department = s.store.saveWorkRules(s.bootstrap, {
      requestId: randomUUID(),
      scope: `department:${s.departmentId}`,
      expectedRevision: 0,
      rules: { reworkLimit: 2, minorDefectsWithoutRound: true, budgetMonthlyUsd: 50 },
    });
    expect(department.ok).toBe(true);
    if (!department.ok) return;
    const view = department.value;
    expect(view.effective.reworkLimit).toBe(2);
    expect(view.sources.reworkLimit).toBe("department");
    expect(view.effective.watchStallMinutes).toBe(45);
    expect(view.sources.watchStallMinutes).toBe("agency");
    expect(view.effective.watchQuietMinutes).toBe(DEFAULT_WORK_RULES.watchQuietMinutes);
    expect(view.sources.watchQuietMinutes).toBe("default");
    // The agency concurrency limit is the agency's own, not a department default.
    expect(view.effective.concurrencyLimit).toBeNull();
    expect(view.effective.budgetMonthlyUsd).toBe(50);
    expect(s.store.rulesForDepartment(s.departmentId).minorDefectsWithoutRound).toBe(true);
    db.close();
  });

  it("refuses keys outside the scope and stale revisions", () => {
    const db = open();
    const s = seed(db);
    const foreign = s.store.saveWorkRules(s.bootstrap, {
      requestId: randomUUID(),
      scope: `agent:${s.developer}`,
      expectedRevision: 0,
      rules: { reworkLimit: 5 },
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe("rule_not_in_scope");
    const first = s.store.saveWorkRules(s.bootstrap, { requestId: randomUUID(), scope: `agent:${s.developer}`, expectedRevision: 0, rules: { concurrencyLimit: 1 } });
    expect(first.ok).toBe(true);
    const stale = s.store.saveWorkRules(s.bootstrap, { requestId: randomUUID(), scope: `agent:${s.developer}`, expectedRevision: 0, rules: { concurrencyLimit: 2 } });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("revision_conflict");
    const missing = s.store.getWorkRules("department:dep_missing01");
    expect(missing.ok).toBe(false);
    db.close();
  });

  it("stops a rework subtask past the department limit", () => {
    const db = open();
    const s = seed(db);
    s.store.saveWorkRules(s.bootstrap, { requestId: randomUUID(), scope: `department:${s.departmentId}`, expectedRevision: 0, rules: { reworkLimit: 1 } });
    const main = s.job("Главная", s.lead);
    const child = (title: string, agentId: string, reworkOfJobId?: string) =>
      s.store.createJob(s.ctx, {
        requestId: randomUUID(),
        bindingId: main.bindingId,
        departmentId: s.departmentId,
        title,
        brief: "Бриф.",
        acceptance: "Критерий.",
        parentJobId: main.id,
        assignedAgentId: agentId,
        reworkOfJobId,
        priority: "normal",
        dueAt: null,
      });
    const work = child("Реализация", s.developer);
    if (!work.ok) throw new Error(work.error.message);
    expect(child("Проверка", s.reviewer).ok).toBe(true);
    const first = child("Доработка 1", s.developer, work.value.id);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    expect(s.store.getJob(first.value.id)?.reworkOfJobId).toBe(work.value.id);
    expect(child("Другой компонент", s.developer).ok).toBe(true);
    const second = child("Доработка 2", s.developer, first.value.id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("rework_limit_reached");
    db.close();
  });

  it("stores and reads agency spec gate keys and rejects them on a department", () => {
    const db = open();
    const s = seed(db);
    const saved = s.store.saveWorkRules(s.bootstrap, {
      requestId: randomUUID(),
      scope: "agency",
      expectedRevision: 0,
      rules: { specDepartmentId: "dep_product01", specGatedDepartmentIds: ["dep_develop01", "dep_design01"] },
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.effective.specDepartmentId).toBe("dep_product01");
    expect(saved.value.effective.specGatedDepartmentIds).toEqual(["dep_develop01", "dep_design01"]);
    expect(saved.value.sources.specDepartmentId).toBe("agency");
    const read = s.store.getWorkRules("agency");
    expect(read.ok && read.value.stored.specDepartmentId).toBe("dep_product01");
    const refused = s.store.saveWorkRules(s.bootstrap, {
      requestId: randomUUID(),
      scope: `department:${s.departmentId}`,
      expectedRevision: 0,
      rules: { specDepartmentId: "dep_product01", specGatedDepartmentIds: [s.departmentId] },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("rule_not_in_scope");
    db.close();
  });

  it("fills stale nudge thresholds from defaults when stored rules omit them", () => {
    const db = open();
    const s = seed(db);
    const saved = s.store.saveWorkRules(s.bootstrap, {
      requestId: randomUUID(),
      scope: "agency",
      expectedRevision: 0,
      rules: { watchStallMinutes: 45 },
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.stored.staleHoursBlocked).toBeUndefined();
    expect(saved.value.effective.staleHoursBlocked).toBe(DEFAULT_WORK_RULES.staleHoursBlocked);
    expect(saved.value.effective.staleHoursRunning).toBe(1);
    expect(saved.value.effective.staleRepeatHours).toBe(24);
    expect(saved.value.effective.staleMaxAttempts).toBe(3);
    expect(saved.value.sources.staleHoursBlocked).toBe("default");
    db.close();
  });
});
