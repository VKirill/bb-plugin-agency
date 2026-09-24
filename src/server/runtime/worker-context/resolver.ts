import type { BbPluginApi, PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import type { SqlDatabase } from "../../db/sql";
import type { ContextSnapshot } from "../context-snapshot/types";
import type { VkSessionPolicy, WorkerContextView } from "../../../shared/contracts/worker-context";

type VkAgents = {
 experimental_vkSessionPolicy?: (resolver: (ctx: PluginAgentConfigurationContext) => VkSessionPolicy | null) => void;
 experimental_vkContextContributions?: () => WorkerContextView["contributions"];
};
/** Metadata is only a lookup hint; identity and policy come from the stored launch snapshot. */
export function resolveWorkerContext(db: SqlDatabase, ctx: PluginAgentConfigurationContext): VkSessionPolicy | null {
 const m = ctx.pluginMetadata;
 if(typeof m.agencyAttemptId !== "string" || typeof m.agencyLaunchId !== "string" || typeof m.agencyJobId !== "string") return null;
 const row = db.prepare(`SELECT a.thread_id, a.state, s.snapshot_json FROM agency_run_attempt a
 JOIN agency_context_snapshot s ON s.id=a.snapshot_id WHERE a.id=? AND a.launch_id=? AND a.job_id=?`).get(m.agencyAttemptId,m.agencyLaunchId,m.agencyJobId) as {thread_id:string|null;state:string;snapshot_json:string}|undefined;
 if(!row || (row.thread_id ? row.thread_id !== ctx.thread.id : row.state !== "launching")) return null;
 const snapshot = JSON.parse(row.snapshot_json) as ContextSnapshot;
 if(snapshot.binding.bbProjectId !== ctx.project.id || snapshot.binding.hostId !== ctx.host.id || snapshot.binding.canonicalRoot !== ctx.environment.path || snapshot.agentVersion.providerId !== ctx.provider.id) return null;
 // A reused reviewer thread keeps its original provider session and original frozen policy.
 return snapshot.workerContext?.policy ?? null;
}
export function registerWorkerContext(bb: BbPluginApi, db: SqlDatabase) {
 const agents = bb.agents as unknown as VkAgents;
 const available = typeof agents.experimental_vkSessionPolicy === "function";
 if(available) agents.experimental_vkSessionPolicy!(ctx => resolveWorkerContext(db,ctx));
 return {available, contributions: () => agents.experimental_vkContextContributions?.() ?? []};
}
