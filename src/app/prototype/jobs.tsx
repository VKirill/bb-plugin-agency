import { useTemplates } from "./use-templates";
import { DUE_TONE_CLASS, dueStatus } from "../data/job-due";
import { type TaskScope, inTaskScope, scopeTitle } from "./task-scope";
import { SearchInput } from "./shared";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../../../components/ui/dialog";
import { type Agent, type Group, type Job, type State, states, stateNames } from "./data";
import { departmentsForBinding, JOB_CREATE_HINT, JOB_CREATE_NO_DEPARTMENTS, sanitizeDepartmentId, type NamedPlacement, type ProjectDepartmentLink } from "../data/job-placement";
import { jobKanbanMoveRefusal, jobLifecycleLocked } from "../data/job-lifecycle";
import { nextJobKey } from "../data/view-models";
import { jobAttention } from "../data/job-attention";
import { compareJobKeys, DEFAULT_BOARD_POLICY, displayJobTitle, isMainJob, orderByFamily, partitionBoard, subtaskProgress, type BoardPolicy, type SubtaskProgress } from "../data/job-board";
import { Button, Icon, Input, TextField, Choice, Field, PageHead, TabBar, Panel, Status, Empty, Rows } from "./shared";
import { AssigneeField, JobBriefFields, JobContractFields, assigneeOptions, autoAssignmentOf, composeJobDescription, withAutoAssignment } from "./job-fields";
import { tr } from "../i18n";
import { ArchivedJobsList, SavedViewsControl, ServerSearchHits, type BoardArchive, type BoardFilters } from "./jobs-archive";
import "./jobs-list.css";

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

/** Due date that needs attention: overdue or inside the department's reminder window. */
function DueMark({ job, now, always = false }: { job: Job; now: number; always?: boolean }) {
 const due=dueStatus(job,now);
 if(!due||(due.tone==="set"&&!always))return null;
 return <span title={due.hint} aria-label={due.hint} className={`shrink-0 whitespace-nowrap text-xs tabular-nums ${DUE_TONE_CLASS[due.tone]}`}>{due.label}</span>;
}

/**
 * Kanban columns. Eight states do not fit even 1440 px: the working board shows
 * five, grouping the two «needs an answer» states; backlog and canceled are a
 * separate view. A drop sets only the column's own state, the rest is set by work.
 */
const KANBAN_COLUMNS: { key: string; title: string; states: State[]; drop: State }[] = [
 { key: "queued", title: "К запуску", states: ["queued"], drop: "queued" },
 { key: "running", title: "В работе", states: ["running"], drop: "running" },
 { key: "attention", title: "Нужен ответ", states: ["blocked", "waiting_input"], drop: "blocked" },
 { key: "review", title: "На проверке", states: ["review"], drop: "review" },
 { key: "done", title: "Готово", states: ["done"], drop: "done" },
];
const KANBAN_ARCHIVE: typeof KANBAN_COLUMNS = [
 { key: "backlog", title: "Бэклог", states: ["backlog"], drop: "backlog" },
 { key: "canceled", title: "Отменённые", states: ["canceled"], drop: "canceled" },
];

/** Subtask arrow in front of the key: the hierarchy reads down the left edge. */
function SubtaskMark({ job }: { job: Job }) {
 return isMainJob(job)?null:<Icon name="CornerDownRight" aria-hidden className="size-3.5 shrink-0 text-muted-foreground"/>;
}

/** main — has subtasks; single — standalone job; subtask — has a parent on the board. */
function jobKind(job: Job, progress?: SubtaskProgress): "main"|"single"|"subtask" {
 return !isMainJob(job)?"subtask":progress?"main":"single";
}

/**
 * Title of a row or card. A main job — one that owns subtasks — reads first:
 * bold, with how many of its subtasks are closed. A standalone job keeps the
 * regular weight so bold stays a signal. A subtask names its parent unless the
 * parent row is right above it.
 */
