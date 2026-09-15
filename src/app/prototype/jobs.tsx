import { type TaskScope, inTaskScope, scopeTitle } from "./task-scope";
import { SearchInput } from "./shared";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../../../components/ui/dialog";
import { type Job, type State, states, stateNames } from "./data";
import { departmentsForBinding, JOB_CREATE_HINT, JOB_CREATE_NO_DEPARTMENTS, sanitizeDepartmentId, type ProjectDepartmentLink } from "../data/job-placement";
import { jobKanbanMoveRefusal, jobLifecycleLocked } from "../data/job-lifecycle";
import { nextJobKey } from "../data/view-models";
import { jobAttention } from "../data/job-attention";
import { Button, Icon, Input, TextField, Choice, PageHead, TabBar, Panel, Status, Empty, Rows } from "./shared";

/**
 * Attention marker: how long a row has stood still, emphasised when the person
 * is the one holding it up. The status itself is already in the section header,
 * so it is never repeated here.
 */
function AttentionMark({ job, now }: { job: Job; now: number }) {
 const attention=jobAttention(job,now);
 if(attention.tone==="none"||!attention.age)return null;
 const tone=attention.tone==="overdue"?"text-amber-600 dark:text-amber-500 font-medium":attention.tone==="waiting"?"text-foreground":"text-muted-foreground";
 return <span title={attention.hint} aria-label={attention.hint} className={`shrink-0 whitespace-nowrap text-xs tabular-nums ${tone}`}>{attention.age}</span>;
}

