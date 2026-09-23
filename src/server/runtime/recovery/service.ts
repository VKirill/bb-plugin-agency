import { resolveLaunchIssue } from "../launch-queue/issues";
import { enqueueLaunch } from "../launch-queue/service";
import type { z } from "zod";
import { fail, ok, type DomainResult } from "../../../domain";
import type { Job } from "../../../shared/contracts";
import { recoverJobCommandSchema } from "../../../shared/rpc-contract";
import type { ServiceContext } from "../../services/context";
import { actorToActivity } from "../../services/context";
import { returnJobForRework, type ReworkDeps } from "../rework/service";
import { uuidV5 } from "../launch/operation-ids";
import { recordTrace } from "../trace/store";
import { assertRecoveryAuthority, recoveryText } from "./authorization";
import { recoveryBasis } from "./permit";

/** A reviewed result continues its thread; a stopped run goes through normal queued launch gates. */
export async function recoverJob(deps: ReworkDeps, ctx: ServiceContext, input: z.infer<typeof recoverJobCommandSchema>): Promise<DomainResult<Job>> {
  const parsed = recoverJobCommandSchema.safeParse(input);
  if (!parsed.success) return fail("invalid_command", "Recovery requires cause, correction and verification.");
  const job = deps.store.getJob(input.jobId);
  if (!job) return fail("not_found", `job ${input.jobId} not found`);
  const authority = assertRecoveryAuthority(deps.db, ctx, job);
  if (!authority.ok) return authority;
  // The return ledger handles idempotent calls even after the job becomes running.
  const returned = deps.db.prepare("SELECT 1 FROM agency_rework WHERE request_id = ?").get(input.requestId);
  if (job.state === "review" || returned) return returnJobForRework(deps, ctx, input);
  return deps.db.transaction(() => {
    const payload = JSON.stringify(parsed.data);
    const actor = JSON.stringify(ctx.caller ?? ctx.actor);
    const existing = deps.db.prepare("SELECT payload, actor FROM agency_recovery WHERE request_id = ?").get(input.requestId) as { payload: string; actor: string } | undefined;
    if (existing) return existing.payload === payload && existing.actor === actor ? ok(deps.store.getJob(job.id)!) : fail("request_conflict", "Recovery request identity changed.");
    if (!["blocked", "backlog", "queued"].includes(job.state)) return fail("illegal_transition", "Recovery needs a stopped or reviewed job. Preserve a running worker.");
    if (job.revision !== input.expectedRevision) return fail("revision_conflict", "Read the current job before authorizing recovery.");
    const active = deps.db.prepare("SELECT 1 FROM agency_run_attempt WHERE job_id = ? AND state IN ('launching','running','waiting_input','awaiting_review','unknown')").get(job.id);
    if (active) return fail("active_attempt_exists", "Reconcile or stop the existing attempt before authorizing a new launch.");
    const basis = recoveryBasis(deps.db, job.id);
    const moved = job.state === "queued" ? ok(job) : deps.store.transitionJob(ctx, { requestId: uuidV5(input.requestId, "recovery.queue"), jobId: job.id, expectedRevision: job.revision, to: "queued" });
    if (!moved.ok) return moved;
    deps.db.prepare("INSERT INTO agency_recovery (request_id,job_id,payload,actor,round_count,mark_id,launch_failures,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(input.requestId, job.id, payload, actor, basis.rounds, basis.markId, basis.launchFailures, new Date().toISOString());
    const activity = deps.store.createActivity(ctx, { requestId: uuidV5(input.requestId, "recovery.comment"), jobId: job.id, actor: actorToActivity(ctx.caller?.agentId ? { kind: "agent", agentId: ctx.caller.agentId } : ctx.actor), kind: "comment", causationId: null, references: [], comment: `${recoveryText(input.recoveryDecision)}\n\n${input.comment}` });
    if (!activity.ok) throw new Error(activity.error.message); // roll back the grant and queue transition together
    resolveLaunchIssue(deps.db, job.id);
    enqueueLaunch(deps.db, job.id, new Date().toISOString());
    recordTrace(deps.db, { jobId: job.id, step: "lead.recovery", outcome: "succeeded", reason: "one_launch_authorized", requestId: input.requestId });
    return ok(moved.value);
  })();
}
