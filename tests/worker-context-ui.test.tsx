/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WorkerContextView } from "../src/shared/contracts/worker-context";
const calls: {method:string;input:unknown}[]=[];
let available=true;let refuse=false;
const rpc={call:async(method:string,input:unknown)=>{
 calls.push({method,input});
 if(method==="saveWorkerContext")return refuse?{ok:false,error:{code:"revision_conflict",message:"Context changed"}}:{ok:true,value:{...(input as object),revision:3}};
 return {ok:true,value:{scope:"agent",scopeId:"agent_aaaaaaaa",revision:2,policy:{},available,contributions:[],inherited:[]} satisfies WorkerContextView};
}};
vi.mock("@get-bb/plugin-sdk/app",()=>({useRpc:()=>rpc}));
const {WorkerContextPanel}=await import("../src/app/prototype/worker-context");
let root:Root|null=null;let host:HTMLElement|null=null;
afterEach(()=>{act(()=>root?.unmount());host?.remove();root=null;host=null;available=true;refuse=false;calls.length=0;});
async function render(){host=document.createElement("div");document.body.append(host);root=createRoot(host);await act(async()=>root!.render(createElement(WorkerContextPanel,{scope:"agent",scopeId:"agent_aaaaaaaa",notice:vi.fn()})));}
const button=(text:string)=>Array.from(host!.querySelectorAll("button")).find(b=>b.textContent===text)!;
describe("worker context editor",()=>{
 it("does not expose configuration on ordinary BB",async()=>{available=false;await render();expect(host!.querySelector('[data-testid="worker-context"]')).toBeNull();});
 it("saves the assigned preset with CAS and keeps a rejected draft",async()=>{
  await render();await act(async()=>button("Только назначенное в профиле и задаче").click());
  refuse=true;await act(async()=>button("Сохранить контекст").click());
  expect(calls.find(c=>c.method==="saveWorkerContext")?.input).toMatchObject({expectedRevision:2,scope:"agent",policy:{skills:{mode:"assigned",names:[]},bbPlugins:{mode:"assigned",names:[]},mcpServers:{mode:"allow",names:[]}}});
  expect(host!.textContent).toContain("Context changed");expect(button("Сохранить контекст").disabled).toBe(false);
  refuse=false;await act(async()=>button("Сохранить контекст").click());
  expect(button("Сохранить контекст").disabled).toBe(true);
 });
});