export function JobsPage({ jobs, setJobs, open, project, department, scope, persist, placements, requirePlacement=false, notice, initialView="Список" }: { jobs: Job[]; setJobs: (j: Job[]) => void; open: (id: string) => void; project?: string; department?: string; scope?:TaskScope; persist?:(job:Job)=>void|Promise<boolean>; placements?:{projects:{id:string;name:string}[];departments:{id:string;name:string}[];projectDepartments?:ProjectDepartmentLink[]}; requirePlacement?:boolean; notice?:(text:string)=>void; initialView?: "Список" | "Канбан" }) {
 const [view,setView]=useState<string>(initialView);const [q,setQ]=useState("");const [filter,setFilter]=useState("all");const [pr,setPr]=useState("all");const [form,setForm]=useState(false);const [title,setTitle]=useState("");const [creating,setCreating]=useState(false);
 const [bindingId,setBindingId]=useState("");const [departmentId,setDepartmentId]=useState("");
 const [priority,setPriority]=useState("all");const [sort,setSort]=useState("id");
 const projectFilters=placements?.projects?.length
  ? placements.projects.map((item) => ({ value: item.id, label: item.name }))
  : [...new Map(jobs.filter((job) => job.bindingId || job.project).map((job) => [job.bindingId || job.project, { value: job.bindingId || job.project, label: job.project }])).values()];
 const filtered=jobs.filter(j=>(!scope||inTaskScope(j,scope))&&(!project||j.project===project||j.bindingId===project)&&(!department||j.department===department||j.departmentId===department)&&(pr==="all"||j.bindingId===pr||j.project===pr)&&(priority==="all"||j.priority===priority)&&(filter==="all"||j.state===filter)&&(j.title+" "+j.id).toLowerCase().includes(q.toLowerCase())).sort((a,b)=>sort==="due"?a.due.localeCompare(b.due):a.id.localeCompare(b.id));
 const now=Date.now();
 const move=(id:string,state:State)=>{const current=jobs.find(j=>j.id===id);if(!current||current.state===state)return;const blocked=jobKanbanMoveRefusal(current,state);if(blocked){notice?.(blocked);return;}const next={...current,state};if(persist)void persist(next);else setJobs(jobs.map(j=>j.id===id?next:j));};
 const presetBinding=placements?.projects.find(item=>item.id===project||item.name===project)?.id||(scope?.kind==="project"?placements?.projects.find(item=>item.id===scope.value||item.name===scope.value)?.id:undefined)||"";
 const selectedBinding=bindingId||presetBinding;
 const linkedDepartments=placements?departmentsForBinding(placements.departments,placements.projectDepartments||[],selectedBinding):[];
 const presetDepartment=sanitizeDepartmentId(placements?.departments.find(item=>item.id===department||item.name===department)?.id||(scope?.kind==="department"?placements?.departments.find(item=>item.id===scope.value||item.name===scope.value)?.id:undefined)||"",linkedDepartments);
 const selectedDepartment=sanitizeDepartmentId(departmentId||presetDepartment,linkedDepartments);
 const canCreate=Boolean(title.trim())&&!creating&&(!requirePlacement||Boolean(selectedBinding&&selectedDepartment));
 const changeBinding=(next:string)=>{
  setBindingId(next);
  const allowed=placements?departmentsForBinding(placements.departments,placements.projectDepartments||[],next):[];
  setDepartmentId((current)=>sanitizeDepartmentId(current,allowed));
 };
 const create=async()=>{
  const nextBinding=selectedBinding;
  const nextDepartment=selectedDepartment;
  if(!canCreate)return;
  const created:Job={id:nextJobKey(jobs.map(j=>j.id)),title:title.trim(),state:"backlog",project:placements?.projects.find(item=>item.id===nextBinding)?.name||project||"",department:placements?.departments.find(item=>item.id===nextDepartment)?.name||department||"",agent:(scope?.kind==="agent"?scope.value:undefined)||"",priority:"Обычный",due:"",description:"Добавьте вводные и критерии приёмки.",comments:[],bindingId:nextBinding||undefined,departmentId:nextDepartment||undefined};
  if(!persist){setJobs([...jobs,created]);setForm(false);setTitle("");open(created.id);return;}
  setCreating(true);
  const ok=await Promise.resolve(persist(created));
  setCreating(false);
  if(ok===false)return;
  setForm(false);setTitle("");
 };
 return <div className="space-y-3"><PageHead level={project||department?2:1} title={scope?scopeTitle(scope):project||department?"Очередь задач":"Задачи"}><Button size="sm" onClick={()=>setForm(true)}><Icon name="Plus" className="mr-1 size-3.5"/>Новая задача</Button></PageHead>
 <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3 [&_button[role=combobox]]:h-7 [&_button[role=combobox]]:border-dashed [&_button[role=combobox]]:px-2 [&_button[role=combobox]]:text-xs"><div className="w-32"><Choice label="Фильтр статуса" value={filter} onChange={setFilter} options={[{value:"all",label:"Статус"},...states.map(s=>({value:s,label:stateNames[s]}))]}/></div><div className="w-32"><Choice label="Приоритет" value={priority} onChange={setPriority} options={[{value:"all",label:"Приоритет"},"Низкий","Обычный","Высокий","Срочный"]}/></div>{!project&&!scope&&<div className="w-32"><Choice label="Фильтр проекта" value={pr} onChange={setPr} options={[{value:"all",label:"Проект"},...projectFilters]}/></div>}<SearchInput className="max-w-xs" aria-label="Поиск задач" placeholder="Поиск задач…" value={q} onChange={e=>setQ(e.target.value)}/><div className="ml-auto flex items-center gap-2"><div className="w-28"><Choice label="Сортировка" value={sort} onChange={setSort} options={[{value:"id",label:"По номеру"},{value:"due",label:"По сроку"}]}/></div><span className="whitespace-nowrap text-xs text-muted-foreground">{filtered.length} задач</span><TabBar value={view} onChange={(v)=>{ if(v==="Список"||v==="Канбан") setView(v); }} tabs={["Список","Канбан"]}/></div></div>
 {filtered.length===0?<Empty title="Задачи не найдены" description="Измените фильтры или создайте новое поручение."/>:view==="Канбан"?<div className="flex gap-3 overflow-x-auto pb-3" aria-label="Канбан задач" data-testid="jobs-kanban">{states.filter(s=>filter==="all"||filter===s).map(s=><section key={s} aria-label={stateNames[s]} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();move(e.dataTransfer.getData("text/plain"),s);}} className="w-60 shrink-0 bg-muted/20 p-2"><div className="mb-3 flex items-center justify-between px-1 py-1"><Status state={s}/><span className="text-xs text-muted-foreground">{filtered.filter(j=>j.state===s).length}</span></div><div className="space-y-2">{filtered.filter(j=>j.state===s).map(j=><button key={j.id} draggable={!jobLifecycleLocked(j)} onDragStart={e=>e.dataTransfer.setData("text/plain",j.id)} onClick={()=>open(j.id)} className="w-full rounded-md border border-border bg-card p-2.5 text-left hover:border-ring focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"><span className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{j.id}</span><AttentionMark job={j} now={now}/></span><p className="my-1.5 text-sm leading-5">{j.title}</p><p className="text-xs text-muted-foreground">{j.project}</p><div className="mt-2 flex justify-between text-xs"><span>{j.agent}</span><span>{j.due.slice(5)}</span></div></button>)}</div></section>)}</div>:<div aria-label="Список задач по статусам" className="-mx-3 md:-mx-4">{(["blocked","waiting_input","review","running","queued","backlog","done","canceled"] as State[]).filter(state=>filtered.some(j=>j.state===state)).map(state=><section key={state} aria-label={stateNames[state]}><div className="flex h-9 items-center gap-2 border-b border-border bg-muted/30 px-4 font-medium"><Status state={state}/><span className="text-xs text-muted-foreground">{filtered.filter(j=>j.state===state).length}</span></div>{filtered.filter(j=>j.state===state).map(j=><button key={j.id} onClick={()=>open(j.id)} className="flex min-h-9 w-full items-center gap-3 border-b border-border px-4 py-2 text-left text-sm hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"><span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">{j.id}</span><span className="min-w-0 flex-1 truncate">{j.title}</span><span className="hidden text-xs text-muted-foreground xl:block">{j.project}</span><span className="hidden w-14 truncate text-right text-xs text-muted-foreground sm:block">{j.agent}</span><AttentionMark job={j} now={now}/><span title={j.department} className="size-2 shrink-0 rounded-full bg-blue-500"/></button>)}</section>)}</div>}

 <Dialog open={form} onOpenChange={open=>{if(!creating){setForm(open);if(open){setBindingId(presetBinding);setDepartmentId(presetDepartment);}}}}>
  <DialogContent>
   <DialogHeader>
    <DialogTitle>Новая задача</DialogTitle>
    <DialogDescription>{JOB_CREATE_HINT}</DialogDescription>
   </DialogHeader>
   <TextField label="Название задачи" value={title} onChange={setTitle}/>
   {placements&&<>
    <Choice label="Проект" value={selectedBinding} onChange={changeBinding} options={placements.projects.map(item=>({value:item.id,label:item.name}))}/>
    {linkedDepartments.length
     ?<Choice label="Отдел" value={selectedDepartment} onChange={setDepartmentId} options={linkedDepartments.map(item=>({value:item.id,label:item.name}))}/>
     :<p className="text-xs text-muted-foreground">{selectedBinding?JOB_CREATE_NO_DEPARTMENTS:"Сначала выберите проект."}</p>}
   </>}
   <p className="text-xs text-muted-foreground" aria-live="polite">{creating?"Сохраняем задачу…":"Поле останется, пока сервер не подтвердит запись."}</p>
   <DialogFooter>
    <Button variant="outline" disabled={creating} onClick={()=>setForm(false)}>Отмена</Button>
    <Button disabled={!canCreate} onClick={()=>void create()}>{creating?"Сохраняем…":"Создать"}</Button>
   </DialogFooter>
  </DialogContent>
 </Dialog>
 </div>;
}
export { JobDetail } from "./job-detail";
