import { GoalsPage } from "./goals";
import { useArchivedJobs } from "./use-archived-job";
import { KnowledgeLivePage } from "./knowledge-live";
import { setUiLanguage, tr, uiLanguage, type UiLanguage } from "../i18n";
import { AGENCY_LANGUAGE_EVENT } from "./agency-language";
import { TemplatesProvider } from "./use-templates";
import { policySummary } from "../data/role-types";
import { JobsWorkspace, type TaskScope } from "./jobs-workspace";
import { useEffect, useMemo, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../shared/rpc-contract";
import { sections, type Automation, type Job } from "./data";
import { Button, Icon, Choice, Empty } from "./shared";
import { JobDetail } from "./jobs";
import { AgentsPage, AgentDetail, GroupsPage, GroupDetail } from "./people";
import { ProjectPage, ProjectsPage } from "./projects-live";
import { AgencyCreateDialogs } from "./create-forms";
import { AutomationsPage, AutomationDetail } from "./automation";
import { InboxPage } from "./inbox";
import { KnowledgePage, type Material } from "./knowledge";
import { RunsPage, SettingsPage, seedSettings } from "./system";
import { UsagePage } from "./usage-page";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../../../components/ui/dialog";
import { UNKNOWN_CALLER_MESSAGE, createRpcAgencyApi, useAgencyWorkspace } from "../data";
import type { RpcCaller } from "../data";
import { DispatcherAutomationsPage } from "./dispatcher-automations";
import { resolveWorkspaceProjectId } from "../data/dispatcher";
import { demoAgents, demoAutomations, demoDepartments, demoJobs, demoProjects, demoRuns } from "./demo/catalog";
import { seedRuns } from "./run-links";

const demoMaterials: Material[] = [
  {id:"project",title:"Правила SelfyStudio",scope:"SelfyStudio",source:"Решение владельца · пример",body:"Объясняем услугу простым языком. Не обещаем результат без подтверждения.",status:"accepted"},
  {id:"department",title:"Порядок работы редакции",scope:"Редакция",source:"Правила отдела · пример",body:"Бриф → текст → проверка → исправления.",status:"accepted"},
];

/** Sections that are still an interface example in live mode: marked so a demo is not taken for working data. */
const PILOT_SECTIONS = new Set<string>();

/**
 * Interface language follows the Agency language setting. The shell remounts on
 * a change, so texts computed outside components are translated as well.
 */
export function AgencyPrototype(props: PluginNavPanelProps) {
 const rpc=useRpc<typeof rpcContract>();
 const [language,setLanguage]=useState<UiLanguage>(uiLanguage());
 useEffect(()=>{
  let live=true;
  const load=()=>{void Promise.resolve(rpc.call("agencyLanguage",null)).then((value)=>{if(!live)return;const next=(value as {language:UiLanguage}).language==="en"?"en":"ru";setUiLanguage(next);setLanguage(next);},()=>undefined);};
  load();
  window.addEventListener(AGENCY_LANGUAGE_EVENT,load);
  return()=>{live=false;window.removeEventListener(AGENCY_LANGUAGE_EVENT,load);};
 },[rpc]);
 setUiLanguage(language);
 return <AgencyShell key={language} {...props}/>;
}

function AgencyShell({ subPath }: PluginNavPanelProps) {
 const navigate=useBbNavigate();const rpc=useRpc<typeof rpcContract>();
 const workspace=useAgencyWorkspace(rpc as unknown as RpcCaller);
 const [demoMode,setDemoMode]=useState(false);
 const [settings,setSettings]=useState(()=>({...seedSettings}));
 const [materials,setMaterials]=useState<Material[]>(()=>[]);
 const [readIds,setReadIds]=useState<string[]>([]);
 const [automations,setAutomations]=useState<Automation[]>(()=>[]);
 const [demoJobsState,setDemoJobsState]=useState(()=>structuredClone(demoJobs));
 const [demoAgentsState,setDemoAgentsState]=useState(()=>structuredClone(demoAgents));
 const [demoDepartmentsState,setDemoDepartmentsState]=useState(()=>structuredClone(demoDepartments));
 const [demoProjectsState,setDemoProjectsState]=useState(()=>structuredClone(demoProjects));
 const [primaryHostId,setPrimaryHostId]=useState<string|null>(null);const [hosts,setHosts]=useState<{id:string;name:string}[]>([]);
 const [resetOpen,setResetOpen]=useState(false);
 const [requestedSection="jobs",id]=subPath.split("/").filter(Boolean);
 const section=requestedSection==="home"?"jobs":requestedSection;
 const [taskScope,setTaskScope]=useState<TaskScope>({kind:"all"});
 const [createKind,setCreateKind]=useState<"project"|"agent"|"department"|null>(null);
 const go=(s:string,item?:string)=>navigate.toPluginPanel("overview",{subPath:item?`${s}/${item}`:s});
 useEffect(()=>{let live=true;rpc.call("uiContext").then(r=>{if(live){setHosts(r.hosts);setPrimaryHostId(r.primaryHostId??null);}},()=>{if(live)setHosts([]);});return()=>{live=false;};},[rpc]);
 const dispatcherApi=useMemo(()=>createRpcAgencyApi(rpc as unknown as RpcCaller),[rpc]);
 const jobs=demoMode?demoJobsState:workspace.jobs;
 const agents=demoMode?demoAgentsState:workspace.agents;
 const departments=demoMode?demoDepartmentsState:workspace.departments;
 const projects=demoMode?demoProjectsState:workspace.projects;
 const persistJob=async(job:Job):Promise<boolean>=>{
  if(demoMode){setDemoJobsState(current=>current.some(item=>item.id===job.id)?current.map(item=>item.id===job.id?job:item):[...current,job]);return true;}
  if(!workspace.persistable){workspace.setMessage(workspace.message||tr("Запись недоступна: сервер не отдал рабочий снимок."));return false;}
  if(job.recordId){return (await workspace.updateJob(job))!==false;}
  return workspace.addJob(job);
 };
 const enterDemo=()=>{
  setDemoMode(true);
  setDemoJobsState(structuredClone(demoJobs));
  setDemoAgentsState(structuredClone(demoAgents));
  setDemoDepartmentsState(structuredClone(demoDepartments));
  setDemoProjectsState(structuredClone(demoProjects));
  setAutomations(structuredClone(demoAutomations));
  setMaterials(structuredClone(demoMaterials));
  workspace.setMessage("");
 };
 const leaveDemo=()=>{setDemoMode(false);setAutomations([]);setMaterials([]);void workspace.reload();workspace.setMessage("");};
 const reset=()=>{
  setSettings({...seedSettings});setReadIds([]);setResetOpen(false);setTaskScope({kind:"all"});go("jobs");
  if(demoMode){enterDemo();return;}
  setMaterials([]);setAutomations([]);void workspace.reload();workspace.setMessage(tr("Локальные черновики сброшены."));
 };
 const liveJob=jobs.find(j=>j.id===id);
 const archived=useArchivedJobs(dispatcherApi,workspace.snapshot,section==="jobs"?id:undefined,!demoMode&&workspace.status==="ready"&&!liveJob);
 const archivedJob=liveJob?undefined:archived.jobs.find(j=>j.id===id);
 const archivedReadOnly=async()=>{workspace.setMessage(tr("Задача в архиве: изменения недоступны."));return false;};
 const agent=agents.find(a=>a.id===id);const job=liveJob??archivedJob;const automation=automations.find(a=>a.id===id);
 const group=(section==="projects"?projects:departments).find(g=>g.id===id);
 const gated=workspace.status==="gated";
 const newAgent=()=>{if(demoMode){const created={...structuredClone(demoAgents[1]),id:`agent-${Date.now()}`,name:tr("Новый сотрудник"),role:tr("Укажите роль"),skills:[],mcps:[]};setDemoAgentsState([...demoAgentsState,created]);go("agents",created.id);return;}setCreateKind("agent");};
 const newGroup=(kind:"projects"|"departments")=>{if(demoMode){const created={id:`group-${Date.now()}`,name:kind==="projects"?tr("Новый проект"):tr("Новый отдел"),description:tr("Опишите назначение"),lead:"Мария",members:[],instructions:"",enabled:false};if(kind==="projects")setDemoProjectsState([...demoProjectsState,created]);else setDemoDepartmentsState([...demoDepartmentsState,created]);go(kind,created.id);return;}setCreateKind(kind==="projects"?"project":"department");};
 const projectId=resolveWorkspaceProjectId(projects, workspace.snapshot.bindings[0]?.id ?? "");
 const newAutomation=()=>{if(demoMode){const created={...demoAutomations[0],id:`rule-${Date.now()}`,name:tr("Новая автоматизация"),enabled:false};setAutomations([...automations,created]);go("automations",created.id);return;}go("automations");};
 const loadFailed=!demoMode&&(gated||workspace.status==="unavailable"||workspace.status==="error");
 const jobsBlocked=loadFailed&&section==="jobs"&&!id;
 const statusNote=demoMode?""
  :workspace.status==="loading"?tr("Проверяем доступ к постоянным данным…")
  :loadFailed&&!jobsBlocked?(workspace.message||tr(UNKNOWN_CALLER_MESSAGE))
  :workspace.conflict?tr("Конфликт ревизии. Загрузите серверную версию или повторите правку.")
  :"";
 const noticeText=demoMode||loadFailed||workspace.status==="loading"||workspace.conflict?"":workspace.message;
 const actions=()=><div className="flex flex-col items-stretch gap-1 p-1">
  {demoMode?<Button variant="ghost" size="sm" className="justify-start" onClick={leaveDemo}>{tr("Выйти из примера")}</Button>:<Button variant="ghost" size="sm" className="justify-start" onClick={enterDemo}>{tr("Показать пример")}</Button>}
  <Button variant="ghost" size="sm" className="justify-start" onClick={()=>void workspace.reload()}>{tr("Обновить")}</Button>
  <Button variant="ghost" size="sm" className="justify-start" onClick={()=>setResetOpen(true)}>{tr("Сбросить")}</Button>
 </div>;
 let page;
  if(!demoMode&&(gated||workspace.status==="unavailable"||workspace.status==="error")&&section==="jobs"&&!id){
  page=<Empty title="Запись недоступна" description={workspace.message||UNKNOWN_CALLER_MESSAGE}/>;
 }
 else if(section==="jobs")page=id?(job?<JobDetail demoMode={demoMode} agents={agents} projects={projects} departments={departments} key={id} job={job} jobs={archivedJob?[...jobs,...archived.jobs]:jobs} openJob={id=>go("jobs",id)} addJob={j=>archivedJob?archivedReadOnly():persistJob(j)} update={j=>archivedJob?archivedReadOnly():persistJob(j)} back={()=>go("jobs")} notice={workspace.setMessage} openRun={runId=>go("runs",runId)} openUsage={recordId=>go("usage",recordId)} runs={demoMode?seedRuns:[]}/>:(!demoMode&&(workspace.status==="loading"||archived.loading)?<Empty title="Загружаем задачу" description="Читаем карточку из постоянного хранилища."/>:<Empty title="Задача не найдена" description="Вернитесь к списку задач."/>)):<JobsWorkspace jobs={jobs} setJobs={demoMode?setDemoJobsState:workspace.setJobs} persist={persistJob} notice={workspace.setMessage} open={id=>go("jobs",id)} agents={agents} projects={projects} departments={departments} scope={taskScope} setScope={setTaskScope} go={go} board={demoMode?undefined:workspace.snapshot.board} archive={demoMode?undefined:{api:dispatcherApi,count:workspace.snapshot.archivedCount??0}}/>;
 else if(section==="agents")page=id?(agent?<AgentDetail key={id} primaryHostId={primaryHostId} folders={projects.filter(item=>!item.archivedAt).map(item=>({id:item.recordId??item.id,label:item.name}))} agent={agent} update={a=>demoMode?setDemoAgentsState(demoAgentsState.map(x=>x.id===a.id?a:x)):workspace.updateAgent(a)} hosts={hosts} back={()=>go("agents")} notice={workspace.setMessage} live={!demoMode} catalog={workspace.catalog} commit={demoMode?undefined:workspace.commitAgent} policies={workspace.snapshot.policies.map(policy=>({id:policy.id,summary:policySummary(policy,id=>hosts.find(host=>host.id===id)?.name??id)}))}/>:(!demoMode&&workspace.status==="loading"?<Empty title="Загружаем сотрудника" description="Читаем профиль из постоянного хранилища."/>:<Empty title="Сотрудник не найден" description="Выберите профиль из списка."/>)):<AgentsPage agents={agents} open={id=>go("agents",id)} create={newAgent}/>;
 else if(section==="projects"&&!demoMode)page=id?(group?<ProjectPage key={id} project={group} projects={projects} departments={departments} agents={agents} jobs={jobs} setJobs={workspace.setJobs} persist={persistJob} openJob={jobId=>go("jobs",jobId)} openProject={projectId=>go("projects",projectId)} openDepartment={departmentId=>go("departments",departmentId)} back={()=>go("projects")} notice={workspace.setMessage} actions={workspace.projectActions} board={workspace.snapshot.board}/>:(workspace.status==="loading"?<Empty title="Загружаем проект" description="Читаем подключение из постоянного хранилища."/>:<Empty title="Проект не найден" description="Вернитесь к списку проектов."/>)):<ProjectsPage projects={projects} jobs={jobs} open={projectId=>go("projects",projectId)} create={()=>newGroup("projects")}/>;
 else if(section==="projects"||section==="departments")page=id?(group?<GroupDetail key={`${section}-${id}`} kind={section} group={group} update={g=>{if(demoMode){if(section==="projects")setDemoProjectsState(demoProjectsState.map(x=>x.id===g.id?g:x));else setDemoDepartmentsState(demoDepartmentsState.map(x=>x.id===g.id?g:x));return;}if(section==="projects")workspace.setProjects(projects.map(x=>x.id===g.id?g:x));else workspace.updateDepartment(g);}} jobs={jobs} setJobs={demoMode?setDemoJobsState:workspace.setJobs} persist={persistJob} openJob={id=>go("jobs",id)} back={()=>go(section)} notice={workspace.setMessage} agents={agents} departments={departments} openAgent={id=>go("agents",id)} openDepartment={id=>go("departments",id)} people={section==="projects"?departments.map(d=>d.name):agents.map(a=>a.name)} projects={projects} live={!demoMode} commit={demoMode?undefined:section==="departments"?workspace.commitDepartment:workspace.commitProject} projectActions={demoMode?undefined:workspace.projectActions}/>:(!demoMode&&workspace.status==="loading"?<Empty title="Загружаем" description="Читаем запись из постоянного хранилища."/>:<Empty title="Запись не найдена" description="Вернитесь к списку."/>)):<GroupsPage groups={section==="projects"?projects:departments} kind={section} open={id=>go(section,id)} create={()=>newGroup(section)} agents={agents}/>;
 else if(section==="automations")page=demoMode?(id?(automation?<AutomationDetail key={id} item={automation} update={a=>setAutomations(automations.map(x=>x.id===a.id?a:x))} back={()=>go("automations")} notice={workspace.setMessage}/>:<Empty title="Правило не найдено" description="Это пример в памяти."/>):<AutomationsPage items={automations} open={id=>go("automations",id)} create={newAutomation} update={a=>setAutomations(automations.map(x=>x.id===a.id?a:x))}/>):<DispatcherAutomationsPage api={dispatcherApi} projects={projects} projectId={projectId} departments={departments} notice={workspace.setMessage}/>;
 else if(section==="goals")page=demoMode?<Empty title="Цели" description="Цели работают на данных Агентства: выключите пример."/>:<GoalsPage jobs={jobs} openJob={jobId=>go("jobs",jobId)} notice={workspace.setMessage}/>;
 else if(section==="inbox")page=<InboxPage jobs={jobs} agents={agents} readIds={readIds} setReadIds={setReadIds} go={go} dispatcher={demoMode?undefined:dispatcherApi} notice={workspace.setMessage}/>;
 else if(section==="runs")page=<RunsPage demoMode={demoMode} jobs={jobs} runs={demoMode?demoRuns:[]} runId={id} open={runId=>go("runs",runId)} openJob={jobId=>go("jobs",jobId)} back={()=>go("runs")} notice={workspace.setMessage}/>;
 else if(section==="usage")page=<UsagePage api={dispatcherApi} jobs={jobs} projects={projects} departments={departments} rootJobId={id} demoMode={demoMode} openJob={jobId=>go("jobs",jobId)}/>;
 else if(section==="knowledge")page=demoMode?<KnowledgePage items={materials} setItems={setMaterials} scopes={[...projects.map(p=>p.name),...departments.map(d=>d.name)]} live={!demoMode} notice={workspace.setMessage}/>:<KnowledgeLivePage departments={departments.map(item=>({id:item.recordId??item.id,name:item.name}))} projects={projects.filter(item=>!item.archivedAt).map(item=>({id:item.recordId??item.id,name:item.name}))} notice={workspace.setMessage}/>;
 else if(section==="settings")page=<SettingsPage settings={settings} setSettings={setSettings} hosts={hosts} primaryHostId={primaryHostId} notice={workspace.setMessage} reset={()=>setResetOpen(true)} live={!demoMode}/>;
 else page=<Empty title="Страница не найдена" description="Выберите раздел в навигации."/>;
 return <TemplatesProvider api={dispatcherApi} enabled={!demoMode}><div className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground">
 <div className="flex min-h-0 min-w-0 flex-1"><nav aria-label={tr("Разделы агентства")} className="hidden w-40 shrink-0 flex-col border-r border-border lg:flex"><div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-2">{[{name:"Работа",keys:["jobs","inbox","goals"]},{name:"Команда",keys:["projects","departments","agents"]},{name:"Управление",keys:["automations","knowledge","runs","usage","settings"]}].map(group=><div key={group.name} className="pb-4"><p className="px-2 pb-2 pt-2 text-xs font-medium text-muted-foreground">{tr(group.name)}</p>{group.keys.map(key=>{const item=sections.find(s=>s[0]===key)!;return <button key={key} aria-current={section===key?"page":undefined} onClick={()=>go(key)} className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors hover:bg-muted ${section===key?"bg-muted font-medium":"text-muted-foreground"}`}><Icon name={item[2]} className="size-4"/>{tr(item[1])}{!demoMode&&PILOT_SECTIONS.has(key)&&<span title={tr("Раздел ещё не работает на данных: пример интерфейса")} className="ml-auto rounded border border-border px-1 text-[10px] leading-4 text-muted-foreground">{tr("пилот")}</span>}</button>;})}</div>)}</div>
 <details className="relative border-t border-border px-2 py-2"><summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-2 text-xs text-muted-foreground hover:bg-muted [&::-webkit-details-marker]:hidden"><Icon name="MoreHorizontal" className="size-4"/>{tr("Действия")}</summary><div className="absolute bottom-full left-2 right-2 z-20 mb-1 rounded-md border border-border bg-background shadow-md">{actions()}</div></details></nav>
 <div className="min-w-0 flex-1 overflow-y-auto"><div className="flex items-center gap-2 border-b border-border p-3 lg:hidden"><div className="min-w-0 flex-1"><Choice label="Раздел агентства" value={section} onChange={s=>go(s)} options={sections.map(([value,label])=>({value,label}))}/></div><details className="relative shrink-0"><summary className="flex size-9 cursor-pointer list-none items-center justify-center rounded-md hover:bg-muted [&::-webkit-details-marker]:hidden" aria-label={tr("Действия агентства")}><Icon name="MoreHorizontal" className="size-4"/></summary><div className="absolute right-0 z-20 mt-1 w-48 rounded-md border border-border bg-background shadow-md">{actions()}</div></details></div>
 <div className="mx-auto w-full max-w-none space-y-3 p-3 md:p-4">{demoMode&&<div role="status" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">{tr("Демонстрация · пример в памяти, не серверные записи.")}</div>}{statusNote&&<div role="alert" className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">{statusNote}</div>}{noticeText&&<div role="status" className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm"><span>{noticeText}</span><Button size="sm" variant="ghost" aria-label={tr("Закрыть сообщение")} onClick={()=>workspace.setMessage("")}>×</Button></div>}{page}</div></div></div>
 <Dialog open={resetOpen} onOpenChange={setResetOpen}><DialogContent><DialogHeader><DialogTitle>{tr(demoMode?"Сбросить пример?":"Сбросить локальные черновики?")}</DialogTitle><DialogDescription>{tr(demoMode?"Демонстрационные карточки вернутся к исходному примеру. Серверные записи не затрагиваются.":"Серверные задачи не удаляются. Сбрасываются только локальные черновики экрана.")}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={()=>setResetOpen(false)}>{tr("Отмена")}</Button><Button onClick={reset}>{tr("Сбросить")}</Button></DialogFooter></DialogContent></Dialog>
 {!demoMode&&<AgencyCreateDialogs kind={createKind} onClose={()=>setCreateKind(null)} catalog={workspace.catalog} catalogError={workspace.catalogError} loadCatalog={workspace.refreshCatalog} agents={agents} bindings={projects} createBinding={workspace.addProject} createAgent={workspace.addAgent} createDepartment={workspace.addDepartment} departments={departments} routingHostId={primaryHostId||projects.find(item=>!item.archivedAt&&item.hostId)?.hostId||hosts[0]?.id}/>}
 </div></TemplatesProvider>;
}
