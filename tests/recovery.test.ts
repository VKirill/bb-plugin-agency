import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { seed } from "./role-types.test";
import { recoverJob } from "../src/server/runtime/recovery/service";
import { ensureRecoveryTriage } from "../src/server/runtime/recovery/escalation";
import { consumeRecoveryPermit, hasRecoveryPermit } from "../src/server/runtime/recovery/permit";
import { assertRelaunchAllowed } from "../src/server/runtime/rework/lineage";
import { createRunStore, createInternalRunStoreReads } from "../src/server/runtime/run-store";
import { insertLoopMark, rootJobId } from "../src/server/runtime/loop-break/store";

const decision = { cause: "Repeated input mismatch prevented completion.", correction: "Attached the verified current input and updated the brief.", verification: "Artifact hash and readiness checked against the accepted specification." };
function fixture() {
  const db = openMigratedDatabase(new Database(":memory:")); const s = seed(db);
  const leadJob = s.job("Lead", s.lead); const job = s.job("Implementation", s.developer);
  s.attempt(job.id, "failed");
  db.prepare("UPDATE agency_job SET state = 'blocked' WHERE id = ?").run(job.id);
  const deps = { db, store: s.store, runs: createRunStore(db), reads: createInternalRunStoreReads(db),
    send: { send: async () => { throw new Error("Must not send to failed worker"); }, recoverContinuation: async () => "absent" as const }, currentPublishedHash: async () => null };
  const lead = { ...s.ctx, caller: { agentId: s.lead, jobId: leadJob.id, threadId: "thr_lead", attemptId: "run_lead" } };
  const input = { requestId: randomUUID(), jobId: job.id, expectedRevision: job.revision, comment: "Resume with corrected input.", recoveryDecision: decision };
  return { db, s, job, deps, lead, input };
}

describe("department lead recovery", () => {
  it("queues one original job, persists the decision, survives reload and consumes the permit on real binding", async () => {
    const f = fixture();
    const first = await recoverJob(f.deps, f.lead, f.input);
    expect(first).toMatchObject({ ok: true, value: { id: f.job.id, state: "queued" } });
    expect(await recoverJob(f.deps, f.lead, f.input)).toEqual(first);
    expect(hasRecoveryPermit(f.db, f.job.id)).toBe(true);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM agency_launch_queue WHERE job_id = ? AND dropped_at IS NULL").get(f.job.id)).toEqual({ n: 1 });
    expect(f.s.store.listActivity(f.job.id).filter(a => a.comment?.includes(decision.cause))).toHaveLength(1);
    expect(await recoverJob(f.deps, f.lead, { ...f.input, comment: "Changed request payload" })).toMatchObject({ ok: false, error: { code: "request_conflict" } });
    consumeRecoveryPermit(f.db, f.job.id, "run_new");
    expect(hasRecoveryPermit(f.db, f.job.id)).toBe(false);
    // An idempotent replay cannot rearm a consumed permit.
    expect((await recoverJob(f.deps, f.lead, f.input)).ok).toBe(true);
    expect(hasRecoveryPermit(f.db, f.job.id)).toBe(false);
    f.db.close();
  });
  it("rejects the executor, another department lead and stale revisions before any grant or queue mutation", async () => {
    const f = fixture();
    for (const agentId of [f.s.developer, f.s.reviewer]) {
      expect(await recoverJob(f.deps, { ...f.lead, caller: { ...f.lead.caller, agentId } }, f.input)).toMatchObject({ ok: false, error: { code: "recovery_lead_only" } });
    }
    expect(await recoverJob(f.deps, f.lead, { ...f.input, expectedRevision: 999 })).toMatchObject({ ok: false, error: { code: "revision_conflict" } });
    expect(hasRecoveryPermit(f.db, f.job.id)).toBe(false);
    expect(f.s.store.getJob(f.job.id)?.state).toBe("blocked"); f.db.close();
  });
  it("invalidates a grant when new loop evidence appears, without clearing an older loop for siblings", async () => {
    const f = fixture();
    const mark = { rootJobId: rootJobId(f.db, f.job.id), workJobId: f.job.id, attemptId: "run_fixture", fingerprint: "old", relation: "same_loop" as const, cause: "env" as const, createdAt: "2026-09-23T00:00:00Z" };
    insertLoopMark(f.db, mark);
    expect(assertRelaunchAllowed(f.db, f.job.id).ok).toBe(false);
    expect((await recoverJob(f.deps, f.lead, f.input)).ok).toBe(true);
    expect(assertRelaunchAllowed(f.db, f.job.id).ok).toBe(true);
    insertLoopMark(f.db, { ...mark, fingerprint: "new", createdAt: "2026-09-23T00:01:00Z" });
    expect(assertRelaunchAllowed(f.db, f.job.id)).toMatchObject({ ok: false, error: { code: "loop_blocked" } }); f.db.close();
  });
  it("creates one real lead triage job for a root executor incident without a live parent", () => {
    const f = fixture();
    const activity = f.s.store.createActivity(f.s.ctx, { requestId: randomUUID(), jobId: f.job.id, actor: { kind: "system" }, kind: "comment", causationId: null, references: [], comment: "Three failed passes. Repair and resume the original job." });
    if (!activity.ok) throw new Error(activity.error.message);
    const first = ensureRecoveryTriage(f.db, f.s.store, f.s.ctx, f.job, activity.value, true);
    expect(first?.assignedAgentId).toBe(f.s.lead);
    expect(first?.brief).toContain(f.job.id);
    expect(ensureRecoveryTriage(f.db, f.s.store, f.s.ctx, f.job, activity.value, true)?.id).toBe(first?.id);
    f.db.close();
  });
});
