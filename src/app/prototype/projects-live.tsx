import { useConfirm } from "./confirm-dialog";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Switch } from "../../../components/ui/switch";
import type { BoardPolicy } from "../data/job-board";
import type { ProjectRulesFile } from "../data/agency-api";
import type { MutationOutcome } from "../data/envelope";
import { failureNotice } from "../data/persist";
import { agentLabel } from "../data/group-refs";
import type { Agent, Group, Job } from "./data";
import { JobsPage } from "./jobs";
import { Button, Empty, HintHeading, Icon, InfoHint, PageHead, Rows, SearchInput, TabBar, Textarea } from "./shared";
import { PassportPanel } from "./passport";
import { SessionPolicyCard } from "./session-policy-card";
import { WorkProfilesPanel } from "./work-profiles";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../shared/rpc-contract";
import { tr } from "../i18n";
import { providerName } from "../data/role-types";

/**
 * Live project pages. A project in the Agency is one folder of a BB project on
 * one machine; the same BB project may be connected on several machines. Every
 * block states what is stored and where the work actually runs.
 */

export type ProjectActions = {
  archive: (bindingId: string) => Promise<boolean>;
  restore: (bindingId: string) => Promise<boolean>;
  remove: (bindingId: string) => Promise<boolean>;
  linkDepartment: (bindingId: string, departmentId: string) => Promise<boolean>;
  unlinkDepartment: (bindingId: string, departmentId: string) => Promise<boolean>;
  setDepartmentAvailability: (departmentId: string, availability: "all" | "selected") => Promise<boolean>;
  readRules: (bindingId: string) => Promise<MutationOutcome<ProjectRulesFile>>;
  /** Drops the CLI list from the project's policy: any CLI connected in BB may work here. */
  allowAnyCli: (bindingId: string) => Promise<boolean>;
  saveRules: (bindingId: string, text: string, expectedHash: string | null) => Promise<MutationOutcome<{ hash: string; size: number }>>;
};

export function projectRulesTemplate(name: string): string {
  return [
    `# Правила проекта ${name}`,
    "",
    "## О проекте",
    "Что это за проект, для кого и какой результат важен.",
    "",
    "## Стек и структура",
    "Языки, фреймворки, где что лежит.",
    "",
    "## Как проверять",
    "Команды сборки, тестов и запуска. Что считается «работает».",
    "",
    "## Нельзя трогать",
    "Файлы, папки, данные и настройки, которые агенты не меняют без решения владельца.",
    "",
    "## Стиль и договорённости",
    "Язык текстов, оформление кода, именование, коммиты.",
    "",
  ].join("\n");
}

/** Lines of the rules template that mean the file was saved without the project's own content. */
const RULES_TEMPLATE_LINES = [
  "Что это за проект, для кого и какой результат важен.",
  "Языки, фреймворки, где что лежит.",
  "Команды сборки, тестов и запуска. Что считается «работает».",
];

export function rulesLookUntouched(text: string): boolean {
  return RULES_TEMPLATE_LINES.some((line) => text.split(/\r?\n/).some((row) => row.trim() === line));
}

type ReadinessCheck = { key: string; ok: boolean | null; title: string; detail: string; action?: { label: string; run: () => void } };

