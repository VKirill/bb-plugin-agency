import { useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../shared/rpc-contract";
import { sections, seedAgents, seedJobs, seedDepartments, seedProjects, seedAutomations } from "./data";
import { Button, Icon, Choice, Empty } from "./shared";
import { JobsPage, JobDetail } from "./jobs";
import { AgentsPage, AgentDetail, GroupsPage, GroupDetail } from "./people";
import { AutomationsPage, AutomationDetail } from "./automation";
import { HomePage, InboxPage, RunsPage, KnowledgePage, SettingsPage } from "./system";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../../../components/ui/dialog";

export function AgencyPrototype({ subPath }: PluginNavPanelProps) {
 const navigate=useBbNavigate();const rpc=useRpc<typeof rpcContract>();
 const [jobs,setJobs]=useState(()=>structuredClone(seedJobs));
 const [agents,setAgents]=useState(()=>structuredClone(seedAgents));
 const [departments,setDepartments]=useState(()=>structuredClone(seedDepartments));
 const [projects,setProjects]=useState(()=>structuredClone(seedProjects));
 const [automations,setAutomations]=useState(()=>structuredClone(seedAutomations));
 const [hosts,setHosts]=useState<{id:string;name:string}[]>([]);
 const [message,setMessage]=useState("");const[resetOpen,setResetOpen]=useState(false);
 const [section="home",id]=subPath.split("/").filter(Boolean);
 const go=(s:string,item?:string)=>navigate.toPluginPanel("overview",{subPath:item?`${s}/${item}`:s});
 useEffect(()=>{let live=true;rpc.call("uiContext").then(r=>{if(live)setHosts(r.hosts);},()=>{if(live)setHosts([]);});return()=>{live=false;};},[rpc]);
 const reset=()=>{setJobs(structuredClone(seedJobs));setAgents(structuredClone(seedAgents));setDepartments(structuredClone(seedDepartments));setProjects(structuredClone(seedProjects));setAutomations(structuredClone(seedAutomations));setResetOpen(false);go("home");setMessage("Пример сброшен.");};
 const agent=agents.find(a=>a.id===id);const job=jobs.find(j=>j.id===id);const automation=automations.find(a=>a.id===id);
 const group=(section==="projects"?projects:departments).find(g=>g.id===id);
 const newAgent=()=>{const id=`agent-${Date.now()}`;setAgents([...agents,{...structuredClone(seedAgents[1]),id,name:"Новый сотрудник",role:"Укажите роль",skills:[],mcps:[]}]);go("agents",id);};
 const newGroup=(kind:"projects"|"departments")=>{const g={id:`group-${Date.now()}`,name:kind==="projects"?"Новый проект":"Новый отдел",description:"Опишите назначение",lead:"Мария",members:[],instructions:"",enabled:false};if(kind==="projects")setProjects([...projects,g]);else setDepartments([...departments,g]);go(kind,g.id);};
 const newAutomation=()=>{const a={...seedAutomations[0],id:`rule-${Date.now()}`,name:"Новая автоматизация",enabled:false};setAutomations([...automations,a]);go("automations",a.id);};
 let page;
 if(section==="home")page=<HomePage jobs={jobs} go={go}/>;
 else if(section==="jobs")page=id?(job?<JobDetail key={id} job={job} update={j=>setJobs(jobs.map(x=>x.id===j.id?j:x))} back={()=>go("jobs")} notice={setMessage} openRun={()=>go("runs","RUN-204")}/>:<Empty title="Задача не найдена" description="Вернитесь к списку задач."/>):<JobsPage jobs={jobs} setJobs={setJobs} open={id=>go("jobs",id)}/>;
 else if(section==="agents")page=id?(agent?<AgentDetail key={id} agent={agent} update={a=>setAgents(agents.map(x=>x.id===a.id?a:x))} hosts={hosts} back={()=>go("agents")} notice={setMessage}/>:<Empty title="Сотрудник не найден" description="Выберите профиль из списка."/>):<AgentsPage agents={agents} open={id=>go("agents",id)} create={newAgent}/>;
 else if(section==="projects"||section==="departments")page=id?(group?<GroupDetail key={`${section}-${id}`} kind={section} group={group} update={g=>section==="projects"?setProjects(projects.map(x=>x.id===g.id?g:x)):setDepartments(departments.map(x=>x.id===g.id?g:x))} jobs={jobs} setJobs={setJobs} openJob={id=>go("jobs",id)} back={()=>go(section)} notice={setMessage} people={section==="projects"?departments.map(d=>d.name):agents.map(a=>a.name)}/>:<Empty title="Запись не найдена" description="Вернитесь к списку."/>):<GroupsPage groups={section==="projects"?projects:departments} kind={section} open={id=>go(section,id)} create={()=>newGroup(section)}/>;
 else if(section==="automations")page=id?(automation?<AutomationDetail key={id} item={automation} update={a=>setAutomations(automations.map(x=>x.id===a.id?a:x))} back={()=>go("automations")} notice={setMessage}/>:<Empty title="Правило не найдено" description="Выберите автоматизацию из списка."/>):<AutomationsPage items={automations} open={id=>go("automations",id)} create={newAutomation} update={a=>setAutomations(automations.map(x=>x.id===a.id?a:x))}/>;
 else if(section==="inbox")page=<InboxPage go={go} notice={setMessage}/>;
 else if(section==="runs")page=<RunsPage detail={Boolean(id)} open={()=>go("runs","RUN-204")} back={()=>go("runs")} notice={setMessage}/>;
 else if(section==="knowledge")page=<KnowledgePage notice={setMessage}/>;
 else if(section==="settings")page=<SettingsPage hosts={hosts} notice={setMessage} reset={()=>setResetOpen(true)}/>;
 else page=<Empty title="Страница не найдена" description="Выберите раздел в навигации."/>;
 return <div className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-1 text-xs"><span><strong>Прототип</strong> · Пример данных, изменения до перезагрузки. Агенты не запускаются.</span><Button variant="ghost" size="sm" onClick={()=>setResetOpen(true)}>Сбросить пример</Button></div>
 <div className="flex min-h-0 min-w-0 flex-1"><nav aria-label="Разделы агентства" className="hidden w-40 shrink-0 space-y-0.5 overflow-y-auto border-r border-border px-2 py-2 lg:block">{sections.map(([key,label,icon])=><button key={key} aria-current={section===key?"page":undefined} onClick={()=>go(key)} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted ${section===key?"bg-muted font-medium":"text-muted-foreground"}`}><Icon name={icon} className="size-4"/>{label}</button>)}</nav>
 <div className="min-w-0 flex-1 overflow-y-auto"><div className="border-b border-border p-3 lg:hidden"><Choice label="Раздел агентства" value={section} onChange={s=>go(s)} options={sections.map(([value,label])=>({value,label}))}/></div><div className="mx-auto w-full max-w-none space-y-3 p-3 md:p-4">{message&&<div role="status" className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm"><span>{message}</span><Button size="sm" variant="ghost" aria-label="Закрыть сообщение" onClick={()=>setMessage("")}>×</Button></div>}{page}</div></div></div>
 <Dialog open={resetOpen} onOpenChange={setResetOpen}><DialogContent><DialogHeader><DialogTitle>Сбросить пример?</DialogTitle><DialogDescription>Изменения демонстрационных карточек будут сброшены. Реальные задачи и настройки BB не затрагиваются.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={()=>setResetOpen(false)}>Отмена</Button><Button onClick={reset}>Сбросить</Button></DialogFooter></DialogContent></Dialog></div>;
}
