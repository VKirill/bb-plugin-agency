import type { SqlDatabase } from "../../db/sql";
import { fail, ok } from "../../../domain";
import { workerContextPolicySchema, saveWorkerContextSchema, type WorkerContextQuery, type WorkerContextPolicy } from "../../../shared/contracts/worker-context";

export const WORKER_CONTEXT_MIGRATION = `CREATE TABLE agency_worker_context (
 scope TEXT NOT NULL CHECK(scope IN ('agent','department')), scope_id TEXT NOT NULL,
 revision INTEGER NOT NULL, policy_json TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(scope, scope_id)
);
CREATE TABLE agency_worker_context_request (request_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, result_json TEXT NOT NULL);`;
export function readWorkerContext(db: SqlDatabase, query: WorkerContextQuery) {
 const row = db.prepare("SELECT revision, policy_json FROM agency_worker_context WHERE scope = ? AND scope_id = ?").get(query.scope, query.scopeId) as {revision:number;policy_json:string}|undefined;
 return { ...query, revision: row?.revision ?? 0, policy: row ? workerContextPolicySchema.parse(JSON.parse(row.policy_json)) : {} };
}
export function saveWorkerContext(db: SqlDatabase, raw: unknown) {
 const input = saveWorkerContextSchema.parse(raw);
 return db.transaction(() => {
  const payload = JSON.stringify(input);
  const prior = db.prepare("SELECT payload_json, result_json FROM agency_worker_context_request WHERE request_id = ?").get(input.requestId) as {payload_json:string;result_json:string}|undefined;
  if(prior) return prior.payload_json === payload ? ok(JSON.parse(prior.result_json) as ReturnType<typeof readWorkerContext>) : fail("request_id_reused", "Request ID belongs to another change.");
  const current = readWorkerContext(db, input);
  if(current.revision !== input.expectedRevision) return fail("revision_conflict", `Context revision is ${current.revision}; reload before saving.`);
  const result = {scope:input.scope,scopeId:input.scopeId,revision:current.revision+1,policy:input.policy};
  db.prepare("INSERT INTO agency_worker_context VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope,scope_id) DO UPDATE SET revision=excluded.revision,policy_json=excluded.policy_json,updated_at=excluded.updated_at").run(input.scope,input.scopeId,result.revision,JSON.stringify(input.policy),new Date().toISOString());
  db.prepare("INSERT INTO agency_worker_context_request VALUES (?,?,?)").run(input.requestId,payload,JSON.stringify(result));
  return ok(result);
 })();
}
export function contextForLaunch(db: SqlDatabase, departmentId: string, agentId: string) {
 const department = readWorkerContext(db,{scope:"department",scopeId:departmentId});
 const agent = readWorkerContext(db,{scope:"agent",scopeId:agentId});
 const policy: WorkerContextPolicy = {...department.policy,...agent.policy};
 return Object.keys(policy).length ? {policy,departmentRevision:department.revision,agentRevision:agent.revision} : null;
}
