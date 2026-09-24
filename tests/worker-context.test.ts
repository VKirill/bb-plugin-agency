import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { makePluginAgentConfigurationContext, createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openMigratedDatabase } from "../src/server/db";
import { contextForLaunch, readWorkerContext, saveWorkerContext } from "../src/server/runtime/worker-context/store";
import { freezeWorkerContext } from "../src/server/runtime/worker-context/policy";
import { registerWorkerContext, resolveWorkerContext } from "../src/server/runtime/worker-context/resolver";
import { workerContextPolicySchema } from "../src/shared/contracts/worker-context";

const scopeId="agent_aaaaaaaa";
const skills=[{name:"agency",role:"core"},{name:"agency-artifacts",role:"helper"},{name:"copywriter",role:"method"}];
describe("worker context",()=>{
 it("inherits per field, uses CAS, deduplicates requests and freezes previous selections",()=>{
  const db=openMigratedDatabase(new Database(":memory:"));
  try{
   expect(contextForLaunch(db,"departme_aaaaaaaa",scopeId)?.policy).toEqual({skills:{mode:"assigned",names:[]},bbPlugins:{mode:"assigned",names:[]}});
   const department={scope:"department",scopeId:"departme_aaaaaaaa",requestId:randomUUID(),expectedRevision:0,policy:{skills:{mode:"assigned",names:[]},bbPlugins:{mode:"assigned",names:[]}}};
   const saved=saveWorkerContext(db,department);expect(saved.ok).toBe(true);
   expect(saveWorkerContext(db,department)).toEqual(saved);
   expect(saveWorkerContext(db,{...department,requestId:randomUUID()}).ok).toBe(false);
   expect(saveWorkerContext(db,{...department,policy:{}}).ok).toBe(false);
   const old=freezeWorkerContext(contextForLaunch(db,department.scopeId,scopeId),skills,["env-catalog"]);
   expect(old?.policy.skills).toEqual({mode:"allow",names:["agency","agency-artifacts","copywriter"]});
   saveWorkerContext(db,{scope:"agent",scopeId,requestId:randomUUID(),expectedRevision:0,policy:{skills:{mode:"deny",names:["unused*"]}}});
   const selected=contextForLaunch(db,department.scopeId,scopeId)!;
   expect(selected.agentRevision).toBe(1);expect(selected.policy.bbPlugins?.mode).toBe("assigned");
   expect(selected.policy.skills?.mode).toBe("deny");expect(old?.policy.skills?.mode).toBe("allow");
   saveWorkerContext(db,{scope:"agent",scopeId,requestId:randomUUID(),expectedRevision:1,policy:{}});
   expect(contextForLaunch(db,department.scopeId,scopeId)?.policy.skills?.mode).toBe("assigned");
   expect(readWorkerContext(db,{scope:"agent",scopeId}).revision).toBe(2);
  }finally{db.close();}
 });
 it("keeps required services, supports empty allow and deny, rejects wildcard denial of Agency",()=>{
  const input={departmentRevision:1,agentRevision:0,policy:workerContextPolicySchema.parse({skills:{mode:"allow",names:[]},bbPlugins:{mode:"assigned",names:[]},mcpServers:{mode:"allow",names:[]},nativePlugins:{mode:"deny",names:[]},projectInstructions:false})};
  const frozen=freezeWorkerContext(input,skills,["writer-tools"],["artifact-tools"])!;
  expect(frozen.policy.skills?.names).toEqual(["agency","agency-artifacts"]);
  expect(frozen.policy.bbPlugins?.names).toEqual(["agency","artifact-tools","writer-tools"]);
  expect(frozen.policy.mcpServers).toEqual({mode:"allow",names:[]});
  expect(frozen.policy.projectInstructions).toBe(false);
  expect(()=>freezeWorkerContext({...input,policy:{skills:{mode:"deny",names:["agency*"]}}},skills,[])).toThrow("service dependency");
  expect(()=>freezeWorkerContext({...input,policy:{skills:{mode:"assigned",names:[]}}},[{role:"core"}],[])).toThrow("name_missing");
 });
 it("resolves only database-backed thread identity, preserves the first session snapshot and legacy null",()=>{
  const db=openMigratedDatabase(new Database(":memory:"));
  try{
   db.pragma("foreign_keys = OFF");
   const snapshot={binding:{bbProjectId:"proj_test",hostId:"host_test",canonicalRoot:"/work"},agentVersion:{providerId:"codex"},workerContext:{policy:{skills:{mode:"allow",names:["agency"]}}}};
   db.prepare("INSERT INTO agency_context_snapshot VALUES ('snap_test','job_test','digest',?,'2026-09-24T00:00:00Z')").run(JSON.stringify(snapshot));
   db.prepare("INSERT INTO agency_run_attempt (id,job_id,attempt_no,snapshot_id,digest,thread_id,launch_id,state,revision,created_at,updated_at) VALUES ('run_test','job_test',1,'snap_test','digest',NULL,'launch_test','launching',1,'2026-09-24T00:00:00Z','2026-09-24T00:00:00Z')").run();
   const context=makePluginAgentConfigurationContext();
   const ctx={...context,pluginMetadata:{agencyAttemptId:"run_test",agencyLaunchId:"launch_test",agencyJobId:"job_test"},thread:{...context.thread,id:"thr_test"},project:{...context.project,id:"proj_test"},host:{...context.host,id:"host_test"},provider:{...context.provider,id:"codex"},environment:{...context.environment,path:"/work"}};
   expect(resolveWorkerContext(db,ctx)).toEqual(snapshot.workerContext.policy);
   db.prepare("UPDATE agency_run_attempt SET thread_id='thr_test',state='running'").run();
   expect(resolveWorkerContext(db,{...ctx,thread:{...ctx.thread,id:"thr_forged"}})).toBeNull();
   expect(resolveWorkerContext(db,{...ctx,pluginMetadata:{}})).toBeNull();
   expect(resolveWorkerContext(db,{...ctx,host:{...ctx.host,id:"host_foreign"}})).toBeNull();
   expect(resolveWorkerContext(db,{...ctx,pluginMetadata:{...ctx.pluginMetadata,agencyJobId:"job_foreign"}})).toBeNull();
   saveWorkerContext(db,{scope:"agent",scopeId,requestId:randomUUID(),expectedRevision:0,policy:{skills:{mode:"deny",names:[]}}});
   expect(resolveWorkerContext(db,ctx)).toEqual(snapshot.workerContext.policy);
   db.prepare("UPDATE agency_context_snapshot SET snapshot_json=?").run(JSON.stringify({...snapshot,workerContext:undefined}));
   expect(resolveWorkerContext(db,ctx)).toBeNull();
  }finally{db.close();}
 });
 it("feature-tests upstream BB without registering or claiming support",async()=>{
  const {bb,harness}=createFakePluginHost({pluginId:"agency"});
  const db=openMigratedDatabase(new Database(":memory:"));
  expect(registerWorkerContext(bb,db).available).toBe(false);
  db.close();await harness.lifecycle.dispose();
 });
});
