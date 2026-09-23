import type { z } from "zod";
import { fail, ok } from "../../../domain";
import type { jobDiagnosticsQuerySchema } from "../../../shared/contracts/diagnostics";
import type { SqlDatabase } from "../../db/sql";
import { assertBindingAccess, type ServiceContext } from "../../services/context";
import { rootJobId } from "../loop-break/store";
import { listTrace } from "../trace/store";
import { recoveryHistory } from "./history";

type Event = { seq: number; type: string; data: unknown };
export function visibleDiagnosticMessages(rows: Event[]) {
  return rows.flatMap(row => {
    const data = row.data as { item?: { type?: string; text?: string; exitCode?: number }; error?: { message?: string } };
    const item = data?.item;
    // Only visible assistant messages and failure codes; no reasoning, tool arguments or raw output.
    if (row.type === "item/completed" && item?.type === "agentMessage" && typeof item.text === "string")
      return [{ seq: row.seq, type: "assistant", text: item.text.slice(0, 4000) }];
    if (row.type === "item/completed" && item?.type === "commandExecution" && typeof item.exitCode === "number" && item.exitCode !== 0)
      return [{ seq: row.seq, type: "command_failed", text: `exitCode=${item.exitCode}` }];
    if (row.type === "turn/failed") return [{ seq: row.seq, type: "turn_failed", text: "Provider turn failed; inspect the linked attempt." }];
    return [];
  }).reverse();
}

export async function getJobDiagnostics(db: SqlDatabase, ctx: ServiceContext, input: z.infer<typeof jobDiagnosticsQuerySchema>,
  events: (args: { threadId: string; beforeSeq?: string; limit: string; order: "desc" }) => Promise<Event[]>) {
  const job = db.prepare("SELECT id, key, binding_id, department_id FROM agency_job WHERE id = ? OR key = ?").get(input.jobId, input.jobId) as
    { id: string; key: string; binding_id: string; department_id: string } | undefined;
  if (!job) return fail("not_found", "Job not found");
  const access = assertBindingAccess(ctx, job.binding_id);
  if (!access.ok) return access;
  if (ctx.caller || ctx.actor.kind === "agent") {
    const agentId = ctx.caller?.agentId ?? (ctx.actor.kind === "agent" ? ctx.actor.agentId : null);
    const department = db.prepare("SELECT lead_agent_id FROM agency_department WHERE id = ?").get(job.department_id) as { lead_agent_id: string } | undefined;
    const callerJob = ctx.caller ? db.prepare("SELECT department_id FROM agency_job WHERE id = ?").get(ctx.caller.jobId) as { department_id: string } | undefined : undefined;
    const triage = ctx.caller && db.prepare("SELECT 1 FROM agency_recovery_triage WHERE job_id = ? AND lead_job_id = ?").get(job.id, ctx.caller.jobId);
    if (agentId !== department?.lead_agent_id || (ctx.caller && (callerJob?.department_id !== job.department_id ||
      (!triage && rootJobId(db, ctx.caller.jobId) !== rootJobId(db, job.id))))) return fail("diagnostics_lead_only", "Only the responsible lead or owner can inspect this work line.");
  }
  const attempts = db.prepare(`SELECT id AS attemptId, thread_id AS threadId, state, created_at AS createdAt FROM agency_run_attempt
    WHERE job_id = ? ORDER BY attempt_no DESC LIMIT 100`).all(job.id) as Array<{ attemptId: string; threadId: string | null; state: string; createdAt: string }>;
  const selected = input.attemptId ? attempts.find(a => a.attemptId === input.attemptId) : attempts[0];
  if (input.attemptId && !selected) return fail("attempt_scope_mismatch", "Attempt is not part of this job or is outside the last 100 attempts.");
  let rows: Event[] = []; let error: string | null = null;
  if (selected?.threadId) {
    try { rows = await events({ threadId: selected.threadId, order: "desc", limit: String(input.limit), ...(input.beforeSeq ? { beforeSeq: String(input.beforeSeq) } : {}) }); }
    catch { error = "thread_history_unavailable"; }
  }
  return ok({ jobId: job.id, jobKey: job.key, history: recoveryHistory(db, job.id), attempts,
    trace: listTrace(db, { jobId: job.id, descendants: false, limit: input.limit }),
    conversation: { threadId: selected?.threadId ?? null, entries: visibleDiagnosticMessages(rows),
      nextBeforeSeq: rows.length === input.limit ? Math.min(...rows.map(r => r.seq)) : null, error } });
}
