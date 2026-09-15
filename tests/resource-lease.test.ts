import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createResourceLeaseStore, RESOURCE_LEASE_MIGRATION, type ResourceQuiescencePort } from "../src/server/runtime/resource-lease";
const dirs:string[]=[];const handles:Database.Database[]=[];
afterEach(()=>{for(const db of handles.splice(0))if(db.open)db.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function fixture(port:ResourceQuiescencePort={verify:async()=>"confirmed"}) {
 const dir=mkdtempSync(join(tmpdir(),"agy-lease-"));dirs.push(dir);const path=join(dir,"db.sqlite");
 const db=new Database(path);handles.push(db);db.pragma("journal_mode=WAL");db.exec(RESOURCE_LEASE_MIGRATION);
 let time=10000;return {db,path,store:createResourceLeaseStore(db,port,()=>time),advance:(n:number)=>{time+=n;},now:()=>time};
}
const input={hostId:"host_one",canonicalRoot:"/workspace",ownerAttemptId:"run_one",ttlMs:1000};
describe("exclusive workspace lease",()=>{
 it("serializes two connections and overlapping roots, isolates hosts",()=>{
  const f=fixture();const db2=new Database(f.path);handles.push(db2);const second=createResourceLeaseStore(db2,{verify:async()=>"confirmed"},f.now);
  f.store.acquire(input);
  for(const canonicalRoot of ["/workspace","/workspace/child","/"])expect(()=>second.acquire({...input,canonicalRoot,ownerAttemptId:"run_two"})).toThrow("resource_busy");
  expect(second.acquire({...input,hostId:"host_two",ownerAttemptId:"run_two"}).ownerAttemptId).toBe("run_two");
 });
 it("expiry and reopen cannot authorize takeover or stale renew",()=>{
  const f=fixture();const claim=f.store.acquire(input);f.advance(1001);f.db.close();
  const db=new Database(f.path);handles.push(db);const store=createResourceLeaseStore(db,{verify:async()=>"confirmed"},f.now);
  expect(()=>store.acquire({...input,ownerAttemptId:"run_two"})).toThrow("lease_needs_reconciliation");
  expect(()=>store.renew(claim,1000)).toThrow("lease_needs_reconciliation");expect(()=>store.assertCurrent(claim)).toThrow("lease_needs_reconciliation");
 });
 it("requires quiescence proof and fences the old owner after release",async()=>{
  let ready=false;const f=fixture({verify:async()=>ready?"confirmed":"unavailable"});const claim=f.store.acquire(input);
  await expect(f.store.release(claim)).rejects.toThrow("resource_quiescence_unproven");
  expect(()=>f.store.acquire({...input,ownerAttemptId:"run_two"})).toThrow("resource_busy");
  ready=true;await f.store.release(claim);const next=f.store.acquire({...input,ownerAttemptId:"run_two"});
  expect(next.generation).toBe(claim.generation+1);expect(next.token).not.toBe(claim.token);
  expect(()=>f.store.renew(claim,1000)).toThrow("lease_fence_mismatch");await expect(f.store.release(claim)).rejects.toThrow("lease_fence_mismatch");
  expect(f.store.assertCurrent(next)).toEqual(next);
 });
 it("rechecks ownership after asynchronous release verification",async()=>{
  let resolve!:(result:"confirmed")=>void;let calls=0;
  const f=fixture({verify:async()=>{calls++;if(calls===1)return new Promise(r=>{resolve=r;});return "confirmed";}});
  const first=f.store.acquire(input);const pending=f.store.release(first);await f.store.release(first);
  const next=f.store.acquire({...input,ownerAttemptId:"run_two"});resolve("confirmed");
  await expect(pending).rejects.toThrow("lease_fence_mismatch");expect(f.store.assertCurrent(next).ownerAttemptId).toBe("run_two");
 });
 it("same owner replay does not renew; canonical root and TTL are required",()=>{
  const f=fixture();const first=f.store.acquire(input);f.advance(100);expect(f.store.acquire(input)).toEqual(first);
  expect(f.store.renew(first,1000).expiresAt).toBe(11100);
  expect(()=>f.store.acquire({...input,canonicalRoot:"/workspace/../other"})).toThrow("resource_root_not_canonical");
  expect(()=>f.store.acquire({...input,ttlMs:0})).toThrow("lease_ttl_invalid");
 });
});