function JobTitle({ job, progress, parentShown }: { job: Job; progress?: SubtaskProgress; parentShown: boolean }) {
 const main=isMainJob(job);
 return <span className="flex min-w-0 flex-1 items-center gap-1.5">
  <span className={`min-w-0 truncate ${main&&progress?"font-semibold":""}`}>{displayJobTitle(job)}</span>
  {main&&progress&&<span title={tr("Подзадачи: закрыто {closed} из {total}",{closed:progress.closed,total:progress.total})} className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">{progress.closed}/{progress.total}</span>}
  {!main&&!parentShown&&<span title={tr("Главная задача")} className="shrink-0 font-mono text-[11px] text-muted-foreground">{job.parentId}</span>}
 </span>;
}

export function JobsPage({ jobs, setJobs, open, project, department, scope, persist, placements, requirePlacement=false, notice, initialView="Список", board=DEFAULT_BOARD_POLICY, archive }: { jobs: Job[]; setJobs: (j: Job[]) => void; open: (id: string) => void; project?: string; department?: string; scope?:TaskScope; persist?:(job:Job)=>void|Promise<boolean>; placements?:{projects:{id:string;name:string}[];departments:(NamedPlacement&Partial<Pick<Group,"lead"|"members"|"memberRoles">>)[];projectDepartments?:ProjectDepartmentLink[];agents?:Agent[]}; requirePlacement?:boolean; notice?:(text:string)=>void; initialView?: "Список" | "Канбан"; board?: BoardPolicy; archive?: BoardArchive }) {
 const [view,setView]=useState<string>(initialView);const [q,setQ]=useState("");const [filter,setFilter]=useState("all");const [pr,setPr]=useState("all");const [form,setForm]=useState(false);const [title,setTitle]=useState("");const [creating,setCreating]=useState(false);
 const [bindingId,setBindingId]=useState("");const [departmentId,setDepartmentId]=useState("");
 const [brief,setBrief]=useState("");const [acceptance,setAcceptance]=useState("");const [assigneeId,setAssigneeId]=useState("");const [newPriority,setNewPriority]=useState("Обычный");const [due,setDue]=useState("");const [contract,setContract]=useState<Job["contract"]>();const templates=useTemplates();
 const [priority,setPriority]=useState("all");const [sort,setSort]=useState("id");const [showHidden,setShowHidden]=useState(false);const [kanbanArchive,setKanbanArchive]=useState(false);const [archiveOpen,setArchiveOpen]=useState(false);
 const boardFilters:BoardFilters={q,filter,priority,pr,sort,view};
 const applyFilters=(next:BoardFilters)=>{setQ(next.q);setFilter(next.filter);setPriority(next.priority);setPr(next.pr);setSort(next.sort);setView(next.view==="Канбан"?"Канбан":"Список");setArchiveOpen(false);};
 const projectFilters=placements?.projects?.length
  ? placements.projects.map((item) => ({ value: item.id, label: item.name }))
  : [...new Map(jobs.filter((job) => job.bindingId || job.project).map((job) => [job.bindingId || job.project, { value: job.bindingId || job.project, label: job.project }])).values()];
 const now=Date.now();
 const board$=partitionBoard(jobs.filter(j=>(!scope||inTaskScope(j,scope))&&(!project||j.project===project||j.bindingId===project)&&(!department||j.department===department||j.departmentId===department)),board,now);
 const matched=(showHidden?[...board$.visible,...board$.hidden]:board$.visible).filter(j=>(pr==="all"||j.bindingId===pr||j.project===pr)&&(priority==="all"||j.priority===priority)&&(filter==="all"||j.state===filter)&&(j.title+" "+j.id).toLowerCase().includes(q.toLowerCase()));
 const filtered=sort==="due"?[...matched].sort((a,b)=>(a.due||"9999").localeCompare(b.due||"9999")||compareJobKeys(a.id,b.id)):orderByFamily(matched,jobs);
 const progress=subtaskProgress(jobs);
 const hiddenToggle=board$.hidden.length>0&&<div className="flex min-h-9 items-center justify-between gap-2 border-b border-border px-4 py-1.5 text-xs text-muted-foreground"><span>{showHidden?tr("Показаны скрытые завершённые: {count}",{count:board$.hidden.length}):tr("Скрыто завершённых: {count}. Подзадачи уходят через {subtaskHours} ч, остальные — через {mainHours} ч.",{count:board$.hidden.length,subtaskHours:board.hideClosedSubtasksAfterHours||"—",mainHours:board.hideClosedMainTasksAfterHours||"—"})}</span><Button size="sm" variant="ghost" className="h-7 text-xs" aria-pressed={showHidden} onClick={()=>setShowHidden(!showHidden)}>{showHidden?tr("Убрать скрытые"):tr("Показать")}</Button></div>;
 const move=(id:string,state:State)=>{const current=jobs.find(j=>j.id===id);if(!current||current.state===state)return;const blocked=jobKanbanMoveRefusal(current,state);if(blocked){notice?.(blocked);return;}const next={...current,state};if(persist)void persist(next);else setJobs(jobs.map(j=>j.id===id?next:j));};
 const presetBinding=placements?.projects.find(item=>item.id===project||item.name===project)?.id||(scope?.kind==="project"?placements?.projects.find(item=>item.id===scope.value||item.name===scope.value)?.id:undefined)||"";
 const selectedBinding=bindingId||presetBinding;
 const linkedDepartments=placements?departmentsForBinding(placements.departments,placements.projectDepartments||[],selectedBinding):[];
 const presetDepartment=sanitizeDepartmentId(placements?.departments.find(item=>item.id===department||item.name===department)?.id||(scope?.kind==="department"?placements?.departments.find(item=>item.id===scope.value||item.name===scope.value)?.id:undefined)||"",linkedDepartments);
 const selectedDepartment=sanitizeDepartmentId(departmentId||presetDepartment,linkedDepartments);
 const selectedTeam=placements?.departments.find(item=>item.id===selectedDepartment);
 const assigneeChoices=selectedTeam?.lead?withAutoAssignment(assigneeOptions({id:selectedTeam.id,lead:selectedTeam.lead,members:selectedTeam.members??[],memberRoles:selectedTeam.memberRoles},placements?.agents??[]),{id:selectedTeam.id,lead:selectedTeam.lead,members:selectedTeam.members??[],memberRoles:selectedTeam.memberRoles}):[];
 // The department lead is the default: the lead assesses the job and hands out subtasks.
 const selectedAssignee=assigneeChoices.some(item=>item.value===assigneeId)?assigneeId:(assigneeChoices[0]?.value??"");
 const needsBriefFields=Boolean(persist);
 const canCreate=Boolean(title.trim())&&!creating&&(!requirePlacement||Boolean(selectedBinding&&selectedDepartment))&&(!needsBriefFields||Boolean(brief.trim()&&acceptance.trim()&&(selectedAssignee||!placements?.agents)));
 const changeBinding=(next:string)=>{
  setBindingId(next);
  const allowed=placements?departmentsForBinding(placements.departments,placements.projectDepartments||[],next):[];
  setDepartmentId((current)=>sanitizeDepartmentId(current,allowed));
 };
 const create=async()=>{
  const nextBinding=selectedBinding;
  const nextDepartment=selectedDepartment;
  if(!canCreate)return;
  const auto=autoAssignmentOf(selectedAssignee);
  const assignee=auto?undefined:placements?.agents?.find(item=>item.id===selectedAssignee);
  const created:Job={id:nextJobKey(jobs.map(j=>j.id)),title:title.trim(),state:"backlog",project:placements?.projects.find(item=>item.id===nextBinding)?.name||project||"",department:placements?.departments.find(item=>item.id===nextDepartment)?.name||department||"",agent:auto?"":assignee?.name||(scope?.kind==="agent"?scope.value:undefined)||"",...(auto?{assignment:auto}:assignee?{assignedAgentId:assignee.id}:{}),priority:newPriority,due,description:needsBriefFields?composeJobDescription(brief.trim(),acceptance.trim()):tr("Добавьте вводные и критерии приёмки."),comments:[],bindingId:nextBinding||undefined,departmentId:nextDepartment||undefined,...(contract?{contract}:{})};
  if(!persist){setJobs([...jobs,created]);setForm(false);setTitle("");open(created.id);return;}
  setCreating(true);
  const ok=await Promise.resolve(persist(created));
  setCreating(false);
  if(ok===false)return;
  setForm(false);setTitle("");setBrief("");setAcceptance("");setAssigneeId("");setNewPriority("Обычный");setDue("");setContract(undefined);
 };
 return <div className="space-y-3"><PageHead level={project||department?2:1} title={scope?scopeTitle(scope):project||department?"Очередь задач":"Задачи"}><Button size="sm" onClick={()=>setForm(true)}><Icon name="Plus" className="mr-1 size-3.5"/>{tr("Новая задача")}</Button></PageHead>
 <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3 [&_button[role=combobox]]:h-7 [&_button[role=combobox]]:border-dashed [&_button[role=combobox]]:px-2 [&_button[role=combobox]]:text-xs"><div className="w-32"><Choice label="Фильтр статуса" value={filter} onChange={setFilter} options={[{value:"all",label:"Статус"},...states.map(s=>({value:s,label:stateNames[s]}))]}/></div><div className="w-32"><Choice label="Приоритет" value={priority} onChange={setPriority} options={[{value:"all",label:"Приоритет"},"Низкий","Обычный","Высокий","Срочный"]}/></div>{!project&&!scope&&<div className="w-32"><Choice label="Фильтр проекта" value={pr} onChange={setPr} options={[{value:"all",label:"Проект"},...projectFilters]}/></div>}<SearchInput className="max-w-xs" aria-label={tr("Поиск задач")} placeholder={tr("Поиск задач…")} value={q} onChange={e=>setQ(e.target.value)}/>{archive&&<SavedViewsControl api={archive.api} current={boardFilters} apply={applyFilters} notice={notice}/>}<div className="ml-auto flex items-center gap-2">{archive&&<Button size="sm" variant={archiveOpen?"secondary":"ghost"} className="h-7 px-2 text-xs" aria-pressed={archiveOpen} onClick={()=>setArchiveOpen(!archiveOpen)}>{tr("Архив · {count}",{count:archive.count})}</Button>}<div className="w-28"><Choice label="Сортировка" value={sort} onChange={setSort} options={[{value:"id",label:"По номеру"},{value:"due",label:"По сроку"}]}/></div><span className="whitespace-nowrap text-xs text-muted-foreground">{tr("{count} задач",{count:filtered.length})}</span><TabBar value={view} onChange={(v)=>{ if(v==="Список"||v==="Канбан") setView(v); }} tabs={["Список","Канбан"]}/></div></div>
 {archive&&archiveOpen?<ArchivedJobsList api={archive.api} open={open} notice={notice} departmentName={id=>placements?.departments.find(item=>item.id===id)?.name??id}/>:filtered.length===0?<><Empty title="Задачи не найдены" description={board$.hidden.length&&!showHidden?"Активных задач нет. Завершённые скрыты ниже.":"Измените фильтры или создайте новое поручение."}/>{hiddenToggle}</>:view==="Канбан"?<><div className="flex items-center gap-2 pb-2 text-xs"><Button size="sm" variant={kanbanArchive?"ghost":"secondary"} className="h-7 px-2 text-xs" aria-pressed={!kanbanArchive} onClick={()=>setKanbanArchive(false)}>{tr("Рабочие")}</Button><Button size="sm" variant={kanbanArchive?"secondary":"ghost"} className="h-7 px-2 text-xs" aria-pressed={kanbanArchive} onClick={()=>setKanbanArchive(true)}>{tr("Бэклог и отменённые · {count}",{count:filtered.filter(j=>j.state==="backlog"||j.state==="canceled").length})}</Button></div><div className="flex gap-3 overflow-x-auto pb-3" aria-label={tr("Канбан задач")} data-testid="jobs-kanban">{(kanbanArchive?KANBAN_ARCHIVE:KANBAN_COLUMNS).filter(c=>filter==="all"||c.states.includes(filter as State)).map(c=>{const column=filtered.filter(j=>c.states.includes(j.state));const keys=new Set(column.map(j=>j.id));return <section key={c.key} aria-label={tr(c.title)} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();move(e.dataTransfer.getData("text/plain"),c.drop);}} className="w-60 shrink-0 bg-muted/20 p-2"><div className="mb-3 flex items-center justify-between px-1 py-1"><span className="inline-flex items-center gap-1.5 text-xs"><Status state={c.states[0]!} iconOnly/>{tr(c.title)}</span><span className="text-xs text-muted-foreground">{column.length}</span></div><div className="space-y-2">{column.map(j=><button key={j.id} draggable={!jobLifecycleLocked(j)} onDragStart={e=>e.dataTransfer.setData("text/plain",j.id)} onClick={()=>open(j.id)} className="w-full rounded-md border border-border bg-card p-2.5 text-left hover:border-ring focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"><span className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span className="flex items-center gap-0.5 font-mono"><SubtaskMark job={j}/>{j.id}</span><AttentionMark job={j} now={now}/></span><p className={`my-1.5 line-clamp-3 text-sm leading-5 ${progress.get(j.id)?"font-semibold":""}`}>{displayJobTitle(j)}</p><div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground"><span className="truncate">{j.agent}</span><span className="flex shrink-0 items-center gap-2 tabular-nums">{progress.get(j.id)&&<span title={tr("Подзадачи: закрыто {closed} из {total}",{closed:progress.get(j.id)?.closed,total:progress.get(j.id)?.total})}>{progress.get(j.id)?.closed}/{progress.get(j.id)?.total}</span>}{j.parentId&&!keys.has(j.parentId)&&<span title={tr("Главная задача")} className="font-mono">{j.parentId}</span>}<DueMark job={j} now={now} always/></span></div></button>)}</div></section>;})}</div>{hiddenToggle}</>:<div aria-label={tr("Список задач по статусам")} className="agency-job-list -mx-3 md:-mx-4">{(["blocked","waiting_input","review","running","queued","backlog","done","canceled"] as State[]).filter(state=>filtered.some(j=>j.state===state)).map(state=>{const rows=filtered.filter(j=>j.state===state);const keys=new Set(rows.map(j=>j.id));return <section key={state} aria-label={tr(stateNames[state])}><div className="flex h-9 items-center gap-2 border-b border-border bg-muted/30 px-4 font-medium"><Status state={state}/><span className="text-xs text-muted-foreground">{rows.length}</span></div>{rows.map(j=>{const parentShown=Boolean(j.parentId&&keys.has(j.parentId));return <button key={j.id} data-job-kind={jobKind(j,progress.get(j.id))} onClick={()=>open(j.id)} className="agency-job-row min-h-9 w-full border-b border-border px-4 py-2 text-left text-sm hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"><span className="agency-job-lead flex min-w-0 items-center gap-2"><span className={`flex shrink-0 items-center gap-0.5 ${isMainJob(j)?"":"pl-1"}`}><SubtaskMark job={j}/><span className="w-[3.75rem] truncate font-mono text-xs text-muted-foreground">{j.id}</span></span><JobTitle job={j} progress={progress.get(j.id)} parentShown={parentShown}/><DueMark job={j} now={now}/>{j.escalatedToId&&<span title={tr("Эскалировано в вышестоящий отдел")} className="shrink-0 rounded border border-amber-500/40 px-1 text-[10px] leading-4 text-amber-700 dark:text-amber-400">{tr("эскалация")}</span>}</span><span className="agency-job-department truncate text-xs text-muted-foreground">{j.department}</span><span className="agency-job-agent truncate text-xs text-muted-foreground">{j.agent}</span><span className="agency-job-age"><AttentionMark job={j} now={now}/></span></button>;})}</section>;})}{hiddenToggle}</div>}
 {archive&&!archiveOpen&&<ServerSearchHits api={archive.api} query={q} shown={new Set(filtered.map(j=>j.id))} open={open} notice={notice}/>}

 <Dialog open={form} onOpenChange={open=>{if(!creating){setForm(open);if(open){setBindingId(presetBinding);setDepartmentId(presetDepartment);}}}}>
  <DialogContent>
   <DialogHeader>
    <DialogTitle>{tr("Новая задача")}</DialogTitle>
    <DialogDescription>{tr(JOB_CREATE_HINT)}</DialogDescription>
   </DialogHeader>
   <div className="max-h-[65dvh] space-y-3 overflow-y-auto pr-1">
   <TextField label="Название задачи" value={title} onChange={setTitle} maxLength={200} required/>
   {placements&&<div className="grid gap-3 sm:grid-cols-2">
    <Field label="Проект" required info={<><p>{tr("Папка проекта на машине: там запустятся сотрудники и появятся файлы результата.")}</p><p>{tr("Проект подключают в разделе «Проекты».")}</p></>}><Choice label="Проект" value={selectedBinding} onChange={changeBinding} options={placements.projects.map(item=>({value:item.id,label:item.name}))}/></Field>
    <Field label="Отдел" required info={<><p>{tr("Отдел выбирают по сути результата: код, исследование, текст. Что отдел принимает — раздел «Принимаем» в его регламенте.")}</p><p>{tr("Не тот отдел вернёт задачу с объяснением.")}</p></>}>{linkedDepartments.length
     ?<Choice label="Отдел" value={selectedDepartment} onChange={setDepartmentId} options={linkedDepartments.map(item=>({value:item.id,label:item.name}))}/>
     :<p className="text-xs text-muted-foreground">{selectedBinding?tr(JOB_CREATE_NO_DEPARTMENTS):tr("Сначала выберите проект.")}</p>}</Field>
   </div>}
   {needsBriefFields&&placements?.agents&&selectedDepartment&&<AssigneeField value={selectedAssignee} onChange={setAssigneeId} options={assigneeChoices}/>}
   {needsBriefFields&&<JobBriefFields brief={brief} acceptance={acceptance} onBrief={setBrief} onAcceptance={setAcceptance} templates={templates}/>}
   {needsBriefFields&&form&&<JobContractFields value={contract} onChange={setContract}/>}
   {needsBriefFields&&<div className="grid gap-3 sm:grid-cols-2">
    <Field label="Приоритет"><Choice label="Приоритет" value={newPriority} onChange={setNewPriority} options={["Низкий","Обычный","Высокий","Срочный"]}/></Field>
    <TextField label="Срок" type="date" value={due} onChange={setDue}/>
   </div>}
   </div>
   {creating&&<p className="text-xs text-muted-foreground" aria-live="polite">{tr("Сохраняем задачу…")}</p>}
   <DialogFooter>
    <Button variant="outline" disabled={creating} onClick={()=>setForm(false)}>{tr("Отмена")}</Button>
    <Button disabled={!canCreate} onClick={()=>void create()}>{creating?tr("Сохраняем…"):tr("Создать")}</Button>
   </DialogFooter>
  </DialogContent>
 </Dialog>
 </div>;
}
export { JobDetail } from "./job-detail";
