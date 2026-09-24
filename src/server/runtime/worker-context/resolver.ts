import type { BbPluginApi, PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import type { SqlDatabase } from "../../db/sql";
import type { ContextSnapshot } from "../context-snapshot/types";
import type { VkSessionPolicy, WorkerContextView } from "../../../shared/contracts/worker-context";

type VkAgents = {
 experimental_vkSessionPolicy?: (resolver: (ctx: PluginAgentConfigurationContext) => VkSessionPolicy | null) => void;
 experimental_vkContextContributions?: () => WorkerContextView["contributions"];
};
/** Metadata is only a lookup hint; identity and policy come from the stored launch snapshot. */
export function resolveWorkerContext(db: SqlDatabase, ctx: PluginAgentConfigurationContext, observe: (reason: string) => void = () => {}): VkSessionPolicy | null {
 const refuse = (reason: string) => { observe(reason); return null; };
 const m = ctx.pluginMetadata;
 if(typeof m.agencyAttemptId !== "string" || typeof m.agencyLaunchId !== "string" || typeof m.agencyJobId !== "string") return refuse("missing_metadata");
 const row = db.prepare(`SELECT a.thread_id, a.state, s.snapshot_json FROM agency_run_attempt a
 JOIN agency_context_snapshot s ON s.id=a.snapshot_id WHERE a.id=? AND a.launch_id=? AND a.job_id=?`).get(m.agencyAttemptId,m.agencyLaunchId,m.agencyJobId) as {thread_id:string|null;state:string;snapshot_json:string}|undefined;
 if(!row) return refuse("attempt_identity_mismatch");
 if(row.thread_id ? row.thread_id !== ctx.thread.id : row.state !== "launching") return refuse("thread_identity_mismatch");
 const snapshot = JSON.parse(row.snapshot_json) as ContextSnapshot;
 if(snapshot.binding.bbProjectId !== ctx.project.id) return refuse("project_mismatch");
 if(snapshot.binding.hostId !== ctx.host.id) return refuse("host_mismatch");
 if(snapshot.binding.canonicalRoot !== ctx.environment.path) return refuse("path_mismatch");
 if(snapshot.agentVersion.providerId !== ctx.provider.id) return refuse("provider_mismatch");
 // A reused reviewer thread keeps its original provider session and original frozen policy.
 observe(snapshot.workerContext ? "applied" : "legacy_snapshot_without_policy");
 return snapshot.workerContext?.policy ?? null;
}
export function registerWorkerContext(bb: BbPluginApi, db: SqlDatabase) {
 const agents = bb.agents as unknown as VkAgents;
 const available = typeof agents.experimental_vkSessionPolicy === "function";
 const observed = new Map<string,string>();
 if(available) agents.experimental_vkSessionPolicy!(ctx => resolveWorkerContext(db,ctx,reason => {
  const owned = typeof ctx.pluginMetadata.agencyJobId === "string" || db.prepare("SELECT 1 FROM agency_run_attempt WHERE thread_id = ?").get(ctx.thread.id);
  if(!owned || observed.get(ctx.thread.id) === reason) return;
  if(observed.size >= 512) observed.delete(observed.keys().next().value!);
  observed.set(ctx.thread.id,reason);
  bb.log.info(`Worker context ${ctx.thread.id}: ${reason}`);
 }));
 return {available, contributions: () => agents.experimental_vkContextContributions?.() ?? []};
}