/** What a launch in this folder needs, checked with live data before anyone presses «Запустить». */
function ProjectReadiness({ project, departments, agents, actions, openRules, openDepartment }: {
 project: Group; departments: Group[]; agents: Agent[]; actions: ProjectActions; openRules: () => void; openDepartment: (id: string) => void;
}) {
 const rpc = useRpc<typeof rpcContract>();
 const [rules, setRules] = useState<{ exists: boolean; untouched: boolean } | null>(null);
 const [online, setOnline] = useState<boolean | null>(null);
 const actionsRef = useRef(actions);
 actionsRef.current = actions;
 useEffect(() => {
  let live = true;
  void actionsRef.current.readRules(project.id).then((result) => {
   if (!live) return;
   setRules(result.ok ? { exists: result.value.exists, untouched: result.value.exists && rulesLookUntouched(result.value.text ?? "") } : null);
  });
  void Promise.resolve(rpc.call("machines", null)).then((rows) => {
   if (!live) return;
   const host = (rows as Array<{ id: string; connected: boolean }>).find((row) => row.id === project.hostId);
   setOnline(host ? host.connected : null);
  }, () => { if (live) setOnline(null); });
  return () => { live = false; };
 }, [project.id, project.hostId, rpc]);
 const available = departments.filter((item) => item.availability !== "selected" || project.members.includes(item.id));
 const launchableLead = available.find((item) => {
  const lead = agents.find((agent) => agent.id === item.lead);
  return lead && lead.enabled;
 });
 const checks: ReadinessCheck[] = [
  {
   key: "rules",
   ok: rules === null ? null : rules.exists && !rules.untouched,
   title: tr("Правила проекта"),
   detail: rules === null ? tr("Проверяем файл .bb/AGENTS.md…") : !rules.exists ? tr("Файла .bb/AGENTS.md нет: запуск сотрудника не начнётся.") : rules.untouched ? tr("Файл есть, но в нём остались строки шаблона: сотрудники получат пустые правила.") : tr("Файл .bb/AGENTS.md на месте."),
   ...(rules && (!rules.exists || rules.untouched) ? { action: { label: rules.exists ? tr("Дописать правила") : tr("Создать правила"), run: openRules } } : {}),
  },
  {
   key: "machine",
   ok: online,
   title: tr("Машина в сети"),
   detail: online === null ? tr("Состояние машины неизвестно.") : online ? tr("{name} подключена к BB.", { name: project.hostName || tr("Машина") }) : tr("{name} не в сети: сотрудник не запустится, пока она не подключится.", { name: project.hostName || tr("Машина") }),
  },
  {
   key: "cli",
   ok: !project.allowedProviders?.length,
   title: tr("CLI сотрудников"),
   detail: project.allowedProviders?.length
    ? tr("Политика проекта разрешает только {providers}: сотрудники на других CLI здесь не запустятся.", { providers: project.allowedProviders.map(providerName).join(", ") })
    : tr("Разрешён любой CLI, подключённый в BB: Claude Code, Codex, Cursor и другие."),
   ...(project.allowedProviders?.length ? { action: { label: tr("Разрешить любой CLI"), run: () => void actionsRef.current.allowAnyCli(project.id) } } : {}),
  },
  {
   key: "department",
   ok: Boolean(launchableLead),
   title: tr("Отдел с запускаемым руководителем"),
   detail: launchableLead ? tr("Задачи можно поручать, например, отделу «{name}».", { name: launchableLead.name }) : available.length ? tr("У доступных отделов нет активного руководителя: задачу некому запустить.") : tr("Проекту не доступен ни один отдел."),
   ...(!launchableLead && available[0] ? { action: { label: tr("Открыть отдел"), run: () => openDepartment(available[0]!.id) } } : {}),
  },
 ];
 return <section aria-label={tr("Готовность к запуску")} className="space-y-2 lg:col-span-2">
  <HintHeading title="Готовность к запуску" hint={<><p>{tr("Что нужно, чтобы сотрудник запустился в этой папке. Проверяется по живым данным при открытии страницы.")}</p><p>{tr("Запуск также требует, чтобы CLI сотрудника был установлен и авторизован на машине: это проверяется перед запуском.")}</p></>}/>
  <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
   {checks.map((check) => <li key={check.key} className="flex items-start gap-3 px-4 py-2.5">
    <Icon name={check.ok === null ? "Circle" : check.ok ? "CircleCheck" : "AlertCircle"} className={`mt-0.5 size-4 shrink-0 ${check.ok === null ? "text-muted-foreground" : check.ok ? "text-emerald-500" : "text-orange-500"}`}/>
    <div className="min-w-0 flex-1"><p className="text-sm font-medium">{check.title}</p><p className="text-xs text-muted-foreground">{check.detail}</p></div>
    {check.action && <Button size="sm" variant="outline" onClick={check.action.run}>{check.action.label}</Button>}
   </li>)}
  </ul>
 </section>;
}

