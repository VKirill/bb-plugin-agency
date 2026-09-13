import { type TaskScope, inTaskScope, scopeTitle } from "./task-scope";
export type { TaskScope } from "./task-scope";
import { useState, type ReactNode } from "react";
import type { Agent, Group, Job } from "./data";
import { JobsPage } from "./jobs";
import { AgentMark, Button, Icon } from "./shared";
import "./jobs-workspace.css";

export function JobsWorkspace({jobs,setJobs,agents,projects,departments,scope,setScope,open,go}:{jobs:Job[];setJobs:(jobs:Job[])=>void;agents:Agent[];projects:Group[];departments:Group[];scope:TaskScope;setScope:(scope:TaskScope)=>void;open:(id:string)=>void;go:(section:string)=>void}) {
 const [expanded,setExpanded]=useState(false);
 const choose=(next:TaskScope)=>{setScope(next);setExpanded(false);};
 const item=(next:TaskScope,label:string,icon:ReactNode)=>{
  const selected=scope.kind===next.kind&&scope.value===next.value;
  const count=jobs.filter(job=>inTaskScope(job,next)).length;
  return <button key={`${next.kind}-${next.value||""}`} aria-pressed={selected} onClick={()=>choose(next)} className={`flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted focus-visible:outline focus-visible:outline-ring ${selected?"bg-muted font-medium":""}`}><span className="shrink-0 text-muted-foreground">{icon}</span><span className="min-w-0 flex-1 truncate">{label}</span><span className="text-xs tabular-nums text-muted-foreground">{count}</span></button>;
 };
 return <div className="agency-jobs-workspace"><div className="agency-jobs-grid">
  <div className="agency-jobs-main min-w-0"><JobsPage jobs={jobs} setJobs={setJobs} open={open} scope={scope}/></div>
  <aside aria-label="Выбор задач" className="agency-jobs-nav min-w-0 rounded-xl border border-border bg-muted/20 p-3" data-expanded={expanded}>
   <Button variant="ghost" className="agency-jobs-nav-toggle w-full justify-between px-1" aria-expanded={expanded} aria-controls="agency-task-scopes" onClick={()=>setExpanded(!expanded)}><span className="truncate">Выбор задач · {scopeTitle(scope)}</span><Icon name={expanded?"ChevronUp":"ChevronDown"} className="size-4"/></Button>
   <div id="agency-task-scopes" className="agency-jobs-nav-content space-y-5">
    <div><h2 className="mb-2 px-2 text-xs font-semibold text-muted-foreground">Показать задачи</h2>{item({kind:"all"},"Все задачи",<Icon name="ListTodo" className="size-4"/>)}{item({kind:"attention"},"Требуют внимания",<Icon name="AlertCircle" className="size-4"/>)}{item({kind:"active"},"В работе",<Icon name="Play" className="size-4"/>)}</div>
    <section><div className="mb-2 flex items-center justify-between px-2"><h2 className="text-xs font-semibold text-muted-foreground">Проекты</h2><button aria-label="Управлять проектами" onClick={()=>go("projects")} className="rounded p-1 text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-ring"><Icon name="Settings" className="size-3.5"/></button></div>{projects.map(p=>item({kind:"project",value:p.name},p.name,<Icon name="Folder" className="size-4"/>))}</section>
    <section><div className="mb-2 flex items-center justify-between px-2"><h2 className="text-xs font-semibold text-muted-foreground">Отделы</h2><button aria-label="Управлять отделами" onClick={()=>go("departments")} className="rounded p-1 text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-ring"><Icon name="Settings" className="size-3.5"/></button></div>{departments.map(d=>item({kind:"department",value:d.name},d.name,<Icon name="Layers" className="size-4"/>))}</section>
    <section><div className="mb-2 flex items-center justify-between px-2"><h2 className="text-xs font-semibold text-muted-foreground">Сотрудники</h2><button aria-label="Управлять сотрудниками" onClick={()=>go("agents")} className="rounded p-1 text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-ring"><Icon name="Settings" className="size-3.5"/></button></div>{agents.map(a=>item({kind:"agent",value:a.name},a.name,<AgentMark id={a.selection.providerId} className="size-4"/>))}</section>
   </div>
  </aside>
 </div></div>;
}
