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
    const child = (title: string, agentId: string) =>
      s.store.createJob(s.ctx, {
        requestId: randomUUID(),
        bindingId: main.bindingId,
        departmentId: s.departmentId,
        title,
        brief: "Бриф.",
        acceptance: "Критерий.",
        parentJobId: main.id,
        assignedAgentId: agentId,
        priority: "normal",
        dueAt: null,
      });
    expect(child("Реализация", s.developer).ok).toBe(true);
    expect(child("Проверка", s.reviewer).ok).toBe(true);
    expect(child("Доработка 1", s.developer).ok).toBe(true);
    const second = child("Доработка 2", s.developer);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("rework_limit_reached");
    db.close();
  });
});
