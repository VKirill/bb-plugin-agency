import { returnJobForRework } from "../src/server/runtime/rework/service";
import { createInternalRunStoreReads, createRunStore } from "../src/server/runtime/run-store";
import { saveKnowledge } from "../src/server/knowledge/store";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { seed } from "./role-types.test";
import { handInCommentMissing } from "../src/server/runtime/hand-in/service";
import { readLeadState } from "../src/server/lead-control/state";
import { leadStateSchema } from "../src/shared/contracts/lead-control";
import type { ServiceContext } from "../src/server/services";

const dbs: ReturnType<typeof openMigratedDatabase>[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function setup(lead = false, explicit = true) {
  const db = openMigratedDatabase(new Database(":memory:")); dbs.push(db);
  const s = seed(db), job = s.job("Adapt product to installed SDK", lead ? s.lead : s.developer);
  db.prepare("UPDATE agency_job SET state = 'running' WHERE id = ?").run(job.id);
  s.attempt(job.id, "running");
  expect(s.store.setJobExecutionFacts(s.ctx, { requestId: randomUUID(), jobId: job.id, threadBound: true }).ok).toBe(true);
  const attemptId = `run_${job.id}`;
  if (explicit) db.prepare("INSERT INTO agency_handin_protocol VALUES (?)").run(attemptId);
  const ctx: ServiceContext = { ...s.ctx, actor: { kind: "agent", agentId: job.assignedAgentId! }, caller: { jobId: job.id, agentId: job.assignedAgentId, attemptId, threadId: "thr_fixture01" } };
  function publish(hash = "ab".repeat(32)) {
    const a = s.store.createArtifact(s.ctx, { requestId: randomUUID(), jobId: job.id });
    if (!a.ok) throw new Error(a.error.message);
    const p = s.store.publishArtifactVersion(s.ctx, { requestId: randomUUID(), jobId: job.id, artifactId: a.value.id, hostId: "host_mini", relativePath: "report.md", mime: "text/markdown", size: 3, hash, author: { kind: "system" } });
    if (!p.ok) throw new Error(p.error.message);
    return p.value;
  }
  const command = (p: ReturnType<typeof publish>) => ({ requestId: randomUUID(), jobId: job.id, expectedRevision: s.store.getJob(job.id)!.revision, artifactId: p.artifactId, version: p.version, hash: p.hash, comment: "Outcome and evidence ready for independent review" });
  return { db, s, job, ctx, attemptId, publish, command };
}
const decision = { unknowns: ["Installed SDK interface"], bottleneck: "No verified compatibility map", action: "inspect" as const, rationale: "Inspect before delegating implementation", nextCheck: "Scout result", evidence: ["delivery-plan.md"] };

describe("explicit final submission", () => {
  it("progress + plan cannot enter review; exact submission enables review and idempotent retry", () => {
    const { db, s, job, ctx, publish, command } = setup();
    const p = publish();
    s.store.createActivity(ctx, { requestId: randomUUID(), jobId: job.id, actor: ctx.actor, kind: "comment", references: [], causationId: null, comment: "Plan published, implementation is next" });
    expect(handInCommentMissing(db, job.id)).toBe(true);
    expect(s.store.transitionJob(s.ctx, { requestId: randomUUID(), jobId: job.id, expectedRevision: job.revision, to: "review" })).toMatchObject({ ok: false, error: { code: "final_submission_required" } });
    const cmd = command(p), submitted = s.store.submitJobResult(ctx, cmd);
    expect(submitted.ok).toBe(true);
    expect(s.store.submitJobResult(ctx, cmd)).toEqual(submitted);
    expect(handInCommentMissing(db, job.id)).toBe(false);
    expect(s.store.getJob(job.id)!.state).toBe("running"); // submission is not acceptance
    expect(s.store.transitionJob(s.ctx, { requestId: randomUUID(), jobId: job.id, expectedRevision: job.revision, to: "review" }).ok).toBe(true);
  });
  it("a newer publication invalidates an old submission even with identical bytes", () => {
    const { db, s, job, ctx, publish, command } = setup();
    const p = publish(); expect(s.store.submitJobResult(ctx, command(p)).ok).toBe(true);
    const newer = publish();
    expect(handInCommentMissing(db, job.id)).toBe(true);
    expect(s.store.submitJobResult(ctx, command(p))).toMatchObject({ ok: false, error: { code: "stale_submission" } });
    expect(s.store.submitJobResult(ctx, command(newer)).ok).toBe(true);
    expect(handInCommentMissing(db, job.id)).toBe(false);
  });
  it("rejects stale revisions, other workers, old attempts and foreign bindings", () => {
    const { s, ctx, publish, command } = setup(); const cmd = command(publish());
    expect(s.store.submitJobResult(ctx, { ...cmd, expectedRevision: cmd.expectedRevision + 1 })).toMatchObject({ ok: false, error: { code: "revision_conflict" } });
    for (const altered of [{ ...ctx, caller: { ...ctx.caller!, agentId: s.reviewer } }, { ...ctx, caller: { ...ctx.caller!, attemptId: "run_old_attempt" } }, { ...ctx, caller: undefined, actor: { kind: "agent" as const, agentId: s.reviewer } }]) {
      expect(s.store.submitJobResult(altered, cmd)).toMatchObject({ ok: false, error: { code: "forbidden_job_control" } });
    }
    expect(s.store.submitJobResult({ ...ctx, allowedBindingIds: [] }, cmd)).toMatchObject({ ok: false, error: { code: "forbidden_binding" } });
  });
  it("requires work children to finish and a fresh parent publication", () => {
    const { db, s, job, ctx, publish, command } = setup(true); const p = publish();
    const child = s.job("Implementation", s.developer);
    db.prepare("UPDATE agency_job SET parent_job_id = ? WHERE id = ?").run(job.id, child.id);
    expect(s.store.submitJobResult(ctx, command(p))).toMatchObject({ ok: false, error: { code: "unfinished_work" } });
    db.prepare("UPDATE agency_job SET state = 'done' WHERE id = ?").run(child.id);
    expect(s.store.submitJobResult(ctx, command(p))).toMatchObject({ ok: false, error: { code: "unfinished_work" } });
    expect(s.store.submitJobResult(ctx, command(publish("cd".repeat(32)))).ok).toBe(true);
  });
  it("invalidates a submission on return and requires a new exact result in the same attempt", async () => {
    const { db, s, job, ctx, attemptId, publish, command } = setup();
    const p = publish(); expect(s.store.submitJobResult(ctx, command(p)).ok).toBe(true);
    expect(s.store.transitionJob(s.ctx, { requestId: randomUUID(), jobId: job.id, expectedRevision: job.revision, to: "review" }).ok).toBe(true);
    const owner: ServiceContext = { ...s.ctx, actor: { kind: "user", userId: "usr_owner" } };
    const sent: string[] = [];
    const returned = await returnJobForRework({ db, store: s.store, runs: createRunStore(db), reads: createInternalRunStoreReads(db), currentPublishedHash: async () => p.hash,
      send: { send: async args => { sent.push(args.text); return { kind: "confirmed", delivery: "sent" }; }, recoverContinuation: async () => "present" } }, owner,
      { requestId: randomUUID(), jobId: job.id, expectedRevision: s.store.getJob(job.id)!.revision, comment: "Fix the missing acceptance criterion" });
    expect(returned.ok, JSON.stringify(returned)).toBe(true);
    expect(db.prepare("SELECT * FROM agency_result_submission WHERE attempt_id = ?").get(attemptId)).toBeUndefined();
    expect(handInCommentMissing(db, job.id)).toBe(true); expect(sent[0]).toContain("job submit");
    expect(s.store.submitJobResult(ctx, command(p))).toMatchObject({ ok: false, error: { code: "stale_submission" } });
    expect(s.store.submitJobResult(ctx, command(publish("cd".repeat(32)))).ok).toBe(true);
    expect(handInCommentMissing(db, job.id)).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agency_run_attempt WHERE job_id = ?").get(job.id)).toEqual({ n: 1 });
  });
  it("preserves existing attempts and lets them opt into explicit submission", () => {
    const { db, s, job, ctx, publish, command } = setup(false, false);
    s.store.createActivity(ctx, { requestId: randomUUID(), jobId: job.id, actor: ctx.actor, kind: "comment", references: [], causationId: null, comment: "Legacy closing comment" });
    expect(handInCommentMissing(db, job.id)).toBe(false);
    expect(s.store.submitJobResult(ctx, command(publish())).ok).toBe(true);
    publish("cd".repeat(32));
    expect(handInCommentMissing(db, job.id)).toBe(true);
  });
});

describe("lead decisions and live state", () => {
  it("retains full goal and decision history, with independent CAS and retry identity", () => {
    const { db, s, job, ctx } = setup(true);
    const cmd = { requestId: randomUUID(), jobId: job.id, expectedRevision: 0, decision };
    const first = s.store.recordLeadDecision(ctx, cmd);
    expect(first).toMatchObject({ ok: true, value: { revision: 1, decision } });
    expect(s.store.recordLeadDecision(ctx, cmd)).toEqual(first);
    expect(s.store.recordLeadDecision(ctx, { ...cmd, requestId: randomUUID() })).toMatchObject({ ok: false, error: { code: "revision_conflict" } });
    for (let i = 1; i < 12; i++) expect(s.store.recordLeadDecision(ctx, { ...cmd, requestId: randomUUID(), expectedRevision: i, decision: { ...decision, evidence: [`evidence-${i}`] } }).ok).toBe(true);
    const state = leadStateSchema.parse(readLeadState(db, s.store.getJob(job.id)!, 0, 2));
    expect(state.job.brief).toBe(job.brief); expect(state.job.acceptance).toBe(job.acceptance);
    expect(state.job.revision).toBe(job.revision); expect(state.decisionRevision).toBe(12);
    expect(state.decisions).toHaveLength(10); expect(state.nextDecisionBeforeRevision).toBe(3);
    const history = readLeadState(db, state.job, 0, 2, state.nextDecisionBeforeRevision!);
    expect(history.decisions.map(d => d.revision)).toEqual([2, 1]);
    expect(history.decisions[1]!.decision).toEqual(decision);
    expect(s.store.listActivity(job.id).filter(a => a.kind === "lead_decision")).toHaveLength(12);
  });
  it("restricts decisions to the current assigned lead", () => {
    const { s, job, ctx } = setup();
    expect(s.store.recordLeadDecision(ctx, { requestId: randomUUID(), jobId: job.id, expectedRevision: 0, decision })).toMatchObject({ ok: false, error: { code: "lead_required" } });
  });
  it("surfaces provisional lessons with their sources without treating them as accepted rules", () => {
    const { db, s, job } = setup(true);
    const saved = saveKnowledge(db, { expectedRevision: 0, title: "Candidate", summary: "Observation only", body: "Needs causal verification", kind: "lesson", source: "AG-42", scopeKind: "department", scopeId: s.departmentId }, { proposedBy: "agency:lesson" }, new Date().toISOString());
    expect(saved.ok).toBe(true);
    const state = leadStateSchema.parse(readLeadState(db, s.store.getJob(job.id)!, 0, 30));
    expect(state.lessonCandidateCount).toBe(1); expect(state.lessonCandidates[0]).toMatchObject({ title: "Candidate", source: "AG-42" });
    expect(JSON.stringify(s.store.knowledgeForLaunch(s.departmentId, s.bindingId))).not.toContain("Candidate");
  });
  it("pages children without hiding counts or inventing final readiness", () => {
    const { db, s, job } = setup(true);
    for (let i = 0; i < 3; i++) { const child = s.job(`Child ${i}`, s.developer); db.prepare("UPDATE agency_job SET parent_job_id = ? WHERE id = ?").run(job.id, child.id); }
    const state = leadStateSchema.parse(readLeadState(db, s.store.getJob(job.id)!, 0, 2));
    expect(state.children).toHaveLength(2); expect(state.nextOffset).toBe(2);
    expect(Object.values(state.childCounts).reduce((a, b) => a + b, 0)).toBe(3);
    expect(state.handIn).toEqual({ protocol: "explicit", dependenciesReady: false, submittedHash: null });
    expect(readLeadState(db, state.job, 2, 2).children).toHaveLength(1);
  });
});
