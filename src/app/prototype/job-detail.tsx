import { JobGoalChoice } from "./job-goal";
import { usePluginFeatures } from "./use-plugin-features";
import { humanizeIds } from "../data/humanize-ids";
import { useTemplates } from "./use-templates";
import { DUE_TONE_CLASS, dueStatus } from "../data/job-due";
import { rpcContract } from '../../shared/rpc-contract';
import { documentSessionId, registerDocumentTarget, publishDocument, useDocumentVisible } from "./document-panel";
import { Handoff } from "./handoff";
import "./job-detail.css";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Markdown, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../../../components/ui/dialog";
import { type Agent, type Job, type State, type TaskActivity, type TaskFile, states, stateNames } from "./data";
import { runsForJob } from "./run-links";
import { exampleFiles } from "./demo/files";
import { FileChip, FilePicker } from "./task-files";
import { Button, AgentMark, Icon, TextField, Choice, Status, Field, InfoHint } from "./shared";
import { RailCard, RailPerson, RailRow } from "./job-rail";

import { TaskQuestionBlock } from "./task-question";
import { JobNeedsInputPanel } from "./job-needs-input";
import { NEEDS_INPUT_COMMENT_HINT, jobDetailRefreshKey, nextNeedsInputFromDetail } from "../data/needs-input";
import { createLiveRunsFetchGate } from "../data/live-runs";
import type { NeedsInputRecord } from "../../shared/contracts";
import { designQuestion, type Answers } from "./question-contract";
import { createRpcAgencyApi, type RpcCaller } from "../data";
import { decodeArtifactBytes, isOpaqueRecordId } from "../data/content-hash";
import { failureNotice, persistArtifactUpload, persistJobComment, openPersistedArtifact } from "../data/persist";
import { applyDraftsAfterSave, canLeaveAfterSave, commitDocumentSave } from "../data/document-save";
import { clearFileDraft } from "../data/job-record-patch";
import { JobLaunchPanel } from "./job-launch-panel";
import { JobAcceptControls } from "./job-accept";
import { JobEditDialog } from "./job-edit-dialog";
import { activityRoleLabel, jobLifecycleLocked, manualStatusOptions, STOP_RUN_FIRST_NOTICE, WORK_STATE_NOTICE } from "../data/job-lifecycle";
import { mergeJobFiles } from "../data/job-artifacts";
import { mapActivity, mapJobFiles, nextJobKey, splitDescription } from "../data/view-models";
import { nativePreviewFromOpen } from "../data/native-preview";
import { documentVisibilityId } from "../data/document-visibility";
import { assigneeChoiceOptions, assigneeFields, canConfirmPlacement, departmentsForBinding, JOB_ASSIGNEE_EMPTY_DEPARTMENT, JOB_CREATE_NO_DEPARTMENTS, linksFromProjects, placementFields, sanitizeDepartmentId, selectedAgentId, selectedBindingId, selectedDepartmentId, UNASSIGNED_AGENT } from "../data/job-placement";
import { JobTeamBlock } from "./job-team";
import { parseJobTeamRoles, resolveJobTeam, TEAM_UNASSIGNED, TEAM_UNASSIGNED_ONE } from "../data/job-team";
import { attemptsLabel, HOST_UNKNOWN, isolationLabel, jobHostLabel, JOB_ENVIRONMENT_UNKNOWN, type JobEnvironmentStatus } from "../data/job-environment";
import { jobEditCommit, jobEditDraftFrom, type JobEditDraft } from "../data/job-edit-draft";
import { shortAgentName } from "../data/agent-name";
import { JobTreePanel } from "./job-tree";
import { JobFlowDialog, JobFlowSection, type JobFlowLinks } from "./job-flow";
import type { NextStepViewRecord } from "../../shared/rpc-contract";
import { attemptStatusEqual, type AttemptStatus } from "../data/job-team";
import { childProgressLabel, jobParentBreadcrumb, MAIN_JOB_LABEL, type JobDependencyEdge } from "../data/job-tree";
import { compareJobKeys, displayJobTitle, isClosedJob } from "../data/job-board";
import { UsageRootSummary } from "./usage-root-summary";
import { CollapsibleText, SubtaskSection } from "./job-subtasks";
import { AssigneeField, CONTRACT_HINT, JobBriefFields, JobContractFields, assigneeOptions as teamAssigneeOptions, autoAssignmentOf, composeJobDescription, withAutoAssignment } from "./job-fields";
import { intakeLabel, latestIntake } from "../data/intake";
import { tr, uiLocale } from "../i18n";