export function folderName(root: string | undefined): string {
  if (!root) return "";
  const parts = root.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

function agentsFilePath(root?: string): string {
  return `${(root || "").replace(/\/+$/, "")}/.bb/AGENTS.md`;
}

/** Long paths stay one line: the start hides, AGENTS.md / folder name stay visible. */
function TruncatedPath({ path, className = "" }: { path: string; className?: string }) {
  return (
    <span className={`block min-w-0 truncate text-left font-mono ${className}`} dir="rtl" title={path}>
      <span dir="ltr">{path}</span>
    </span>
  );
}

function AgentsFileChip({ root, onOpen }: { root?: string; onOpen?: () => void }) {
  const path = agentsFilePath(root);
  const inner = (
    <>
      <Icon name="FileText" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium leading-5">AGENTS.md</span>
        <TruncatedPath path={path} className="text-[11px] text-muted-foreground" />
      </span>
    </>
  );
  const className = "flex w-full min-w-0 items-start gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-left";
  if (onOpen) {
    return (
      <button type="button" className={`${className} hover:bg-muted/70`} onClick={onOpen} title={path} aria-label={tr("Открыть и править")}>
        {inner}
      </button>
    );
  }
  return <div className={className} title={path}>{inner}</div>;
}

export function projectTitle(project: Group): string {
  const base = project.bbProjectName || project.name;
  const folder = folderName(project.root);
  return folder && folder !== base ? `${base} · ${folder}` : base;
}

function machineLabel(project: Group): string {
  return project.hostName || project.hostId || tr("машина не определена");
}

function projectModelHint(): ReactNode {
 return <>
  <p>{tr("Проект в Агентстве — это папка BB-проекта на конкретной машине. Агентство ставит в неё задачи, а сотрудники выполняют их прямо на этой машине.")}</p>
  <p>{tr("Один BB-проект может лежать на нескольких машинах. Подключите нужные папки: у каждой свои задачи и история.")}</p>
  <p>{tr("Отделы общие для всего агентства и принимают задачи из любого подключённого проекта.")}</p>
 </>;
}

export function ProjectsPage({ projects, jobs, open, create }: { projects: Group[]; jobs: Job[]; open: (id: string) => void; create: () => void }) {
 const [q,setQ]=useState("");
 const [showArchived,setShowArchived]=useState(false);
 const match=(project:Group)=>`${projectTitle(project)} ${project.root||""} ${machineLabel(project)}`.toLowerCase().includes(q.toLowerCase());
 const active=projects.filter(project=>!project.archivedAt&&match(project));
 const archived=projects.filter(project=>project.archivedAt&&match(project));
 const groups=useMemo(()=>{
  const byProject=new Map<string,Group[]>();
  for(const project of active){const key=project.bbProjectName||project.bbProjectId||project.name;byProject.set(key,[...(byProject.get(key)||[]),project]);}
  return [...byProject.entries()].sort(([a],[b])=>a.localeCompare(b));
 },[active]);
 const taskCount=(project:Group)=>jobs.filter(job=>job.bindingId===project.id).length;
 const row=(project:Group)=><button key={project.id} onClick={()=>open(project.id)} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-2.5 text-left last:border-b-0 hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
  <span className="min-w-0"><span className="flex items-center gap-2 text-sm"><Icon name="Terminal" className="size-3.5 shrink-0 text-muted-foreground"/><span className="font-medium">{machineLabel(project)}</span><span className="truncate text-muted-foreground">{folderName(project.root)}</span></span><TruncatedPath path={project.root||""} className="mt-0.5 pl-5 text-xs text-muted-foreground"/></span>
  <span className="text-xs tabular-nums text-muted-foreground">{tr("Задачи: {count}", { count: taskCount(project) })}</span>
 </button>;
 return <div className="space-y-4">
  <PageHead title="Проекты" description="Папки BB-проектов, в которых работает Агентство."><div className="flex items-center gap-2"><InfoHint title="Что такое проект в Агентстве">{projectModelHint()}</InfoHint><Button onClick={create}>{tr("Подключить проект")}</Button></div></PageHead>
  <SearchInput aria-label={tr("Поиск проектов")} placeholder={tr("Проект, машина или папка…")} value={q} onChange={e=>setQ(e.target.value)}/>
  {groups.length?<div className="space-y-3">{groups.map(([name,items])=><section key={name} aria-label={name} className="overflow-hidden rounded-lg border border-border">
   <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-2"><span className="flex items-center gap-2 text-sm font-semibold"><Icon name="Folder" className="size-4 text-muted-foreground"/>{name}</span><span className="text-xs text-muted-foreground">{items.length===1?tr("1 папка"):tr("Папок: {count}", { count: items.length })}</span></div>
   {items.map(row)}
  </section>)}</div>:<Empty title="Подключённых проектов нет" description="Подключите папку BB-проекта, чтобы ставить в неё задачи отделам."/>}
  {archived.length>0&&<section aria-label={tr("Отключённые проекты")} className="rounded-lg border border-dashed border-border">
   <button onClick={()=>setShowArchived(!showArchived)} aria-expanded={showArchived} className="flex w-full items-center justify-between px-4 py-2 text-left text-sm text-muted-foreground hover:bg-muted/40"><span>{tr("Отключённые: {count}", { count: archived.length })}</span><Icon name={showArchived?"ChevronUp":"ChevronDown"} className="size-4"/></button>
   {showArchived&&<div className="border-t border-border">{archived.map(project=><div key={project.id} className="opacity-70">{row({...project,bbProjectName:projectTitle(project)})}</div>)}</div>}
  </section>}
 </div>;
}

function ConfirmDialog({ open, title, children, action, pending, onConfirm, onClose, destructive=false }: { open: boolean; title: string; children: ReactNode; action: string; pending: boolean; onConfirm: () => void; onClose: () => void; destructive?: boolean }) {
 return <Dialog open={open} onOpenChange={next=>{if(!pending&&!next)onClose();}}><DialogContent><DialogHeader><DialogTitle>{tr(title)}</DialogTitle><DialogDescription asChild><div className="space-y-2 text-sm text-muted-foreground">{children}</div></DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={pending} onClick={onClose}>{tr("Отмена")}</Button><Button variant={destructive?"destructive":"default"} disabled={pending} onClick={onConfirm}>{pending?tr("Выполняем…"):tr(action)}</Button></DialogFooter></DialogContent></Dialog>;
}

/** `.bb/AGENTS.md` of the project folder: read on its machine, edited here, saved only over the version that was opened. */
function ProjectRulesTab({ project, actions, archived, notice }: { project: Group; actions: ProjectActions; archived: boolean; notice: (text: string) => void }) {
 const [file,setFile]=useState<ProjectRulesFile|null>(null);
 const confirm=useConfirm();
 const [draft,setDraft]=useState("");
 const [loading,setLoading]=useState(true);
 const [saving,setSaving]=useState(false);
 const [error,setError]=useState("");
 const [conflict,setConflict]=useState(false);
 // Workspace polling recreates the actions object; reading must not reset a draft on every refresh.
 const actionsRef=useRef(actions);
 actionsRef.current=actions;
 const load=useCallback(async(keepDraft=false)=>{
  setLoading(true);setError("");
  const result=await actionsRef.current.readRules(project.id);
  setLoading(false);
  if(!result.ok){setError(failureNotice(result.failure));return;}
  setFile(result.value);setConflict(false);
  if(!keepDraft)setDraft(result.value.text??"");
 },[project.id]);
 useEffect(()=>{void load();},[load]);
 const creating=Boolean(file&&!file.exists);
 const dirty=file?(file.exists?draft!==(file.text??""):draft.trim().length>0):false;
 const save=async()=>{
  if(!file)return;
  setSaving(true);setError("");
  const result=await actionsRef.current.saveRules(project.id,draft,file.hash);
  setSaving(false);
  if(!result.ok){
   if(result.failure.kind==="domain"&&result.failure.error.code==="file_changed"){setConflict(true);return;}
   setError(failureNotice(result.failure));return;
  }
  setFile({...file,exists:true,text:draft,hash:result.value.hash,size:result.value.size,managedBlock:draft.includes("<!-- bb-project-folders:agents:start -->")});
  notice(tr("Правила проекта сохранены. Следующие запуски получат новую версию."));
 };
 const path=`${project.root||""}/.bb/AGENTS.md`;
 return <section aria-label={tr("Правила проекта")} className="space-y-3">{confirm.dialog}
  <HintHeading title="Правила проекта" hint={<>
   <p>{tr("Общие требования ко всем задачам проекта: что это за проект, стек, как проверять, что нельзя трогать.")}</p>
   <p>{tr("Текст хранится в файле .bb/AGENTS.md в папке проекта на машине, а не в базе Агентства. Сотрудник читает его при каждом запуске; уже идущие запуски работают по прежней версии.")}</p>
   <p>{tr("Если файл — ссылка на общий AGENTS.md проекта, правка меняет общий файл: его же читают обычные чаты.")}</p>
   <p>{tr("Порядок слоёв: правила проекта → регламент отдела → должностная инструкция → поручение. Нижний слой дополняет верхний и не отменяет его.")}</p>
  </>}>
   <Button size="sm" variant="ghost" disabled={loading||saving} onClick={()=>{void (async()=>{if(dirty&&!(await confirm.ask({title:tr("Загрузить файл заново?"),description:tr("Несохранённые изменения в редакторе пропадут."),confirmLabel:tr("Загрузить заново")})))return;void load();})();}}>{tr("Обновить")}</Button>
  </HintHeading>
  <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
   <Icon name="FileText" className="size-3.5 shrink-0" />
   <span className="shrink-0">{machineLabel(project)}</span>
   <span className="shrink-0">·</span>
   <TruncatedPath path={path} className="flex-1 text-xs" />
   {file?.exists&&file.size!==null?<span className="shrink-0">{tr("{size} байт", { size: file.size })}</span>:null}
  </div>
  {loading&&!file?<p className="text-sm text-muted-foreground">{tr("Читаем файл на машине проекта…")}</p>:null}
  {error&&<p role="alert" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">{error}</p>}
  {creating&&!dirty&&<div className="space-y-2 rounded-lg border border-dashed border-border p-4">
   <p className="text-sm">{tr("Файла правил ещё нет. Без него запуск сотрудников в этом проекте не начнётся.")}</p>
   <div className="flex flex-wrap gap-2"><Button size="sm" disabled={archived} onClick={()=>setDraft(projectRulesTemplate(projectTitle(project)))}>{tr("Создать из шаблона")}</Button><Button size="sm" variant="outline" disabled={archived} onClick={()=>setDraft("# Правила проекта\n\n")}>{tr("Пустой файл")}</Button></div>
  </div>}
  {conflict&&<div role="alert" className="space-y-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
   <p>{tr("Файл изменился на машине после того, как вы его открыли. Ваш текст остался в редакторе — скопируйте нужное, затем загрузите свежую версию.")}</p>
   <Button size="sm" variant="outline" onClick={()=>{void (async()=>{if(await confirm.ask({title:tr("Заменить текст версией с машины?"),description:tr("Текст в редакторе заменится файлом с машины. Скопируйте нужное до замены."),confirmLabel:tr("Заменить")}))void load();})();}}>{tr("Загрузить свежую версию")}</Button>
  </div>}
  {file&&file.managedBlock&&<p className="text-xs text-muted-foreground">{tr("В конце файла есть блок плагина «Папки проектов» между метками bb-project-folders. Его обновляет тот плагин — свои правила пишите выше блока.")}</p>}
  {file&&(file.exists||dirty)&&<>
   <label htmlFor={`rules-${project.id}`} className="sr-only">{tr("Текст правил проекта")}</label>
   <Textarea id={`rules-${project.id}`} value={draft} disabled={archived||saving} onChange={e=>setDraft(e.target.value)} rows={24} spellCheck={false} className="min-h-[24rem] font-mono text-xs leading-relaxed"/>
   <div className="flex flex-wrap items-center gap-2">
    <Button size="sm" disabled={!dirty||saving||archived} onClick={()=>void save()}>{saving?tr("Сохраняем…"):creating?tr("Создать файл"):tr("Сохранить")}</Button>
    <Button size="sm" variant="outline" disabled={!dirty||saving} onClick={()=>setDraft(file.text??"")}>{tr("Отменить изменения")}</Button>
    <span className="text-xs text-muted-foreground" aria-live="polite">{archived?tr("Проект отключён: правила только для чтения."):dirty?tr("Есть несохранённые изменения."):tr("Сохранено.")}</span>
   </div>
  </>}
 </section>;
}

export function ProjectPage({ project, projects, departments, agents, jobs, setJobs, persist, openJob, openProject, openDepartment, back, notice, actions, board }: {
 project: Group; projects: Group[]; departments: Group[]; agents: Agent[]; jobs: Job[]; setJobs: (jobs: Job[]) => void;
 persist?: (job: Job) => void | Promise<boolean>; openJob: (id: string) => void; openProject: (id: string) => void; openDepartment: (id: string) => void;
 back: () => void; notice: (text: string) => void; actions: ProjectActions; board?: BoardPolicy;
}) {
 const [tab,setTab]=useState("Обзор");
 const [confirm,setConfirm]=useState<"archive"|"remove"|null>(null);
 const [pending,setPending]=useState(false);
 const [busyDepartment,setBusyDepartment]=useState("");
 const archived=Boolean(project.archivedAt);
 const projectJobs=jobs.filter(job=>job.bindingId===project.id);
 const machine=machineLabel(project);
 const siblings=projects.filter(item=>item.id!==project.id&&item.bbProjectId&&item.bbProjectId===project.bbProjectId);
 const linked=new Set(project.members);
 const open=departments.filter(item=>item.availability!=="selected");
 const restricted=departments.filter(item=>item.availability==="selected");
 const run=async(change:()=>Promise<boolean>,after?:()=>void)=>{setPending(true);const ok=await change();setPending(false);setConfirm(null);if(ok)after?.();};
 const toggleDepartment=async(department:Group,next:boolean)=>{setBusyDepartment(department.id);await (next?actions.linkDepartment(project.id,department.id):actions.unlinkDepartment(project.id,department.id));setBusyDepartment("");};
 const working=projectJobs.filter(job=>job.state==="running").length;
 const waiting=projectJobs.filter(job=>job.state==="review"||job.state==="blocked"||job.state==="waiting_input").length;
 return <div className="space-y-5">
  <Button variant="ghost" size="sm" onClick={back}>{tr("← Проекты")}</Button>
  <PageHead title={projectTitle(project)} description={`${machine} · ${folderName(project.root)||project.description||""}`}>
   <InfoHint title="Как работа попадает в проект">
    <p>{tr("1. Вы пишете задачу в чате этого BB-проекта или создаёте её здесь.")}</p>
    <p>{tr("2. Агент чата выбирает отдел по разделу «Принимаем» его регламента и ставит задачу руководителю отдела.")}</p>
    <p>{tr("3. Руководитель раскладывает её на подзадачи для сотрудников.")}</p>
    <p>{tr("4. Сотрудники запускаются на машине {machine} в папке проекта и публикуют результат версией.", { machine })}</p>
    <p>{tr("5. Вы принимаете результат в карточке задачи.")}</p>
   </InfoHint>
   {archived
    ?<Button onClick={()=>void run(()=>actions.restore(project.id),()=>notice(tr("Проект снова принимает задачи.")))} disabled={pending}>{tr("Вернуть в работу")}</Button>
    :<Button variant="outline" onClick={()=>setConfirm("archive")}>{tr("Отключить")}</Button>}
   {projectJobs.length===0&&<Button variant="ghost" aria-label={tr("Удалить подключение проекта")} onClick={()=>setConfirm("remove")}><Icon name="Trash2" className="size-4"/></Button>}
  </PageHead>
  {archived&&<p role="status" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">{tr("Проект отключён: новые задачи, отделы и запуски недоступны. История, задачи и файлы сохранены.")}</p>}
  <TabBar value={tab} onChange={setTab} tabs={["Обзор","Правила","Паспорт","Профили работ",`Задачи (${projectJobs.length})`]}/>
  {tab==="Паспорт"&&(project.bbProjectId?<PassportPanel bbProjectId={project.bbProjectId} notice={notice}/>:<p className="text-sm text-muted-foreground">{tr("У подключения нет BB-проекта: паспорт хранится у проекта.")}</p>)}
  {tab==="Профили работ"&&(project.bbProjectId?<WorkProfilesPanel bbProjectId={project.bbProjectId} notice={notice}/>:<p className="text-sm text-muted-foreground">{tr("У подключения нет BB-проекта: профили работ хранятся у проекта.")}</p>)}
  {tab==="Обзор"&&<div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
   {!archived&&<ProjectReadiness project={project} departments={departments} agents={agents} actions={actions} openRules={()=>setTab("Правила")} openDepartment={openDepartment}/>}
   <section aria-label={tr("Где выполняется работа")} className="space-y-2">
    <HintHeading title="Где выполняется работа" hint={<>
     <p>{tr("Сервер BB только ставит задачи и хранит историю. Агент-сотрудник запускается на машине проекта и работает с файлами этой папки.")}</p>
     <p>{tr("Для запуска на машине нужны: хост, подключённый к BB, установленный и авторизованный Claude Code и файл .bb/AGENTS.md в папке.")}</p>
     <p>{tr("Нужна работа в копии проекта на другой машине — подключите ту папку отдельным проектом.")}</p>
    </>}/>
    <Rows rows={[["BB-проект",project.bbProjectName||project.bbProjectId||"—"],["Машина",machine],["Папка",<TruncatedPath path={project.root||"—"} className="max-w-[min(100%,28rem)] text-xs"/>],["Окружение BB",project.environmentName||"—"]]}/>
    {siblings.length>0&&<div className="pt-1"><p className="text-xs text-muted-foreground">{tr("Этот BB-проект подключён ещё здесь:")}</p><div className="mt-1 flex flex-wrap gap-2">{siblings.map(item=><Button key={item.id} size="sm" variant="outline" onClick={()=>openProject(item.id)}>{`${machineLabel(item)} · ${folderName(item.root)}${item.archivedAt?tr(" (отключён)"):""}`}</Button>)}</div></div>}
   </section>
   {!archived && <SessionPolicyCard bbProjectId={project.bbProjectId} bindingId={project.id} archived={archived} notice={notice} />}
   <section aria-label={tr("Правила проекта")} className="space-y-2">
    <HintHeading title="Правила проекта" hint={<>
     <p>{tr("Общие требования ко всем задачам проекта: стек, стиль, что нельзя трогать.")}</p>
     <p>{tr("Хранятся в файле .bb/AGENTS.md в папке проекта, а не в Агентстве. Правьте файл — изменения попадут в следующий запуск.")}</p>
     <p>{tr("Порядок слоёв: правила проекта → регламент отдела → должностная инструкция → поручение. Нижний слой дополняет верхний и не отменяет его.")}</p>
    </>}/>
    <p className="text-sm">{tr("Сотрудник читает при запуске:")}</p>
    <AgentsFileChip root={project.root} onOpen={()=>setTab("Правила")} />
    <Button size="sm" variant="outline" onClick={()=>setTab("Правила")}>{tr("Открыть и править")}</Button>
   </section>
   <section aria-label={tr("Отделы проекта")} className="space-y-2 lg:col-span-2">
    <HintHeading title="Отделы" hint={<>
     <p>{tr("Общий отдел принимает задачи из всех подключённых проектов, подключать его не нужно.")}</p>
     <p>{tr("Ограниченный отдел работает только в проектах, куда подключён. Режим задаётся в карточке отдела, в блоке «Доступ к проектам».")}</p>
     <p>{tr("Отключить ограниченный отдел нельзя, пока у него есть открытые задачи в этом проекте.")}</p>
    </>}/>
    {departments.length===0?<p className="text-sm text-muted-foreground">{tr("Отделов пока нет. Создайте отдел в разделе «Отделы».")}</p>:<div className="overflow-hidden rounded-lg border border-border">
     {[...open,...restricted].map(department=>{const isOpen=department.availability!=="selected";const on=isOpen||linked.has(department.id);return <div key={department.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
      <button onClick={()=>openDepartment(department.id)} className="min-w-0 text-left hover:underline focus-visible:outline focus-visible:outline-ring"><span className="block truncate text-sm font-medium">{department.name}</span><span className="block truncate text-xs text-muted-foreground">{tr("Руководитель: {lead} · {mode}", { lead: agentLabel(agents,department.lead), mode: isOpen?tr("общий отдел"):tr("только выбранные проекты") })}</span></button>
      {isOpen?<span className="text-xs text-muted-foreground">{tr("Доступен")}</span>:<label className="flex items-center gap-2 text-xs text-muted-foreground"><span>{on?tr("Подключён"):tr("Не подключён")}</span><Switch checked={on} disabled={archived||busyDepartment===department.id} aria-label={tr("{name}: доступ к проекту", { name: department.name })} onCheckedChange={next=>void toggleDepartment(department,next)}/></label>}
     </div>;})}
    </div>}
   </section>
   <section aria-label={tr("Работа проекта")} className="space-y-2 lg:col-span-2">
    <HintHeading title="Работа" hint={<p>{tr("Счётчики по задачам этой папки. Готовые задачи уходят с доски по настройкам плагина, но остаются в истории.")}</p>}/>
    <div className="flex flex-wrap items-center gap-4 text-sm"><span>{tr("В работе: {count}", { count: working })}</span><span>{tr("Ждут решения или проверки: {count}", { count: waiting })}</span><span>{tr("Всего задач: {count}", { count: projectJobs.length })}</span><Button size="sm" variant="outline" onClick={()=>setTab(`Задачи (${projectJobs.length})`)}>{tr("Открыть задачи")}</Button></div>
   </section>
  </div>}
  {tab==="Правила"&&<ProjectRulesTab project={project} actions={actions} archived={archived} notice={notice}/>}
  {tab.startsWith("Задачи")&&<JobsPage jobs={jobs} setJobs={setJobs} open={openJob} notice={notice} project={project.id} persist={persist} requirePlacement board={board} placements={{projects:archived?[]:[{id:project.id,name:projectTitle(project)}],departments,projectDepartments:project.members.map(departmentId=>({bindingId:project.id,departmentId})),agents}}/>}
  <ConfirmDialog open={confirm==="archive"} title="Отключить проект?" action="Отключить" pending={pending} onClose={()=>setConfirm(null)} onConfirm={()=>void run(()=>actions.archive(project.id),()=>notice(tr("Проект отключён. Историю можно открыть в разделе «Отключённые».")))}>
   <p>{tr("Проект перестанет принимать новые задачи, отделы и запуски. Уже идущие запуски не останавливаются.")}</p>
   <p>{tr("Задачи, история и файлы сохранятся. Вернуть проект можно в любой момент.")}</p>
  </ConfirmDialog>
  <ConfirmDialog destructive open={confirm==="remove"} title="Удалить подключение проекта?" action="Удалить" pending={pending} onClose={()=>setConfirm(null)} onConfirm={()=>void run(()=>actions.remove(project.id),()=>{notice(tr("Подключение проекта удалено."));back();})}>
   <p>{tr("Удалится только подключение папки к Агентству. BB-проект, папка и файлы на машине не трогаются.")}</p>
   <p>{tr("Удаление доступно, пока в проекте нет задач. Проект с задачами можно только отключить.")}</p>
  </ConfirmDialog>
 </div>;
}

export function DepartmentAccess({ department, projects, actions, live }: { department: Group; projects: Group[]; actions?: ProjectActions; live: boolean }) {
 const [busy,setBusy]=useState("");
 const [confirmSelected,setConfirmSelected]=useState(false);
 const selected=department.availability==="selected";
 const active=projects.filter(project=>!project.archivedAt);
 const linkedTo=(project:Group)=>project.members.includes(department.id);
 const change=async(key:string,task:()=>Promise<boolean>)=>{setBusy(key);await task();setBusy("");};
 return <section aria-label={tr("Доступ к проектам")} className="space-y-3 rounded-lg border border-border p-4">
  <HintHeading title="Доступ к проектам" hint={<>
   <p>{tr("Все проекты — отдел принимает задачи из любого подключённого проекта. Это режим по умолчанию.")}</p>
   <p>{tr("Только выбранные — задачи принимаются лишь из отмеченных проектов, а в чатах других проектов агенты этот отдел не предлагают.")}</p>
   <p>{tr("Ограничить доступ нельзя, пока у отдела есть открытые задачи в проектах, которые не отмечены.")}</p>
  </>}/>
  <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={tr("Доступ отдела к проектам")}>
   <Button size="sm" role="radio" aria-checked={!selected} variant={!selected?"default":"outline"} disabled={!live||!actions||busy!==""} onClick={()=>actions&&selected&&void change("mode",()=>actions.setDepartmentAvailability(department.id,"all"))}>{tr("Все проекты")}</Button>
   <Button size="sm" role="radio" aria-checked={selected} variant={selected?"default":"outline"} disabled={!live||!actions||busy!==""} onClick={()=>{if(!actions||selected)return;if(!active.some(linkedTo)){setConfirmSelected(true);return;}void change("mode",()=>actions.setDepartmentAvailability(department.id,"selected"));}}>{tr("Только выбранные")}</Button>
  </div>
  <ConfirmDialog open={confirmSelected} title="Ограничить отдел выбранными проектами?" action="Ограничить" pending={busy!==""} onClose={()=>setConfirmSelected(false)} onConfirm={()=>{setConfirmSelected(false);if(actions)void change("mode",()=>actions.setDepartmentAvailability(department.id,"selected"));}}>
   <p>{tr("Отдел пока не подключён ни к одному проекту. После ограничения он пропадёт из всех проектов и чатов, пока вы не отметите проекты ниже.")}</p>
  </ConfirmDialog>
  {selected&&(active.length?<div className="overflow-hidden rounded-md border border-border">{active.map(project=><label key={project.id} className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0"><span className="min-w-0"><span className="block truncate">{projectTitle(project)}</span><span className="block truncate text-xs text-muted-foreground">{`${machineLabel(project)} · ${project.root||""}`}</span></span><Switch checked={linkedTo(project)} disabled={!actions||busy!==""} aria-label={tr("{name}: доступ отдела", { name: projectTitle(project) })} onCheckedChange={next=>actions&&void change(project.id,()=>next?actions.linkDepartment(project.id,department.id):actions.unlinkDepartment(project.id,department.id))}/></label>)}</div>:<p className="text-xs text-muted-foreground">{tr("Подключённых проектов нет.")}</p>)}
 </section>;
}
