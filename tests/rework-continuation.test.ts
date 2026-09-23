import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { seed } from "./role-types.test";
import { hasRecoveryPermit, consumeRecoveryPermit } from "../src/server/runtime/recovery/permit";
import { reworkRoundCount, assertRelaunchAllowed } from "../src/server/runtime/rework/lineage";

function fixture() {
  const db = openMigratedDatabase(new Database(":memory:"));
  const s = seed(db);
  const source = s.job("Accepted installation", s.developer);
  db.prepare("UPDATE agency_job SET state = 'done' WHERE id = ?").run(source.id);
  s.attempt(source.id, "succeeded");
  const root = s.job("Customer's revised delivery plan", s.lead);
  s.store.saveWorkRules(s.bootstrap, { requestId: randomUUID(), scope: `department:${s.departmentId}`, expectedRevision: 0, rules: { reworkLimit: 1 } });
  const old = s.job("Historical correction", s.developer);
  db.prepare("UPDATE agency_job SET state = 'done', rework_of_job_id = ? WHERE id = ?").run(source.id, old.id);
  const ctx = { ...s.ctx, caller: { agentId: s.lead, jobId: root.id, threadId: "thr_lead", attemptId: "run_lead" } };
  const input = { requestId: randomUUID(), bindingId: source.bindingId, departmentId: s.departmentId,
    title: "Version coexistence and installer corrections", brief: "Preserve the accepted baseline", acceptance: "Real coexistence and no downgrade",
    parentJobId: root.id, assignedAgentId: s.developer, reworkOfJobId: source.id, priority: "normal" as const, dueAt: null,
    reworkRecovery: { expectedSourceRevision: source.revision, cause: "The source installer overwrites a newer installation", correction: "Use version ownership and preserve custom configuration", verification: "Compared accepted source and new plan with exact entrypoints" } };
  return { db, s, source, root, old, ctx, input };
}

describe("explicit linked recovery creation", () => {
  it("preserves delivered source, lineage and limit; authorizes one real launch and records the decision atomically", () => {
    const f = fixture();
    const { reworkRecovery, ...ordinary } = f.input;
    expect(f.s.store.createJob(f.ctx, ordinary)).toMatchObject({ ok: false, error: { code: "invalid_rework_source" } });
    const input = { ...f.input, requestId: randomUUID() };
    const created = f.s.store.createJob(f.ctx, input);
    expect(created.ok).toBe(true); if (!created.ok) throw new Error(created.error.message);
    expect(created.value).toMatchObject({ parentJobId: f.root.id, reworkOfJobId: f.source.id });
    expect(f.s.store.getJob(f.source.id)).toMatchObject({ state: "done", revision: f.source.revision });
    expect(reworkRoundCount(f.db, f.source.id)).toBe(2);
    expect(f.s.store.rulesForDepartment(f.s.departmentId).reworkLimit).toBe(1);
    expect(hasRecoveryPermit(f.db, created.value.id)).toBe(true);
    expect(assertRelaunchAllowed(f.db, created.value.id)).toMatchObject({ ok: true });
    expect(f.s.store.createJob(f.ctx, input)).toEqual(created);
    expect(reworkRoundCount(f.db, f.source.id)).toBe(2);
    const audit = f.db.prepare("SELECT comment FROM agency_activity WHERE job_id = ? AND kind = 'comment'").all(created.value.id) as { comment: string }[];
    expect(audit.some(a => a.comment.includes(reworkRecovery.verification))).toBe(true);
    expect(f.s.store.createJob(f.ctx, { ...input, requestId: randomUUID() })).toMatchObject({ ok: false, error: { code: "active_rework_exists" } });
    f.s.attempt(created.value.id, "failed");
    consumeRecoveryPermit(f.db, created.value.id, `run_${created.value.id}`);
    expect(hasRecoveryPermit(f.db, created.value.id)).toBe(false);
    expect(assertRelaunchAllowed(f.db, created.value.id)).toMatchObject({ ok: false, error: { code: "rework_limit_reached" } });
    f.db.close();
  });

  it("rejects executor self-authorization, stale source, missing lineage, a closed parent and a still active source", () => {
    const f = fixture();
    const create = (input = f.input, ctx = f.ctx) => f.s.store.createJob(ctx, { ...input, requestId: randomUUID() });
    expect(create(f.input, { ...f.ctx, caller: { ...f.ctx.caller, agentId: f.s.developer } })).toMatchObject({ ok: false, error: { code: "recovery_lead_only" } });
    expect(create({ ...f.input, assignedAgentId: f.s.lead })).toMatchObject({ ok: false, error: { code: "recovery_lead_only" } });
    expect(create({ ...f.input, reworkRecovery: { ...f.input.reworkRecovery, expectedSourceRevision: 42 } })).toMatchObject({ ok: false, error: { code: "revision_conflict" } });
    expect(f.s.store.createJob(f.ctx, { ...f.input, requestId: randomUUID(), reworkOfJobId: null })).toMatchObject({ ok: false, error: { code: "invalid_rework_source" } });
    f.db.prepare("UPDATE agency_job SET state = 'done' WHERE id = ?").run(f.root.id);
    expect(create()).toMatchObject({ ok: false, error: { code: "parent_closed" } });
    f.db.prepare("UPDATE agency_job SET state = 'running' WHERE id = ?").run(f.root.id);
    f.s.attempt(f.old.id, "running");
    expect(create()).toMatchObject({ ok: false, error: { code: "active_attempt_exists" } });
    f.db.prepare("UPDATE agency_run_attempt SET state = 'succeeded' WHERE job_id = ?").run(f.old.id);
    f.db.prepare("UPDATE agency_run_attempt SET state = 'running' WHERE job_id = ?").run(f.source.id);
    expect(create()).toMatchObject({ ok: false, error: { code: "active_attempt_exists" } });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM agency_recovery").get()).toEqual({ n: 0 });
    f.db.close();
  });
});
