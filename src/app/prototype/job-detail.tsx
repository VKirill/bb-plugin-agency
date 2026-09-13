import { documentTab, publishDocument, useDocumentVisible } from "./document-panel";
import { Handoff } from "./handoff";
import "./job-detail.css";
import { useState, useEffect } from "react";
import { Markdown, experimental_useAppPanel, experimental_ProviderIcon as ProviderIcon } from "@get-bb/plugin-sdk/app";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../../../components/ui/dialog";
import { type Agent, type Job, type State, type TaskActivity, type TaskFile, states, stateNames } from "./data";
import { exampleFiles, FileChip, FilePicker } from "./task-files";
import { Button, AgentMark, Icon, TextField, Choice, Status, Field } from "./shared";

import { TaskQuestionBlock } from "./task-question";
import { designQuestion, type Answers } from "./question-contract";

type Props = {agents:Agent[];job:Job;jobs:Job[];update:(j:Job)=>void;addJob:(j:Job)=>void;openJob:(id:string)=>void;back:()=>void;notice:(s:string)=>void;openRun:()=>void};
const nextState: Partial<Record<State, string>> = {
 backlog:"Поручение ещё не отправлено исполнителю.",queued:"Поручение в очереди. Ожидаем исполнителя.",
 running:"Исполнитель готовит результат.",review:"Результат ожидает проверки.",blocked:"Нужно уточнить вводные перед продолжением.",done:"Результат принят.",canceled:"Работа отменена.",
};
export function JobDetail({agents,job,jobs,update,addJob,openJob,back,notice,openRun}:Props) {
 const appPanel=experimental_useAppPanel();const documentVisible=useDocumentVisible(job.id);
 const [detailsOpen,setDetailsOpen]=useState(false);
 const [comment,setComment]=useState("");const [filter,setFilter]=useState("all");
 const [editing,setEditing]=useState(false);const [title,setTitle]=useState(job.title);const [description,setDescription]=useState(job.description);
 const [childForm,setChildForm]=useState(false);const [childTitle,setChildTitle]=useState("");
 const [preview,setPreview]=useState<TaskFile|null>(null);const [pendingFiles,setPendingFiles]=useState<TaskFile[]>([]);const [reviewing,setReviewing]=useState(false);const [reason,setReason]=useState("");
 const children=jobs.filter(j=>j.parentId===job.id);const parent=jobs.find(j=>j.id===job.parentId);
 const hasExample=job.id==="AG-102";
 const change=(patch:Partial<Job>,text:string)=>update({...job,...patch,activity:[...(job.activity||[]),{id:crypto.randomUUID(),kind:"event",text,at:new Date().toISOString()}]});
 const setStatus=(state:State)=>{if(state!==job.state)change({state},`Вы изменили статус: ${stateNames[job.state]} → ${stateNames[state]}`);};
 const files=[...new Map([...(hasExample?exampleFiles:[]),...(job.files||[])].map(f=>[f.id,f])).values()];
 const currentFile=preview?(files.find(f=>f.id===preview.id)||preview):null;
 const draft=currentFile?(job.fileDrafts?.[currentFile.id]??currentFile.content):"";
 const [pendingPreview,setPendingPreview]=useState<{file:TaskFile|null}|null>(null);
 const selectFile=(file:TaskFile|null)=>{if(currentFile&&draft!==currentFile.content&&file?.id!==currentFile.id){setPendingPreview({file});return;}setPreview(file);if(file&&!appPanel.openFixedTab({surface:{kind:"current"},tab:documentTab,target:{jobId:job.id,fileId:file.id}}))notice("Не удалось открыть панель документа BB.");};
 const saveFile=()=>{
  if(!currentFile||draft===currentFile.content)return;
  const saved={...currentFile,content:draft,size:new TextEncoder().encode(draft).length,version:(currentFile.version||1)+1,previousVersions:[...(currentFile.previousVersions||[]),{version:currentFile.version||1,content:currentFile.content,at:new Date().toISOString()}]};
  const fileDrafts={...job.fileDrafts};delete fileDrafts[currentFile.id];
  if(pendingFiles.some(f=>f.id===saved.id)){setPendingFiles(pendingFiles.map(f=>f.id===saved.id?saved:f));update({...job,fileDrafts});}
  else change({files:[...(job.files||[]).filter(f=>f.id!==saved.id),saved],fileDrafts,...(job.state==="done"?{state:"review" as const}:{})},`Вы сохранили ${saved.name}, версию ${saved.version}`);
  setPreview(saved);
 };
 const discardFile=()=>{if(currentFile){const fileDrafts={...job.fileDrafts};delete fileDrafts[currentFile.id];update({...job,fileDrafts});}const next=pendingPreview?.file||null;setPreview(next);if(next)appPanel.openFixedTab({surface:{kind:"current"},tab:documentTab,target:{jobId:job.id,fileId:next.id}});setPendingPreview(null);};
 const question=job.question||(job.id==="AG-105"?designQuestion:null);
 const answerQuestion=(answers:Answers)=>{if(!question||question.status!=="pending")return;change({question:{...question,status:"resolved",answers,draft:undefined},state:"queued"},`Вы ответили на вопросы ${job.agent}. Ответ сохранён в примере.`);};
 const initial:TaskActivity[]=hasExample?[
 {id:"assignment",kind:"event",text:"Мария назначила задачу Анне",at:"2026-09-13T10:00:00+02:00"},
 {id:"manager",kind:"comment",author:"Мария",role:"Руководитель",providerId:"codex",text:"Вводные согласованы. Анна, подготовь оффер по исследованию аудитории и передай результат на проверку.",at:"2026-09-13T10:01:00+02:00"},
 {id:"writer",kind:"comment",author:"Анна",role:"Копирайтер",providerId:"codex",text:"Подготовила вторую версию. Основной текст и условия вынесла в файл — его можно открыть прямо здесь.",at:"2026-09-13T10:18:00+02:00",fileIds:["offer-v2"]},
 {id:"critic",kind:"comment",author:"Марк",role:"Проверяющий",providerId:"codex",text:"Перед публикацией нужно подтвердить условия услуги. Замечания приложил отдельно; решение по результату остаётся за вами.",at:"2026-09-13T10:22:00+02:00",fileIds:["review-notes"]}
 ]:job.comments.map((text,i)=>({id:`initial-${i}`,kind:"comment",author:text.split(":")[0],role:"Участник",text:text.includes(":")?text.slice(text.indexOf(":")+1).trim():text,at:""}));
 const activity=[...initial,...(job.activity||[])].filter(x=>filter==="all"||x.kind===filter);
 const submitComment=()=>{if(!comment.trim()&&!pendingFiles.length)return;update({...job,files:[...(job.files||[]),...pendingFiles],activity:[...(job.activity||[]),{id:crypto.randomUUID(),kind:"comment",author:"Вы",text:comment.trim(),at:new Date().toISOString(),fileIds:pendingFiles.map(f=>f.id)}]});setComment("");setPendingFiles([]);};
 const attach=(added:TaskFile[])=>change({files:[...(job.files||[]),...added]},`Вы прикрепили: ${added.map(f=>f.name).join(", ")}`);
 const createChild=()=>{if(!childTitle.trim())return;const id=`AG-${Math.max(100,...jobs.map(j=>Number(j.id.slice(3))))+1}`;addJob({id,title:childTitle.trim(),parentId:job.id,state:"backlog",project:job.project,department:job.department,agent:job.agent,priority:"Обычный",due:job.due,description:"Опишите ожидаемый результат и критерии приёмки.",comments:[]});setChildTitle("");setChildForm(false);};
 useEffect(()=>{if(currentFile)publishDocument({jobId:job.id,file:currentFile,draft,onDraft:content=>update({...job,fileDrafts:{...job.fileDrafts,[currentFile.id]:content}}),onSave:saveFile,close:()=>selectFile(null),select:selectFile,files});else publishDocument(null);});
 useEffect(()=>()=>publishDocument(null),[]);
 return <article data-document-visible={documentVisible} className="agency-task-layout mx-auto w-full max-w-7xl px-1 pb-8 sm:px-4">
  <nav aria-label="Путь задачи" className="mb-5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground"><Button size="sm" variant="ghost" onClick={back}>Все задачи</Button><span>/</span>{parent&&<><Button size="sm" variant="ghost" onClick={()=>openJob(parent.id)}>{parent.id}</Button><span>/</span></>}<span className="px-2 font-mono">{job.id}</span></nav>
  <div className="agency-task-grid">
  <header className="agency-task-title space-y-3"><div className="flex flex-wrap items-start justify-between gap-3"><h1 className="min-w-0 flex-1 break-words text-xl font-semibold leading-snug tracking-tight">{job.title}</h1><Handoff job={job} agents={agents} files={files} update={update}/><Button size="sm" variant="ghost" onClick={()=>{setTitle(job.title);setDescription(job.description);setEditing(true);}}>Редактировать</Button></div><div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground"><Status state={job.state}/><span>{job.project}</span><span>{job.id}</span></div></header>
  <div className="agency-task-content">

  {question&&<TaskQuestionBlock question={question} agent={job.agent} onDraft={draft=>update({...job,question:{...question,draft}})} onAnswer={answerQuestion}/>}
  {!question&&
  <section aria-label="Текущее состояние" className={`mb-6 rounded-xl border p-5 ${job.state==="review"?"border-foreground/20 bg-muted/60":"border-border bg-muted/30"}`}>
   <div className="flex items-start gap-3"><span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-background"><Icon name={job.state==="review"?"MessageQuestion":"CircleCheck"} className="size-5"/></span><div className="min-w-0 flex-1"><span className="text-xs text-muted-foreground">{job.state==="review"?"Нужно ваше решение":"Текущий этап"}</span><h2 className="mt-1 text-base font-semibold">{job.state==="review"?"Проверьте результат работы":nextState[job.state]}</h2><p className="mt-1 text-sm text-muted-foreground">{(hasExample&&(job.state==="review"||job.state==="done"))?"Анна подготовила оффер. Марк оставил замечания к условиям услуги.":`Исполнитель: ${job.agent}`}</p>
   {hasExample&&<div className="mt-4 flex flex-wrap gap-2"><FileChip file={files.find(f=>f.id==="offer-v2")!} open={selectFile}/></div>}
   <div className="mt-4 flex flex-wrap gap-2">{hasExample&&job.state==="review"&&<><Button size="sm" onClick={()=>change({state:"done"},`Вы приняли Оффер.md, версию ${files.find(f=>f.id==="offer-v2")?.version||2}`)}>Принять результат</Button><Button size="sm" variant="outline" onClick={()=>setReviewing(true)}>Вернуть с замечанием</Button></>}{job.state==="backlog"&&<Button size="sm" onClick={()=>setStatus("queued")}>Передать в работу</Button>}</div></div></div>
  </section>}
  <section className="py-3"><h2 className="mb-3 text-sm font-semibold">Описание и критерии</h2><div className="max-w-prose text-sm"><Markdown content={job.description}/></div></section>
  <section className="border-t border-border py-4"><div className="mb-3 flex items-center justify-between gap-2"><h2 className="text-sm font-medium">Подзадачи <span className="ml-1 text-xs text-muted-foreground">{children.filter(j=>j.state==="done").length}/{children.length}</span></h2><Button size="sm" variant="ghost" onClick={()=>setChildForm(true)}>Добавить подзадачу</Button></div>{children.length?children.map(child=><button key={child.id} onClick={()=>openJob(child.id)} className="flex min-h-10 w-full items-center gap-3 border-b border-border py-2 text-left text-sm hover:bg-muted/40 focus-visible:outline focus-visible:outline-ring"><span className="font-mono text-xs text-muted-foreground">{child.id}</span><span className="min-w-0 flex-1 truncate">{child.title}</span><Status state={child.state}/></button>):<p className="text-xs text-muted-foreground">Подзадач пока нет. Добавьте отдельный результат, который нужно поручить.</p>}</section>
  <section className="mt-6 border-t border-border pt-7" aria-label="История задачи"><div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-base font-semibold">История и обсуждение</h2><div className="w-40"><Choice label="Фильтр истории" value={filter} onChange={setFilter} options={[{value:"all",label:"Всё"},{value:"comment",label:"Комментарии"},{value:"event",label:"События"}]}/></div></div>
   {activity.length?<ol className="ml-4 border-l border-border">{activity.map(item=>item.kind==="event"?<li key={item.id} className="relative py-3 pl-7"><span className="absolute -left-1 top-4 size-2 rounded-full border border-border bg-background"/><p className="text-xs text-muted-foreground">{item.text}<span className="ml-2 opacity-70">{item.at&&new Date(item.at).toLocaleTimeString("ru",{hour:"2-digit",minute:"2-digit"})}</span></p></li>:<li key={item.id} className="relative py-4 pl-7"><span className="absolute -left-4 top-4 flex size-8 items-center justify-center rounded-full border border-border bg-background">{item.providerId?<AgentMark id={item.providerId} className="size-5"/>:<Icon name={item.author==="Вы"?"UserRoundPlus":"Bot"} className="size-4"/>}</span><div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1"><span className="text-sm font-semibold">{item.author||"Вы"}</span>{item.role&&<span className="text-xs text-muted-foreground">{item.role}</span>}<span className="text-xs text-muted-foreground">{item.at?<time dateTime={item.at}>{new Date(item.at).toLocaleTimeString("ru",{hour:"2-digit",minute:"2-digit"})}</time>:"Начало примера"}</span></div>{item.text&&<div className="max-w-prose whitespace-pre-wrap break-words text-sm leading-relaxed">{item.text.replace(/^Вы: /,"")}</div>}<div className="mt-3 flex flex-wrap gap-2">{(item.fileIds||[]).map(id=>files.find(f=>f.id===id)).filter((f):f is TaskFile=>Boolean(f)).map(file=><FileChip key={file.id} file={file} open={selectFile}/>)}</div></li>)}</ol>:<p className="mb-4 text-xs text-muted-foreground">Здесь пока нет сообщений.</p>}
   <div className="mt-5 rounded-xl border border-border bg-muted/20 p-3"><label htmlFor={`comment-${job.id}`} className="sr-only">Комментарий к задаче</label><textarea id={`comment-${job.id}`} rows={3} value={comment} onChange={e=>setComment(e.target.value)} placeholder="Написать комментарий…" className="w-full resize-y rounded-md bg-transparent p-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"/><div className="mb-2 flex flex-wrap gap-2">{pendingFiles.map(file=><div key={file.id} className="flex items-center gap-1"><FileChip file={file} open={selectFile}/><Button variant="ghost" size="sm" aria-label={`Убрать ${file.name}`} onClick={()=>setPendingFiles(pendingFiles.filter(f=>f.id!==file.id))}>×</Button></div>)}</div><div className="flex flex-wrap items-center justify-between gap-2"><FilePicker label="Добавить файл" onFiles={added=>setPendingFiles([...pendingFiles,...added])} notice={notice}/><Button size="sm" disabled={!comment.trim()&&!pendingFiles.length} onClick={submitComment}>Отправить комментарий</Button></div></div><p className="mt-2 text-xs text-muted-foreground">Комментарии и файлы сохраняются до перезагрузки. Агент не запускается.</p>
  </section>


  </div>
  <aside aria-label="Сведения о задаче" className="agency-task-sidebar rounded-xl border border-border bg-muted/25 p-4" data-expanded={detailsOpen}>
   <h2 className="agency-task-sidebar-heading text-sm font-semibold">Сведения о задаче</h2>
   <Button variant="ghost" className="agency-task-sidebar-toggle h-auto min-h-9 w-full justify-between px-0 text-left" aria-expanded={detailsOpen} aria-controls={`task-details-${job.id}`} onClick={()=>setDetailsOpen(!detailsOpen)}><span>Сведения о задаче</span><Icon name={detailsOpen?"ChevronUp":"ChevronDown"} className="size-4"/></Button>
   <div id={`task-details-${job.id}`} className="agency-task-sidebar-content space-y-5">
    <section aria-label="Свойства задачи" className="space-y-3 [&_button[role=combobox]]:bg-background [&_input]:bg-background">
     <Field label="Статус"><Choice label="Статус задачи" value={job.state} onChange={v=>setStatus(v as State)} options={states.map(value=>({value,label:stateNames[value]}))}/></Field>
     <Field label="Исполнитель"><Choice label="Исполнитель задачи" value={job.agent} onChange={agent=>change({agent},`Исполнитель: ${agent}`)} options={["Мария","Анна","Марк","Илья","София"]}/></Field>
     <Field label="Приоритет"><Choice label="Приоритет задачи" value={job.priority} onChange={priority=>change({priority},`Приоритет: ${priority}`)} options={["Низкий","Обычный","Высокий","Срочный"]}/></Field>
     <TextField label="Срок" type="date" value={job.due} onChange={due=>change({due},`Срок: ${due || "не задан"}`)}/>
     <Field label="Проект"><Choice label="Проект задачи" value={job.project} onChange={project=>change({project},`Проект: ${project}`)} options={["SelfyStudio","BB-сервис"]}/></Field>
     <Field label="Отдел"><Choice label="Отдел задачи" value={job.department} onChange={department=>change({department},`Отдел: ${department}`)} options={["Маркетинг","Редакция","Дизайн","Исследования"]}/></Field>
    </section>
  <section className="border-t border-border pt-5" aria-label="Вложения задачи"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">Вложения <span className="ml-1 text-xs font-normal text-muted-foreground">{files.length}</span></h2><FilePicker onFiles={attach} notice={notice}/></div><div className="flex flex-col gap-2 [&>button]:w-full">{files.map(file=><FileChip key={file.id} file={file} open={selectFile}/>)}</div>{!files.length&&<p className="text-xs text-muted-foreground">Прикрепите материалы к задаче или сообщению.</p>}</section>
  <section className="border-t border-border pt-5"><h2 className="mb-3 text-sm font-medium">Исполнители и запуски</h2>{hasExample?<div className="flex flex-col items-start gap-3 text-sm"><div className="flex items-center gap-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted"><AgentMark id={"codex"} className="size-5"/></span><div><span>Анна · Подготовка оффера</span><p className="mt-1 text-xs text-muted-foreground">RUN-204 · пример завершённого запуска</p></div></div><Button size="sm" variant="outline" onClick={openRun}>Открыть запуск</Button></div>:<p className="text-xs text-muted-foreground">Запусков нет. Назначенный исполнитель — {job.agent}.</p>}</section>

   </div>
  </aside>
  </div>
  <Dialog open={editing} onOpenChange={setEditing}><DialogContent><DialogHeader><DialogTitle>Редактировать задачу</DialogTitle><DialogDescription>Изменения сохранятся в примере до перезагрузки страницы.</DialogDescription></DialogHeader><TextField label="Название" value={title} onChange={setTitle}/><TextField label="Описание и критерии" value={description} onChange={setDescription} multiline/><DialogFooter><Button variant="outline" onClick={()=>setEditing(false)}>Отмена</Button><Button disabled={!title.trim()} onClick={()=>{change({title:title.trim(),description},"Вы обновили описание задачи");setEditing(false);}}>Сохранить</Button></DialogFooter></DialogContent></Dialog>
  <Dialog open={childForm} onOpenChange={setChildForm}><DialogContent><DialogHeader><DialogTitle>Новая подзадача</DialogTitle><DialogDescription>Будет связана с {job.id} и унаследует проект и исполнителя.</DialogDescription></DialogHeader><TextField label="Название подзадачи" value={childTitle} onChange={setChildTitle}/><DialogFooter><Button variant="outline" onClick={()=>setChildForm(false)}>Отмена</Button><Button disabled={!childTitle.trim()} onClick={createChild}>Создать подзадачу</Button></DialogFooter></DialogContent></Dialog>
  <Dialog open={Boolean(pendingPreview)} onOpenChange={open=>{if(!open)setPendingPreview(null);}}><DialogContent><DialogHeader><DialogTitle>В файле есть несохранённые изменения</DialogTitle><DialogDescription>Сохраните правки или отбросьте их перед переходом.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={()=>setPendingPreview(null)}>Продолжить редактирование</Button><Button variant="outline" onClick={discardFile}>Отбросить правки</Button><Button onClick={()=>{const next=pendingPreview?.file||null;saveFile();setPreview(next);if(next)appPanel.openFixedTab({surface:{kind:"current"},tab:documentTab,target:{jobId:job.id,fileId:next.id}});setPendingPreview(null);}}>Сохранить и перейти</Button></DialogFooter></DialogContent></Dialog>
  <Dialog open={reviewing} onOpenChange={setReviewing}><DialogContent><DialogHeader><DialogTitle>Вернуть результат на доработку</DialogTitle><DialogDescription>Укажите, что требуется изменить в результате.</DialogDescription></DialogHeader><TextField label="Замечания" value={reason} onChange={setReason} multiline/><DialogFooter><Button variant="outline" onClick={()=>setReviewing(false)}>Отмена</Button><Button disabled={!reason.trim()} onClick={()=>{change({state:"running"},`Вы вернули Оффер.md, версию ${files.find(f=>f.id==="offer-v2")?.version||2}: ${reason.trim()}`);setReason("");setReviewing(false);}}>Вернуть на доработку</Button></DialogFooter></DialogContent></Dialog>
 </article>;
}
