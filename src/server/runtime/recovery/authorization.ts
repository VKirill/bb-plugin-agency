import { fail, ok, type DomainResult } from "../../../domain";
import type { Job } from "../../../shared/contracts";
import type { RecoveryDecision } from "../../../shared/rpc-contract";
import type { SqlDatabase } from "../../db/sql";
import { assertBindingAccess, type ServiceContext } from "../../services/context";

/** Server-derived caller only. Neither a worker nor a lead from another department may self-authorize. */
export function assertRecoveryAuthority(db: SqlDatabase, ctx: ServiceContext, job: Job): DomainResult<true> {
  const access = assertBindingAccess(ctx, job.bindingId);
  if (!access.ok) return access;
  const agentId = ctx.caller?.agentId ?? (ctx.actor.kind === "agent" ? ctx.actor.agentId : null);
  if (!ctx.caller && ctx.actor.kind !== "agent") return ok(true);
  const department = db.prepare("SELECT lead_agent_id FROM agency_department WHERE id = ?").get(job.departmentId) as { lead_agent_id: string } | undefined;
  const callerJob = ctx.caller ? db.prepare("SELECT department_id, binding_id FROM agency_job WHERE id = ?").get(ctx.caller.jobId) as { department_id: string; binding_id: string } | undefined : undefined;
  return agentId && agentId === department?.lead_agent_id && agentId !== job.assignedAgentId &&
    (!ctx.caller || (callerJob?.department_id === job.departmentId && callerJob.binding_id === job.bindingId))
    ? ok(true)
    : fail("recovery_lead_only", "Recovery requires the responsible department lead or owner; an executor cannot authorize its own retry.");
}

export function recoveryText(decision: RecoveryDecision): string {
  return `Recovery decision for ONE continuation:\nCause: ${decision.cause}\nCorrection: ${decision.correction}\nVerification: ${decision.verification}`;
}