type Props = {agents:Agent[];projects?:{id:string;name:string;members?:readonly string[];hostName?:string|null;archivedAt?:string;recordId?:string;bbProjectId?:string}[];departments?:{id:string;name:string;members?:readonly string[];lead?:string;availability?:"all"|"selected";memberRoles?:Record<string,"executor"|"reviewer">}[];job:Job;jobs:Job[];update:(j:Job)=>void|Promise<boolean>;addJob:(j:Job)=>void|Promise<boolean>;openJob:(id:string)=>void;openAgent?:(id:string)=>void;openDepartment?:(id:string)=>void;openProject?:(id:string)=>void;back:()=>void;notice:(s:string)=>void;openRun:(runId:string)=>void;openUsage?:(recordId:string)=>void;runs?:import("./data").DemoRun[];demoMode?:boolean};
const nextState: Partial<Record<State, string>> = {
 backlog:"Поручение ещё не отправлено исполнителю. Проверьте бриф и критерии, затем поставьте в очередь.",queued:"Поручение в очереди. Нажмите «Запустить», чтобы сотрудник начал работу.",
 running:"Исполнитель готовит результат.",review:"Результат ожидает проверки.",waiting_input:"Нужен ответ на вопрос исполнителя.",blocked:"Работа остановлена. Причина — в истории задачи: верните задачу в очередь и запустите снова или отмените.",done:"Результат принят.",canceled:"Задача отменена.",
};
export function JobDetail({agents,projects=[],departments=[],job,jobs,update,addJob,openJob,openAgent,openDepartment,openProject,back,notice,openRun,openUsage,runs=[],demoMode=false}:Props) {
 const navigate=useBbNavigate();const rpc=useRpc<typeof rpcContract>();const api=useMemo(()=>createRpcAgencyApi(rpc as unknown as RpcCaller),[rpc]);const openSequence=useRef(0);const documentJobId=documentVisibilityId(job,!demoMode);const documentVisible=useDocumentVisible(documentJobId);
 const [detailsOpen,setDetailsOpen]=useState(false);
 const [treeOpen,setTreeOpen]=useState(false);
 const [dependencies,setDependencies]=useState<JobDependencyEdge[]>([]);
 const [flowLinks,setFlowLinks]=useState<JobFlowLinks>({waitsFor:[],blocks:[]});const [nextStep,setNextStep]=useState<NextStepViewRecord|null>(null);const [flowOpen,setFlowOpen]=useState(false);
 const [attemptStatus,setAttemptStatus]=useState<AttemptStatus>({kind:"unknown"});
 const [launchReady,setLaunchReady]=useState(false);
 const onAttemptStatus=useCallback((next:AttemptStatus)=>{
  setAttemptStatus((current)=>attemptStatusEqual(current,next)?current:next);
 },[]);
 const onLaunchReady=useCallback((ready:boolean)=>{
  setLaunchReady((current)=>current===ready?current:ready);
 },[]);
 const [comment,setComment]=useState("");const [filter,setFilter]=useState("all");
 const [editing,setEditing]=useState(false);const [editPending,setEditPending]=useState(false);
 const [editDraft,setEditDraft]=useState<JobEditDraft>(()=>jobEditDraftFrom(job,agents,demoMode));
 const patchEditDraft=(patch:Partial<JobEditDraft>)=>setEditDraft((current)=>({...current,...patch}));
 const [environment,setEnvironment]=useState<JobEnvironmentStatus>(JOB_ENVIRONMENT_UNKNOWN);
 const onEnvironment=useCallback((next:JobEnvironmentStatus)=>{
  setEnvironment((current)=>current.isolationReady===next.isolationReady&&current.attempts===next.attempts?current:next);
 },[]);
 const [childForm,setChildForm]=useState(false);const [childTitle,setChildTitle]=useState("");const [childPending,setChildPending]=useState(false);
 const [childFolder,setChildFolder]=useState("");const [childDepartment,setChildDepartment]=useState("");const [childAssignee,setChildAssignee]=useState("");const [childBrief,setChildBrief]=useState("");const [childAcceptance,setChildAcceptance]=useState("");const [childContract,setChildContract]=useState<Job["contract"]>();const childTemplates=useTemplates();
 const [placing,setPlacing]=useState(false);const [draftBinding,setDraftBinding]=useState("");const [draftDepartment,setDraftDepartment]=useState("");
 const [preview,setPreview]=useState<TaskFile|null>(null);const [pendingFiles,setPendingFiles]=useState<TaskFile[]>([]);const [reviewing,setReviewing]=useState(false);const [reason,setReason]=useState("");
 const children=jobs.filter(j=>j.parentId===job.id).sort((a,b)=>compareJobKeys(a.id,b.id));const ancestors=jobParentBreadcrumb(jobs,job);const childProgress=childProgressLabel(children);
 const jobRuns=runsForJob(job.id,runs);
 const change=(patch:Partial<Job>,text:string)=>update({...job,...patch,activity:[...(job.activity||[]),{id:crypto.randomUUID(),kind:"event",text,at:new Date().toISOString()}]});
 const openEdit=()=>{setEditDraft(jobEditDraftFrom(job,agents,demoMode));setEditing(true);};
 const saveEdit=async()=>{
  if(editPending||!editDraft.title.trim())return;
  const commit=jobEditCommit(editDraft,job,agents,{demoMode,statusLocked});
  if(!commit){setEditing(false);return;}
  setEditPending(true);
  const ok=await Promise.resolve(change(commit.patch,commit.summary));
  setEditPending(false);
  if(ok===false)return;
  setEditing(false);
 };
 const placementLinks=linksFromProjects(projects.map((item)=>({id:item.id,members:item.members||[]})),departments);
 const liveBinding=selectedBindingId(job,projects);
 const liveDepartment=selectedDepartmentId(job,departments);
 const liveAgent=selectedAgentId(job,agents);
 const assigneeOptions=assigneeChoiceOptions(liveDepartment,departments,agents,job.assignedAgentId);
 const assigneeHint=liveDepartment&&assigneeOptions.length<=1?JOB_ASSIGNEE_EMPTY_DEPARTMENT:null;
 const draftDepartments=departmentsForBinding(departments,placementLinks,draftBinding);
 const projectName=job.project||projects.find(item=>item.id===liveBinding)?.name||"";
 const departmentName=departments.find(item=>item.id===liveDepartment)?.name||job.department;
 const hostName=demoMode?"Пример":jobHostLabel(liveBinding,projects);
 const isolation=isolationLabel(environment);
 const railTeam=resolveJobTeam({job,projects,departments,agents,roles:parseJobTeamRoles(job),attempt:attemptStatus,demoFallback:demoMode});
 const dueRail=dueStatus(job,Date.now());
 const brief=splitDescription(job.description);
 const openPlacement=()=>{setDraftBinding(liveBinding);setDraftDepartment(sanitizeDepartmentId(liveDepartment,departmentsForBinding(departments,placementLinks,liveBinding)));setPlacing(true);};
 const changeDraftBinding=(next:string)=>{setDraftBinding(next);setDraftDepartment((current)=>sanitizeDepartmentId(current,departmentsForBinding(departments,placementLinks,next)));};
 const confirmPlacement=()=>{
  const next=placementFields(draftBinding,draftDepartment,projects,departments);
  if(!next||!canConfirmPlacement(draftBinding,draftDepartment,placementLinks,departments))return;
  change(next,tr("Проект и отдел: {project} · {department}",{project:next.project,department:next.department}));
  setPlacing(false);
 };
 const changeAssignee=(agentId:string)=>{const next=assigneeFields(agentId,agents);change(next,tr("Исполнитель: {agent}",{agent:next.agent}));};
 const [remoteFiles,setRemoteFiles]=useState<TaskFile[]>([]);
 // Artifact of the latest acceptance: a closed job leads with the accepted file, not the first one.
 const [acceptedArtifactId,setAcceptedArtifactId]=useState<string|null>(null);
 const [remoteActivity,setRemoteActivity]=useState<TaskActivity[]>([]);
 // Live history arrives separately from the job record; the intake comment lives there.
 const intake=latestIntake([...remoteActivity,...(job.activity||[])]);
 const parentJob=job.parentId?jobs.find(item=>item.id===job.parentId):undefined;
 const siblings=parentJob?jobs.filter(item=>item.parentId===parentJob.id).sort((a,b)=>compareJobKeys(a.id,b.id)):[];
 const [needsInput,setNeedsInput]=useState<NeedsInputRecord|null>(null);
 const needsInputRef=useRef<NeedsInputRecord|null>(null);
 const detailGate=useRef(createLiveRunsFetchGate());
 const jobRef=useRef(job);
 jobRef.current=job;
 const refreshKey=jobDetailRefreshKey(job);
 const statusLocked=jobLifecycleLocked(job,Boolean(needsInput));
 const [returning,setReturning]=useState(false);
 const attemptActive=attemptStatus.kind==="state"&&["launching","running","waiting_input","unknown"].includes(attemptStatus.state);
 const returnForRework=async()=>{
  const text=reason.trim();
  if(!text||returning)return;
  if(demoMode||!job.recordId||job.revision==null){change({state:"running"},tr("Вы вернули результат: {text}",{text}));setReason("");setReviewing(false);return;}
  setReturning(true);
  const result=await api.returnJobForRework({requestId:crypto.randomUUID(),jobId:job.recordId,expectedRevision:job.revision,comment:text});
  setReturning(false);
  if(!result.ok){notice(failureNotice(result.failure));return;}
  setReason("");setReviewing(false);
  notice(tr("Результат возвращён на доработку. Исполнитель получил замечания."));
  void refreshLive();
 };
 const setStatus=(state:State)=>{if(state!==job.state&&!statusLocked)change({state},tr("Вы изменили статус: {from} → {to}",{from:tr(stateNames[job.state]),to:tr(stateNames[state])}));};
 const [fileDrafts,setFileDrafts]=useState<Record<string,string>>({});
 const [fileSaving,setFileSaving]=useState(false);
 const [fileSaveError,setFileSaveError]=useState<string|null>(null);
 const savingRef=useRef(false);
 const refreshLive=useCallback(async()=>{
  const current=jobRef.current;
  if(demoMode||!current.id)return;
  if(!detailGate.current.isMounted())return;
  const token=detailGate.current.begin(jobDetailRefreshKey(current));
  const envelope=await api.getJob(current.recordId?{jobId:current.recordId}:{key:current.id});
  if(!detailGate.current.accept(token))return;
  if(!envelope.ok){notice(failureNotice(envelope.failure));return;}
  const mapped=mapJobFiles(envelope.value);
  setRemoteFiles((files)=>mapped.map((file)=>{
    const previous=files.find((item)=>item.id===file.id);
    return previous?.content?{...file,content:previous.content,kind:previous.kind}:file;
  }));
  setRemoteActivity(mapActivity(envelope.value.activity??[],agents));
  setAcceptedArtifactId([...(envelope.value.activity??[])].reverse().find((row)=>row.kind==="artifact_accepted")?.references.find((ref)=>ref.type==="artifact")?.id??null);
  setDependencies(envelope.value.dependencies??[]);
  setFlowLinks(envelope.value.links??{waitsFor:[],blocks:[]});
  setNextStep(envelope.value.nextStep??null);
  const applied=nextNeedsInputFromDetail(needsInputRef.current,envelope.value.needsInput??null);
  needsInputRef.current=applied.record;
  setNeedsInput(applied.record);
  if(applied.clearNotice)notice("");
 },[api,agents,demoMode,notice]);
 const refreshLiveRef=useRef(refreshLive);
 refreshLiveRef.current=refreshLive;
 useEffect(()=>{
  const gate=createLiveRunsFetchGate();
  detailGate.current=gate;
  return()=>{gate.unmount();};
 },[]);
 useEffect(()=>{
  if(demoMode||!job.id)return;
  void refreshLiveRef.current();
 },[demoMode,job.id,refreshKey]);
 useRealtime("domain-changed",()=>{
  if(!demoMode)void refreshLiveRef.current();
 });
 const demoFiles=demoMode&&job.id==="AG-102"?exampleFiles:[];
 const files=mergeJobFiles(demoFiles,job.files,remoteFiles);
 const currentFile=preview?(files.find(f=>f.id===preview.id)||preview):null;
 const stageFile=(job.state==="done"&&acceptedArtifactId?files.find(f=>f.id===acceptedArtifactId):undefined)??files[0];
 const draft=currentFile?(fileDrafts[currentFile.id]??currentFile.content):"";
 const writeDraft=(content:string)=>{if(currentFile)setFileDrafts((current)=>({...current,[currentFile.id]:content}));};
 const [pendingPreview,setPendingPreview]=useState<{file:TaskFile|null}|null>(null);
 const openNativeTab=(hostId:string,path:string,file:TaskFile)=>{
  registerDocumentTarget(path,documentJobId,file.id);
  if(!navigate.experimental_openFilePreview({target:{kind:'host',hostId,path},location:null}))notice(tr('Не удалось открыть документ в панели BB.'));
 };
 const openDocument=async(file:TaskFile)=>{
  const sequence=++openSequence.current;
  if(!demoMode){
   if(!(job.recordId&&isOpaqueRecordId(file.id)&&file.version)){
    notice(tr('Сначала сохраните файл.'));
    return;
   }
   const opened=await openPersistedArtifact(api,{artifactId:file.id,jobId:job.recordId,version:file.version,expectedHash:file.hash});
   if(sequence!==openSequence.current)return;
   if(!opened.ok){notice(failureNotice(opened.failure));return;}
   const loaded={...file,content:decodeArtifactBytes(opened.value.bytesBase64,file.kind,file.name),size:opened.value.size,hash:opened.value.hash};
   setRemoteFiles((current)=>current.map((item)=>item.id===loaded.id?loaded:item));
   setPreview(loaded);
   const preview=nativePreviewFromOpen(opened.value);
   if(!preview.ok){notice(preview.message);return;}
   openNativeTab(preview.target.hostId,preview.target.path,loaded);
   return;
  }
  try{
   const target=await rpc.call('prepareDemoDocument',{sessionId:documentSessionId,jobId:job.id,fileId:file.id,name:file.name,content:file.content,kind:file.kind});
   if(sequence!==openSequence.current)return;
   if(!target.demo){notice(tr('Предпросмотр не является демо-копией. Реальный файл этим методом не открывается.'));return;}
   openNativeTab(target.hostId,target.path,file);
  }catch{notice(tr('Не удалось подготовить документ. Повторите открытие файла.'));}
 };
 useEffect(()=>()=>{openSequence.current++;},[]);
 const selectFile=(file:TaskFile|null)=>{if(currentFile&&draft!==currentFile.content&&file?.id!==currentFile.id){setPendingPreview({file});return;}setPreview(file);if(file)void openDocument(file);};
 const saveFile=async(content?:string):Promise<boolean>=>{
  if(!currentFile)return false;
  if(savingRef.current)return false;
  const text=content??draft;
  if(text===currentFile.content)return true;
  if(content!==undefined&&content!==draft)writeDraft(content);
  const saved={...currentFile,content:text,size:new TextEncoder().encode(text).length,version:(currentFile.version||1)+1,previousVersions:[...(currentFile.previousVersions||[]),{version:currentFile.version||1,content:currentFile.content,at:new Date().toISOString()}]};
  setFileSaving(true);
  setFileSaveError(null);
  const finished=await commitDocumentSave({
   savingRef,
   persist:async()=>{
    if(!demoMode&&job.recordId){
     const result=await persistArtifactUpload(api,job.recordId,saved);
     if(!result.ok)return result;
     return {ok:true as const,value:{artifactId:result.value.artifactId,version:result.value.version,hash:result.value.hash}};
    }
    return {ok:true as const,value:{artifactId:saved.id,version:saved.version||1,hash:saved.hash||""}};
   },
   afterSuccess:async(published)=>{
    if(!demoMode&&job.recordId){
     const next={...saved,id:published.artifactId,version:published.version,hash:published.hash};
     setRemoteFiles((current)=>current.map((item)=>item.id===currentFile.id||item.id===next.id?next:item));
     setPreview(next);
     await refreshLive();
     await openDocument(next);
     return;
    }
    if(pendingFiles.some(f=>f.id===saved.id)){setPendingFiles(pendingFiles.map(f=>f.id===saved.id?saved:f));}
    else change({files:[...(job.files||[]).filter(f=>f.id!==saved.id),saved],...(job.state==="done"?{state:"review" as const}:{})},tr("Вы сохранили {name}, версию {version}",{name:saved.name,version:saved.version}));
    setPreview(saved);
    await openDocument(saved);
   },
   failureMessage:failureNotice,
  });
  setFileSaving(false);
  if(!finished.ok){
   if(finished.error){setFileSaveError(finished.error);notice(finished.error);}
   return false;
  }
  setFileDrafts((current)=>applyDraftsAfterSave(current,[currentFile.id,finished.value.artifactId],text));
  return true;
 };
 const discardFile=()=>{if(currentFile)setFileDrafts((current)=>clearFileDraft(current,currentFile.id));const next=pendingPreview?.file||null;setPreview(next);if(next)void openDocument(next);setPendingPreview(null);};
 const question=demoMode?(job.question||(job.id==="AG-105"?designQuestion:null)):null;
 const answerQuestion=(answers:Answers)=>{if(!question||question.status!=="pending")return;change({question:{...question,status:"resolved",answers,draft:undefined},state:"queued"},tr("Вы ответили на вопросы {agent}. Ответ сохранён в примере.",{agent:job.agent}));};
  const demoHistory:TaskActivity[]=demoMode&&job.id==="AG-102"?[
  {id:"assignment",kind:"event",text:"Мария назначила задачу Анне",at:"2026-09-13T10:00:00+02:00"},
  {id:"manager",kind:"comment",author:"Мария",role:"Руководитель",providerId:"claude-code",model:"claude-fable-5-1",reasoningEffort:"medium",text:"Вводные согласованы. Анна, подготовь оффер по исследованию аудитории и передай результат на проверку.",at:"2026-09-13T10:01:00+02:00"},
  {id:"writer",kind:"comment",author:"Анна",role:"Копирайтер",providerId:"claude-code",model:"claude-sonnet-5",text:"Подготовила вторую версию. Основной текст и условия вынесла в файл — его можно открыть прямо здесь.",at:"2026-09-13T10:18:00+02:00",fileIds:["offer-v2"]},
  {id:"critic",kind:"comment",author:"Марк",role:"Проверяющий",providerId:"claude-code",model:"claude-opus-5[1m]",reasoningEffort:"high",text:"Перед публикацией нужно подтвердить условия услуги. Замечания приложил отдельно; решение по результату остаётся за вами.",at:"2026-09-13T10:22:00+02:00",fileIds:["review-notes"]}
  ]:[];
 const initial:TaskActivity[]=demoHistory.length?demoHistory:demoMode?job.comments.map((text,i)=>({id:`initial-${i}`,kind:"comment",author:text.split(":")[0],role:tr("Участник"),text:text.includes(":")?text.slice(text.indexOf(":")+1).trim():text,at:""})):[];
 const activity=[...initial,...remoteActivity,...(job.activity||[])].filter(x=>filter==="all"||x.kind===filter);
 const submitComment=()=>{
  if(!comment.trim()&&!pendingFiles.length)return;
  if(!demoMode&&job.recordId){
   const jobId=job.recordId;
   void (async()=>{
    const ids:string[]=[];
    for(const file of pendingFiles){
     const published=await persistArtifactUpload(api,jobId,file);
     if(!published.ok){notice(failureNotice(published.failure));return;}
     ids.push(published.value.artifactId);
    }
    const recorded=await persistJobComment(api,jobId,comment,ids);
    if(!recorded.ok){notice(failureNotice(recorded.failure));return;}
    setComment("");setPendingFiles([]);
    await refreshLive();
   })();
   return;
  }
  update({...job,files:[...(job.files||[]),...pendingFiles],activity:[...(job.activity||[]),{id:crypto.randomUUID(),kind:"comment",author:"Вы",text:comment.trim(),at:new Date().toISOString(),fileIds:pendingFiles.map(f=>f.id)}]});
  setComment("");setPendingFiles([]);
 };
 const attach=(added:TaskFile[])=>{
  if(!demoMode&&job.recordId){
   void (async()=>{
    for(const file of added){
     const published=await persistArtifactUpload(api,job.recordId as string,file);
     if(!published.ok){notice(failureNotice(published.failure));return;}
    }
    await refreshLive();
   })();
   return;
  }
  change({files:[...(job.files||[]),...added]},tr("Вы прикрепили: {names}",{names:added.map(f=>f.name).join(", ")}));
 };
 const features=usePluginFeatures(!demoMode);
 // A subtask lives in the main job's folder. With Projects & Sections it may use another folder of the
 // same BB project; with File Gateway an employee with a workplace takes it in that folder.
 const liveFolder=projects.find(item=>(item.recordId??item.id)===liveBinding);
 const projectFolders=features.projectFolders&&liveFolder?.bbProjectId?projects.filter(item=>!item.archivedAt&&item.bbProjectId===liveFolder.bbProjectId):[];
 const folderBinding=projectFolders.some(item=>(item.recordId??item.id)===childFolder)?childFolder:liveBinding;
 const childDepartments=departmentsForBinding(departments,placementLinks,folderBinding);
 const childDepartmentId=childDepartments.some(item=>item.id===childDepartment)?childDepartment:(childDepartments.find(item=>item.id===liveDepartment)?.id??childDepartments[0]?.id??"");
 const childTeam=departments.find(item=>item.id===childDepartmentId);
 const childChoices=childTeam?.lead?withAutoAssignment(teamAssigneeOptions({id:childTeam.id,lead:childTeam.lead,members:childTeam.members??[],memberRoles:childTeam.memberRoles},agents),{id:childTeam.id,lead:childTeam.lead,members:childTeam.members??[],memberRoles:childTeam.memberRoles}):[];
 // In the job's own department a subtask goes to an executor; in another department to its lead.
 const childDefault=childTeam&&childDepartmentId===liveDepartment?(childChoices.find(item=>item.value!==childTeam.lead)?.value??childChoices[0]?.value):childChoices[0]?.value;
 const childAssigneeId=childChoices.some(item=>item.value===childAssignee)?childAssignee:(childDefault??"");
 const childWorkplaceId=features.fileGateway?agents.find(item=>item.id===childAssigneeId)?.workplaceBindingId:undefined;
 const childWorkplace=childWorkplaceId?projects.find(item=>(item.recordId??item.id)===childWorkplaceId):undefined;
 const childBinding=childWorkplaceId??folderBinding;
 // A connected folder's name already carries its machine.
 const folderLabel=(item:{name:string})=>item.name;
 const jobClosed=job.state==="done"||job.state==="canceled";
 const canCreateChild=Boolean(childTitle.trim())&&!childPending&&(demoMode||Boolean(childDepartmentId&&childAssigneeId&&childBrief.trim()&&childAcceptance.trim()));
 const createChild=async()=>{
  if(!canCreateChild)return;
  setChildPending(true);
  const childAuto=autoAssignmentOf(childAssigneeId);
  const assignee=childAuto?undefined:agents.find(item=>item.id===childAssigneeId);
  const childDept=departments.find(item=>item.id===childDepartmentId);
  const created:Job={id:nextJobKey(jobs.map(item=>item.id)),title:childTitle.trim(),parentId:job.id,state:"backlog",project:job.project,department:childDept?.name??job.department,agent:childAuto?"":assignee?.name??job.agent,priority:job.priority,due:job.due,description:demoMode&&!childBrief.trim()?tr("Опишите ожидаемый результат и критерии приёмки."):composeJobDescription(childBrief.trim(),childAcceptance.trim()),comments:[],bindingId:childBinding||job.bindingId,departmentId:childDepartmentId||job.departmentId,...(childAuto?{assignedAgentId:null,assignment:childAuto}:{assignedAgentId:assignee?.id??job.assignedAgentId}),...(childContract?{contract:childContract}:{})};
  const ok=await Promise.resolve(addJob(created));
  setChildPending(false);
  if(ok===false)return;
  setChildTitle("");setChildBrief("");setChildAcceptance("");setChildAssignee("");setChildDepartment("");setChildFolder("");setChildContract(undefined);
  setChildForm(false);
 };
 useEffect(()=>{if(currentFile)publishDocument({jobId:documentJobId,file:currentFile,draft,onDraft:writeDraft,onSave:(content)=>{void saveFile(content);},close:()=>selectFile(null),select:selectFile,files,persisted:!demoMode,saving:fileSaving,error:fileSaveError});else publishDocument(null);});
 useEffect(()=>()=>publishDocument(null),[]);
 return <article data-document-visible={documentVisible} className="agency-task-layout mx-auto w-full max-w-[1120px] px-1 pb-8 sm:px-4">
  <nav aria-label={tr("Путь задачи")} className="mb-5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"><Button size="sm" variant="ghost" className="h-auto p-0 font-normal text-muted-foreground hover:text-foreground hover:bg-transparent" onClick={back}>{tr("Все задачи")}</Button><span>/</span>{ancestors.map(item=><span key={item.id} className="contents"><Button size="sm" variant="ghost" className="h-auto p-0 font-normal text-muted-foreground hover:text-foreground hover:bg-transparent" aria-label={`${item.id}: ${displayJobTitle(item)}`} onClick={()=>openJob(item.id)}>{item.id}</Button><span>/</span></span>)}<span className="font-mono text-foreground">{job.id}</span></nav>
  <div className="agency-task-grid">
   <header className="agency-task-title">
    <div className="agency-task-heading">
     <h1 className="agency-task-heading-title">{displayJobTitle(job)}</h1>
     <div className="agency-task-heading-actions">
      {demoMode&&<Handoff job={job} agents={agents} files={files} update={update} runtimeAvailable/>}
      <Button size="sm" variant="outline" onClick={openEdit}>{tr("Редактировать")}</Button>
     </div>
    </div>
    <div className="agency-task-heading-meta text-muted-foreground">
     <Status state={job.state}/>
     <span>·</span>
     <span className="font-mono">{job.id}</span>
     {!job.parentId&&children.length>0&&<><span>·</span><span className="font-medium text-foreground">{tr(MAIN_JOB_LABEL)}</span><span>·</span><span>{tr("{closed}/{total} подзадач",{closed:children.filter(isClosedJob).length,total:children.length})}</span></>}
     {job.project&&<><span>·</span><span>{tr("Проект: {project}",{project:job.project})}</span></>}
     {job.department&&<><span>·</span><span>{tr("Отдел: {department}",{department:job.department})}</span></>}
     {intake?<><span>·</span><span title={intake.author?tr("Оценил: {author}",{author:intake.author}):undefined}>{tr("Оценка: {label}",{label:intakeLabel(intake)})}</span></>:!demoMode&&!job.parentId&&job.state==="running"&&<><span>·</span><span>{tr("Оценки на входе нет")}</span></>}
    </div>
   </header>
   <div className="agency-task-content">

   {question&&<TaskQuestionBlock question={question} agent={job.agent} onDraft={draft=>update({...job,question:{...question,draft}})} onAnswer={answerQuestion}/>}
   {!demoMode&&needsInput&&<JobNeedsInputPanel record={needsInput} api={api} notice={notice} onChanged={()=>{void refreshLive();}}/>}
   {!question&&
   <section aria-label={tr("Текущее состояние")} className={`rounded-xl border p-4 ${job.state==="review"?"border-foreground/20 bg-muted/60":"border-border bg-muted/30"}`}>
    <div className="flex items-start gap-3"><span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-background">{job.state==="review"?<Icon name="Eye" className="size-4 text-blue-500"/>:job.state==="running"?<Icon name="Play" className="size-4 text-amber-500"/>:job.state==="done"?<Icon name="CircleCheck" className="size-4 text-emerald-500"/>:job.state==="blocked"||job.state==="waiting_input"?<Icon name="AlertCircle" className="size-4 text-orange-500"/>:<Icon name="Circle" className="size-4 text-muted-foreground"/>}</span><div className="min-w-0 flex-1"><span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{job.state==="review"?tr("Нужно ваше решение"):tr("Текущий этап")}</span><h2 className="mt-0.5 text-sm font-semibold">{job.state==="review"?tr("Проверьте результат работы"):job.state==="done"?tr("Результат принят"):tr(nextState[job.state]??"")}</h2>   <p className="mt-1 text-xs text-muted-foreground">{tr("Исполнитель: {agent}",{agent:job.agent})}</p>
    {stageFile&&<div className="mt-4 flex flex-wrap gap-2"><FileChip file={stageFile} open={selectFile}/></div>}
    {job.state==="review"&&<JobAcceptControls job={job} files={files} api={api} demoMode={Boolean(demoMode)} notice={notice} onAccepted={(text)=>demoMode?change({state:"done"},text):change({},text)} secondary={<Button size="sm" variant="outline" onClick={()=>setReviewing(true)}>{tr("Вернуть с замечанием")}</Button>}/>}{job.state==="backlog"&&<div className="mt-4 flex flex-wrap items-center gap-2"><Button size="sm" onClick={()=>setStatus("queued")}>{tr("Поставить в очередь")}</Button></div>}
    {job.state==="blocked"&&<div className="mt-4 flex flex-wrap items-center gap-2"><Button size="sm" disabled={attemptActive} onClick={()=>setStatus("queued")}>{tr("Вернуть в очередь")}</Button><Button size="sm" variant="outline" disabled={attemptActive} onClick={()=>setStatus("canceled")}>{tr("Отменить задачу")}</Button>{attemptActive&&<p className="w-full text-xs text-muted-foreground">{tr("Тред сотрудника ещё работает: сначала остановите запуск ниже.")}</p>}</div>}
    {!demoMode&&<JobLaunchPanel job={job} api={api} notice={notice} openRun={openRun} onChanged={()=>{void refreshLive();}} onAttemptStatus={onAttemptStatus} onLaunchReady={onLaunchReady} onEnvironment={onEnvironment} needsInput={Boolean(needsInput)}/>}
    </div></div>
   </section>}
   {/* A main job is read through its subtasks first; a subtask shows its siblings; the brief follows. */}
   {children.length>0&&<SubtaskSection title="Подзадачи" subtasks={children} openJob={openJob} onAdd={jobClosed?undefined:()=>setChildForm(true)}/>}
   {parentJob&&siblings.length>0&&<SubtaskSection title="Подзадачи главной задачи" parent={parentJob} subtasks={siblings} currentId={job.id} openJob={openJob}/>}
   {!demoMode&&<JobFlowSection job={job} jobs={jobs} links={flowLinks} nextStep={nextStep} departments={departments} openJob={openJob} onEdit={job.recordId?()=>setFlowOpen(true):undefined}/>}
   <section className="agency-task-section" aria-label={tr("Описание и критерии")}><h2 className="mb-3 text-sm font-medium">{tr("Описание и критерии")}</h2>{(()=>{const names={agents,departments,projects,jobs};const body=<div className="agency-prose text-sm text-foreground"><Markdown content={humanizeIds(brief.brief,names)}/>{brief.acceptance&&<><h3 className="mb-1.5 mt-4 text-[13px] font-semibold">{tr("Критерии приёмки")}</h3><Markdown content={humanizeIds(brief.acceptance,names)}/></>}</div>;return job.state==="backlog"?body:<CollapsibleText lines={14}>{body}</CollapsibleText>;})()}{job.contract&&<JobContractView contract={job.contract}/>}</section>
   {children.length===0&&!job.parentId&&!jobClosed&&<SubtaskSection title="Подзадачи" subtasks={[]} openJob={openJob} onAdd={()=>setChildForm(true)}/>}
   <section className="agency-task-section" aria-label={tr("История задачи")}><div className="mb-3 flex items-center justify-between gap-3"><h2 className="text-sm font-medium">{tr("История и обсуждение")}</h2><div className="w-40"><Choice label="Фильтр истории" value={filter} onChange={setFilter} options={[{value:"all",label:"Всё"},{value:"comment",label:"Комментарии"},{value:"event",label:"События"}]}/></div></div>
    {activity.length?<ol className="ml-4 border-l border-border">{activity.map(item=>{if(item.kind==="event")return <li key={item.id} className="relative py-2 pl-6"><span className="absolute -left-1 top-3 size-2 rounded-full border border-border bg-background"/><p className="text-xs leading-snug text-muted-foreground">{item.author&&<span className="mr-2 font-medium text-foreground">{item.author}</span>}{item.text}<span className="ml-2 opacity-70">{item.at&&new Date(item.at).toLocaleTimeString(uiLocale(),{hour:"2-digit",minute:"2-digit"})}</span></p></li>;const author=item.author;const agent=author?agents.find(a=>a.name.toLowerCase()===author.toLowerCase()||a.id===author||a.name.toLowerCase().includes(author.toLowerCase())||author.toLowerCase().includes(a.name.toLowerCase())):undefined;const providerId=item.providerId||agent?.selection?.providerId||(item.model?.includes("claude")||item.model?.includes("sonnet")||item.model?.includes("opus")||author?.toLowerCase().includes("fable")||author?.toLowerCase().includes("sonnet")||author?.toLowerCase().includes("opus")?"claude-code":item.model?.includes("gpt")||item.model?.includes("codex")?"codex":undefined);const model=item.model||agent?.selection?.model;const reasoning=item.reasoningEffort||agent?.selection?.reasoningLevel;const role=item.role||agent?.role;const roleLabel=activityRoleLabel(author,role);return <li key={item.id} className="relative py-3 pl-6"><span className="absolute -left-3.5 top-3 flex size-7 items-center justify-center rounded-full border border-border bg-background">{author==="Вы"?<Icon name="UserRound" className="size-3.5 text-muted-foreground"/>:providerId?<AgentMark id={providerId} className="size-4"/>:<Icon name={author==="Система"?"Info":"Bot"} className="size-3.5 text-muted-foreground"/>}</span><div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-1"><span className="text-sm font-medium">{author||tr("Вы")}</span>{roleLabel&&<span className="text-xs text-muted-foreground">{roleLabel}</span>}{model&&<span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{model}{reasoning&&reasoning!=="none"?` · reasoning: ${reasoning}`:""}</span>}<span className="text-xs text-muted-foreground">{item.at?<time dateTime={item.at}>{new Date(item.at).toLocaleTimeString(uiLocale(),{hour:"2-digit",minute:"2-digit"})}</time>:tr("Начало примера")}</span></div>{item.text&&<CollapsibleText><div className="agency-prose break-words text-sm"><Markdown content={humanizeIds(item.text.replace(/^Вы: /,""),{agents,departments,projects,jobs})}/></div></CollapsibleText>}<div className="mt-2 flex flex-wrap gap-2">{(item.fileIds||[]).map(id=>files.find(f=>f.id===id)).filter((f):f is TaskFile=>Boolean(f)).map(file=><FileChip key={file.id} file={file} open={selectFile}/>)}</div></li>;})}</ol>:<p className="mb-4 text-xs text-muted-foreground">{tr("Здесь пока нет сообщений.")}</p>}
    <div className="mt-5 rounded-xl border border-border bg-muted/20 p-3"><label htmlFor={`comment-${job.id}`} className="sr-only">{tr("Комментарий к задаче")}</label><textarea id={`comment-${job.id}`} rows={3} value={comment} onChange={e=>setComment(e.target.value)} placeholder={tr("Написать комментарий…")} className="w-full resize-y rounded-md bg-transparent p-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"/><div className="mb-2 flex flex-wrap gap-2">{pendingFiles.map(file=><div key={file.id} className="flex items-center gap-1"><FileChip file={file} open={selectFile}/><Button variant="ghost" size="sm" aria-label={tr("Убрать {name}",{name:file.name})} onClick={()=>setPendingFiles(pendingFiles.filter(f=>f.id!==file.id))}>×</Button></div>)}</div><div className="flex flex-wrap items-center justify-between gap-2">{jobClosed?<span className="text-xs text-muted-foreground">{tr("Задача закрыта: новые файлы не добавляются.")}</span>:<FilePicker label="Добавить файл" onFiles={added=>setPendingFiles([...pendingFiles,...added])} notice={notice}/>}<Button size="sm" disabled={!comment.trim()&&!pendingFiles.length} onClick={submitComment}>{tr("Отправить комментарий")}</Button></div></div><p className="mt-2 text-xs text-muted-foreground">{needsInput?tr(NEEDS_INPUT_COMMENT_HINT):tr("Комментарий пишется в историю задачи. Агент не запускается.")}</p>
   </section>


   </div>
   <aside aria-label={tr("Сведения о задаче")} className="agency-task-sidebar" data-expanded={detailsOpen}>
    <h2 className="agency-task-sidebar-heading sr-only">{tr("Сведения")}</h2>
    <Button variant="ghost" className="agency-task-sidebar-toggle h-auto min-h-9 w-full justify-between rounded-lg border border-border px-3 text-left" aria-expanded={detailsOpen} aria-controls={`task-details-${job.id}`} onClick={()=>setDetailsOpen(!detailsOpen)}><span>{tr("Сведения")}</span><Icon name={detailsOpen?"ChevronUp":"ChevronDown"} className="size-4"/></Button>
    <div id={`task-details-${job.id}`} className="agency-task-sidebar-content">
     <RailCard title="Команда">
      <RailRow label="Руководитель" value={railTeam.lead?<RailPerson person={railTeam.lead} open={openAgent} short/>:tr(TEAM_UNASSIGNED_ONE)} tone={railTeam.lead?"default":"muted"}/>
      <RailRow label="Исполнитель" value={railTeam.assigned?<RailPerson person={railTeam.assigned} open={openAgent} short/>:tr(TEAM_UNASSIGNED_ONE)} tone={railTeam.assigned?"default":"muted"}/>
      <RailRow label={railTeam.reviewers.length>1?"Проверяющие":"Проверяющий"} value={railTeam.reviewers.length?<ul>{railTeam.reviewers.map(person=><li key={person.id}><RailPerson person={person} open={openAgent} short/></li>)}</ul>:tr(TEAM_UNASSIGNED)} tone={railTeam.reviewers.length?"default":"muted"}/>
      {railTeam.watchers.length>0&&<RailRow label="Наблюдатели" value={<ul>{railTeam.watchers.map(person=><li key={person.id}><RailPerson person={person} open={openAgent} short/></li>)}</ul>}/>}
     </RailCard>
     <RailCard title="Параметры">
      <RailRow label="Проект" value={projectName&&liveBinding&&openProject?<Button size="sm" variant="ghost" className="h-auto px-0" onClick={()=>openProject(liveBinding)}>{projectName}</Button>:projectName||tr("не задан")} tone={projectName?"default":"muted"}/>
      <RailRow label="Отдел" value={departmentName&&liveDepartment&&openDepartment?<Button size="sm" variant="ghost" className="h-auto px-0" onClick={()=>openDepartment(liveDepartment)}>{departmentName}</Button>:departmentName||tr("не задан")} tone={departmentName?"default":"muted"}/>
      <RailRow label="Приоритет" value={tr(job.priority)}/>
      {!demoMode&&!job.parentId&&<RailRow label="Цель" value={<JobGoalChoice job={job} notice={notice}/>} info={<p>{tr("Цель, ради которой идёт главная задача. Прогресс целей — в разделе «Цели».")}</p>}/>}
      {job.escalatedToId&&<RailRow label="Эскалация" value={<span className="text-amber-700 dark:text-amber-400">{tr("в отдел «{name}»",{name:departments.find(item=>item.id===job.escalatedToId)?.name??job.escalatedToId})}</span>} info={<p>{tr("Задача ждёт решения дольше срока правила отдела и эскалирована в вышестоящий отдел. Эскалация закрывается, когда задача выходит из «Ожидает решения».")}</p>}/>}
      <RailRow label="Срок" value={job.due?<span className={dueRail&&dueRail.tone!=="set"?DUE_TONE_CLASS[dueRail.tone]:undefined} title={dueRail?.hint}>{dueRail&&dueRail.tone!=="set"?`${job.due} · ${dueRail.label}`:job.due}</span>:tr("не задан")} tone={job.due?"default":"muted"} info={<><p>{tr("Срок задачи. За несколько часов до него (правило отдела «Напомнить о сроке за») задача подсвечивается, в историю пишется напоминание, а работающий сотрудник получает сообщение.")}</p><p>{tr("После срока — ещё одно напоминание и красная пометка.")}</p></>}/>
     </RailCard>
     <RailCard title={tr("Файлы ({count})",{count:files.length})} label="Файлы" action={jobClosed?undefined:<FilePicker onFiles={attach} notice={notice} label="+ Добавить" icon={false}/>}>
      {files.length
       ?<div className="agency-rail-files">{files.map(file=><FileChip key={file.id} file={file} open={selectFile}/>)}</div>
       :<p className="agency-rail-empty">{tr("Прикрепите материалы к задаче или сообщению.")}</p>}
     </RailCard>
     {!demoMode&&<RailCard title="Среда запуска">
      <RailRow label="Машина" value={tr(hostName)} tone={hostName===HOST_UNKNOWN?"muted":"default"} info={<p>{tr("Машина проекта: там запускается сотрудник и лежат файлы результата.")}</p>}/>
      <RailRow label="Изоляция" value={tr(isolation.text)} tone={isolation.tone} info={<><p>{tr("Запуск идёт в отдельном скрытом треде со своими навыками и правами, без доступа к чужим чатам.")}</p><p>{tr("«Подтверждена» — BB подтвердил такой запуск для CLI исполнителя.")}</p></>}/>
      <RailRow label="Попыток" value={attemptsLabel(environment)} mono info={<p>{tr("Сколько раз задачу запускали. Новая попытка появляется после остановки или сбоя прежней.")}</p>}/>
     </RailCard>}
     {demoMode&&<RailCard title="Запуски примера" label="Запуски примера">
      {jobRuns.length?jobRuns.map(run=><div key={run.id} className="flex flex-col items-start gap-2 py-1"><div className="flex items-center gap-2 text-xs"><span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted"><AgentMark id={run.providerId} className="size-4"/></span><span>{run.agent} · {run.title}</span></div><Button size="sm" variant="outline" onClick={()=>openRun(run.id)}>{tr("Открыть запуск")}</Button></div>):<p className="agency-rail-empty">{tr("Запусков в примере нет.")}</p>}
     </RailCard>}
     {!demoMode&&job.recordId&&openUsage&&<RailCard title="Расход токенов" label="Расход">
      <UsageRootSummary api={api} rootJobId={job.recordId} revision={job.revision} openUsage={()=>openUsage(job.recordId!)} variant="rail"/>
     </RailCard>}
     <RailCard title="Иерархия и связи">
      <details className="group text-xs" open={treeOpen} onToggle={e=>setTreeOpen(e.currentTarget.open)}>
       <summary className="flex cursor-pointer list-none items-center justify-between py-0.5 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span>{treeOpen?tr("Свернуть связи"):tr("Показать связи")}</span>
        <Icon name={treeOpen?"ChevronUp":"ChevronDown"} className="size-3.5"/>
       </summary>
       <div id={`task-tree-${job.id}`} className="mt-2 space-y-3">
        <JobTreePanel job={job} jobs={jobs} dependencies={dependencies} openJob={openJob}/>
       </div>
      </details>
     </RailCard>
    </div>
   </aside>
  </div>
  <JobEditDialog open={editing} title={editDraft.title} description={editDraft.description} pending={editPending} onOpenChange={setEditing} onTitle={value=>patchEditDraft({title:value})} onDescription={value=>patchEditDraft({description:value})} onSave={saveEdit} contract={editDraft.contract} onContract={contract=>patchEditDraft({contract})}>
   <div className="grid gap-3 sm:grid-cols-2">
    <Field label="Статус" info={<><p>{tr("Вручную задачу можно поставить в очередь, вернуть из «Ожидает решения» в очередь или отменить.")}</p><p>{tr(WORK_STATE_NOTICE)}</p></>} hint={job.state==="running"?STOP_RUN_FIRST_NOTICE:manualStatusOptions(job.state).length===1?"Этот статус меняет сама работа.":undefined}><Choice label="Статус задачи" value={editDraft.state} onChange={value=>patchEditDraft({state:value as State})} options={manualStatusOptions(job.state).map(value=>({value,label:stateNames[value]}))} disabled={statusLocked||manualStatusOptions(job.state).length===1}/></Field>
    <Field label="Приоритет"><Choice label="Приоритет задачи" value={editDraft.priority} onChange={value=>patchEditDraft({priority:value})} options={["Низкий","Обычный","Высокий","Срочный"]}/></Field>
    <Field label="Исполнитель" hint={assigneeHint??undefined}>{demoMode
     ?<Choice label="Исполнитель задачи" value={editDraft.assignee} onChange={value=>patchEditDraft({assignee:value})} options={agents.map(a=>a.name)}/>
     :<Choice label="Исполнитель задачи" value={editDraft.assignee} onChange={value=>patchEditDraft({assignee:value})} options={assigneeOptions}/>}</Field>
    <TextField label="Срок" type="date" value={editDraft.due} onChange={value=>patchEditDraft({due:value})}/>
   </div>
   {statusLocked&&<p className="text-xs text-muted-foreground">{tr("Пока открыт запрос ввода, статус задачи не меняется отсюда.")}</p>}
   <Field label="Проект и отдел" hint="Пара сохраняется сразу, отдельным подтверждением.">
    <div className="flex flex-wrap items-center justify-between gap-2">
     <span className="text-sm">{`${projectName||tr("проект не задан")} · ${departmentName||tr("отдел не задан")}`}</span>
     {demoMode
      ?<div className="flex flex-wrap gap-2"><Choice label="Проект задачи" value={job.project} onChange={project=>change({project},tr("Проект: {project}",{project}))} options={projects.map(p=>p.name)}/><Choice label="Отдел задачи" value={job.department} onChange={department=>change({department},tr("Отдел: {department}",{department}))} options={departments.map(d=>d.name)}/></div>
      :<Button size="sm" variant="outline" onClick={openPlacement}>{tr("Изменить")}</Button>}
    </div>
   </Field>
   {!demoMode&&job.recordId&&<Field label="Порядок работы" hint="Сохраняется сразу, в отдельном окне."><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm">{flowLinks.waitsFor.length||nextStep?tr("ждёт задач: {count} · следующий шаг: {step}",{count:flowLinks.waitsFor.length,step:nextStep?nextStep.step.title:tr("нет")}):tr("ни от чего не зависит, следующего шага нет")}</span><Button size="sm" variant="outline" onClick={()=>setFlowOpen(true)}>{tr("Изменить")}</Button></div></Field>}
   <div className="agency-edit-team">
    <JobTeamBlock job={job} agents={agents} projects={projects} departments={departments} attempt={attemptStatus} demoMode={demoMode} openAgent={openAgent} onPersistRoles={demoMode?undefined:(next)=>update({...job,...next})}/>
   </div>
  </JobEditDialog>
  {flowOpen&&job.recordId&&<JobFlowDialog open onOpenChange={setFlowOpen} job={job} jobs={jobs} links={flowLinks} nextStep={nextStep} departments={departmentsForBinding(departments,placementLinks,liveBinding)} api={api} notice={notice} onChanged={()=>{void refreshLive();}}/>}
  <Dialog open={placing} onOpenChange={setPlacing}><DialogContent><DialogHeader><DialogTitle>{tr("Проект и отдел")}</DialogTitle><DialogDescription>{tr("Отдел должен быть доступен выбранному проекту: общий отдел доступен везде, ограниченный — только в своих проектах.")}</DialogDescription></DialogHeader><Choice label="Проект задачи" value={draftBinding} onChange={changeDraftBinding} options={projects.filter(item=>!item.archivedAt||item.id===liveBinding).map(item=>({value:item.id,label:item.name}))}/>{draftDepartments.length?<Choice label="Отдел задачи" value={draftDepartment} onChange={setDraftDepartment} options={draftDepartments.map(item=>({value:item.id,label:item.name}))}/>:<p className="text-xs text-muted-foreground">{draftBinding?tr(JOB_CREATE_NO_DEPARTMENTS):tr("Сначала выберите проект.")}</p>}<DialogFooter><Button variant="outline" onClick={()=>setPlacing(false)}>{tr("Отмена")}</Button><Button disabled={!canConfirmPlacement(draftBinding,draftDepartment,placementLinks,departments)} onClick={confirmPlacement}>{tr("Сохранить пару")}</Button></DialogFooter></DialogContent></Dialog>
  <Dialog open={childForm} onOpenChange={open=>{if(!childPending)setChildForm(open);}}><DialogContent><DialogHeader><DialogTitle>{tr("Новая подзадача")}</DialogTitle><DialogDescription>{tr("Подзадача {id}. Работу другого отдела ставят подзадачей в тот отдел. Ключ назначит сервер.",{id:job.id})}</DialogDescription></DialogHeader>
   <div className="max-h-[65dvh] space-y-3 overflow-y-auto pr-1">
    <TextField label="Название подзадачи" value={childTitle} onChange={setChildTitle} maxLength={200} required/>
    {!demoMode&&<>
     {projectFolders.length>1&&<Field label="Папка проекта" info={<><p>{tr("По умолчанию — папка главной задачи. Другая папка проекта нужна, когда работа идёт на другой машине.")}</p><p>{tr("Доступно с плагином Projects & Sections.")}</p></>}><Choice label="Папка подзадачи" value={folderBinding} onChange={value=>{setChildFolder(value);setChildDepartment("");setChildAssignee("");}} options={projectFolders.map(item=>({value:item.recordId??item.id,label:folderLabel(item)}))}/></Field>}
     <Field label="Отдел" required info={<><p>{tr("По умолчанию — отдел главной задачи. Если нужна работа другого отдела, выберите его: подзадачу получит его руководитель.")}</p></>}>{childDepartments.length?<Choice label="Отдел подзадачи" value={childDepartmentId} onChange={value=>{setChildDepartment(value);setChildAssignee("");}} options={childDepartments.map(item=>({value:item.id,label:item.name}))}/>:<p className="text-xs text-muted-foreground">{tr(JOB_CREATE_NO_DEPARTMENTS)}</p>}</Field>
     {childDepartmentId&&<AssigneeField value={childAssigneeId} onChange={setChildAssignee} options={childChoices}/>}
     {childWorkplaceId&&<p className="text-xs text-muted-foreground" data-testid="child-workplace">{tr("Выполнится на рабочем месте сотрудника: {folder}.",{folder:childWorkplace?folderLabel(childWorkplace):childWorkplaceId})}</p>}
     <JobBriefFields brief={childBrief} acceptance={childAcceptance} onBrief={setChildBrief} onAcceptance={setChildAcceptance} templates={demoMode?undefined:childTemplates}/>
     {childForm&&<JobContractFields value={childContract} onChange={setChildContract}/>}
    </>}
   </div>
   {childPending&&<p className="text-xs text-muted-foreground" aria-live="polite">{tr("Сохраняем подзадачу…")}</p>}
   <DialogFooter><Button variant="outline" disabled={childPending} onClick={()=>setChildForm(false)}>{tr("Отмена")}</Button><Button disabled={!canCreateChild} onClick={()=>void createChild()}>{childPending?tr("Сохраняем…"):tr("Создать подзадачу")}</Button></DialogFooter></DialogContent></Dialog>
  <Dialog open={Boolean(pendingPreview)} onOpenChange={open=>{if(!open&&!fileSaving)setPendingPreview(null);}}><DialogContent><DialogHeader><DialogTitle>{tr("В файле есть несохранённые изменения")}</DialogTitle><DialogDescription>{tr("Сохраните правки или отбросьте их перед переходом.")}</DialogDescription></DialogHeader>{fileSaveError&&<p className="text-xs text-muted-foreground">{fileSaveError}</p>}<DialogFooter><Button variant="outline" disabled={fileSaving} onClick={()=>setPendingPreview(null)}>{tr("Продолжить редактирование")}</Button><Button variant="outline" disabled={fileSaving} onClick={discardFile}>{tr("Отбросить правки")}</Button><Button disabled={fileSaving} onClick={()=>{void (async()=>{const next=pendingPreview?.file||null;const ok=await saveFile();if(!canLeaveAfterSave(ok))return;setPendingPreview(null);setPreview(next);if(next)void openDocument(next);})();}}>{fileSaving?tr("Сохраняем…"):tr("Сохранить и перейти")}</Button></DialogFooter></DialogContent></Dialog>
  <Dialog open={reviewing} onOpenChange={setReviewing}><DialogContent><DialogHeader><DialogTitle>{tr("Вернуть результат на доработку")}</DialogTitle><DialogDescription>{tr("Замечания уйдут исполнителю в его тред, задача вернётся в работу. На проверку она придёт снова только с новой версией результата.")}</DialogDescription></DialogHeader><TextField label="Замечания" value={reason} onChange={setReason} multiline/><DialogFooter><Button variant="outline" onClick={()=>setReviewing(false)}>{tr("Отмена")}</Button><Button disabled={!reason.trim()||returning} onClick={()=>void returnForRework()}>{returning?tr("Возвращаем…"):tr("Вернуть на доработку")}</Button></DialogFooter></DialogContent></Dialog>
 </article>;
}

/** The contract in the card: three short lists under the brief. */
function JobContractView({ contract }: { contract: NonNullable<Job["contract"]> }) {
 const blocks=[["Можно менять",contract.mayChange],["Нельзя трогать",contract.mustNotTouch],["Проверки перед сдачей",contract.checks]] as const;
 return <div className="mt-4 rounded-lg border border-border p-3" aria-label={tr("Контракт исполнения")}>
  <div className="mb-2 flex items-center gap-1"><h3 className="text-[13px] font-semibold">{tr("Контракт исполнения")}</h3><InfoHint title="Контракт исполнения">{CONTRACT_HINT}</InfoHint></div>
  <div className="grid gap-3 sm:grid-cols-3">{blocks.filter(([,lines])=>lines.length>0).map(([title,lines])=><div key={title}><p className="mb-1 text-xs text-muted-foreground">{tr(title)}</p><ul className="list-disc space-y-0.5 pl-4 text-sm">{lines.map(line=><li key={line} className="break-words">{line}</li>)}</ul></div>)}</div>
 </div>;
}
