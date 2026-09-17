import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { checkLaunchLimits, listBudgets, liveLaunchCount, monthStartUtc } from "../src/server/rules/limits";
import { seed } from "./role-types.test";

function setup() {
  const db = openMigratedDatabase(new Database(":memory:"));
  const s = seed(db);
  const save = (scope: string, rules: Record<string, unknown>) => {
    const current = s.store.getWorkRules(scope);
    const revision = current.ok ? current.value.revision : 0;
    const saved = s.store.saveWorkRules(s.bootstrap, { requestId: randomUUID(), scope, expectedRevision: revision, rules });
    if (!saved.ok) throw new Error(saved.error.message);
  };
  const attemptFor = (jobId: string, state: string, n: number) => {
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO agency_run_attempt (id, job_id, attempt_no, snapshot_id, digest, thread_id, launch_id, state, revision, created_at, updated_at)
       VALUES (?, ?, ?, 'snp_fixture', 'digest', ?, ?, ?, 1, '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z')`,
    ).run(`run_${jobId}_${n}`, jobId, n, `thr_fixture${n}`, randomUUID(), state);
    db.pragma("foreign_keys = ON");
  };
  return { db, s, save, attemptFor };
}

describe("launch limits", () => {
  it("counts only starting and working attempts, never the job being launched", () => {
    const { db, s, attemptFor } = setup();
    const a = s.job("A", s.developer);
    const b = s.job("B", s.developer);
    const c = s.job("C", s.reviewer);
    attemptFor(a.id, "running", 1);
    attemptFor(b.id, "awaiting_review", 2);
    attemptFor(c.id, "launching", 3);
    expect(liveLaunchCount(db, { kind: "agency" })).toBe(2);
    expect(liveLaunchCount(db, { kind: "agency" }, a.id)).toBe(1);
    expect(liveLaunchCount(db, { kind: "agent", id: s.developer, name: "Разработчик" })).toBe(1);
    expect(liveLaunchCount(db, { kind: "department", id: s.departmentId, name: "Разработка" })).toBe(2);
  });

  it("refuses a launch over the department concurrency limit and names the numbers", async () => {
    const { db, s, save, attemptFor } = setup();
    save(`department:${s.departmentId}`, { concurrencyLimit: 1 });
    const running = s.job("Идёт", s.developer);
    attemptFor(running.id, "running", 1);
    const next = s.job("Следующая", s.reviewer);
    const result = await checkLaunchLimits({ db, spend: async () => null }, next);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("concurrency_limit_reached");
    expect(result.error.message).toContain("отдела «Разработка»: 1, лимит 1");
    // A retry of the job already holding the slot is not refused by its own attempt.
    expect((await checkLaunchLimits({ db, spend: async () => null }, running)).ok).toBe(true);
  });

  it("applies the employee limit even when the department has none", async () => {
    const { db, s, save, attemptFor } = setup();
    save(`agent:${s.developer}`, { concurrencyLimit: 1 });
    attemptFor(s.job("Первая", s.developer).id, "running", 1);
    const result = await checkLaunchLimits({ db, spend: async () => null }, s.job("Вторая", s.developer));
    expect(result.ok ? null : result.error.code).toBe("concurrency_limit_reached");
    expect((await checkLaunchLimits({ db, spend: async () => null }, s.job("Проверка", s.reviewer))).ok).toBe(true);
  });

  it("stops launches when the monthly budget is spent and warns past the threshold", async () => {
    const { db, s, save } = setup();
    save("agency", { budgetMonthlyUsd: 100, budgetWarnPercent: 70 });
    const now = () => new Date("2026-09-17T10:00:00.000Z");
    const spend = vi.fn(async () => 7_500);
    const warned = await checkLaunchLimits({ db, spend, now }, s.job("Задача", s.developer));
    expect(warned.ok && warned.value.warnings[0]).toContain("израсходовано $75.00 из $100 за месяц (75%)");
    expect(spend).toHaveBeenCalledWith({ attemptsFrom: "2026-09-01T00:00:00.000Z" });

    const exhausted = await checkLaunchLimits({ db, spend: async () => 10_000, now }, s.job("Ещё", s.developer));
    expect(exhausted.ok ? null : exhausted.error.code).toBe("budget_exhausted");
  });

  it("asks spend for the department and the employee separately", async () => {
    const { db, s, save } = setup();
    save(`department:${s.departmentId}`, { budgetMonthlyUsd: 10 });
    save(`agent:${s.developer}`, { budgetMonthlyUsd: 5 });
    const spend = vi.fn(async (filter: { departmentId?: string; agentId?: string }) => (filter.agentId ? 600 : 100));
    const result = await checkLaunchLimits({ db, spend }, s.job("Задача", s.developer));
    expect(result.ok ? null : result.error.message).toContain("Бюджет сотрудника Разработчик на месяц израсходован: $6.00 из $5");
    const budgets = await listBudgets({ db, spend });
    expect(budgets.map((row) => [row.scope, row.percent])).toEqual([
      [`agent:${s.developer}`, 120],
      [`department:${s.departmentId}`, 10],
    ]);
  });

  it("starts the month at UTC midnight of the first day", () => {
    expect(monthStartUtc(new Date("2026-10-01T00:30:00+02:00"))).toBe("2026-09-01T00:00:00.000Z");
  });
});
