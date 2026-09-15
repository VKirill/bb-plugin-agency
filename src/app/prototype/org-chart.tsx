import { useState } from "react";
import { agentLabel, resolveAgent, resolveDepartment } from "../data/group-refs";
import type { Agent, Group } from "./data";
import { AgentMark, Button, Icon } from "./shared";

interface Props {
 group: Group; kind: "projects" | "departments"; agents: Agent[]; departments: Group[];
 openAgent: (id: string) => void; openDepartment: (id: string) => void;
}

export function OrgChart({group,kind,agents,departments,openAgent,openDepartment}:Props) {
 const [collapsed,setCollapsed]=useState<string[]>([]);
 const isProject=kind==="projects";
 const members=[...new Set(group.members)].filter(name=>isProject||name!==group.lead);
 function person(ref:string,label:string,primary=false) {
  const agent=resolveAgent(agents,ref);
  const shown=agentLabel(agents,ref);
  return <button type="button" disabled={!agent} onClick={()=>agent&&openAgent(agent.id)} className={`w-56 rounded-lg border border-border p-3 text-left transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-ring ${primary?"bg-muted/60":"bg-background"}`} aria-label={`Открыть сотрудника ${shown}`}>
   <span className="mb-2 block text-xs text-muted-foreground">{label}</span>
   <span className="flex items-center gap-2.5">{agent?<AgentMark id={agent.selection.providerId||""}/>:<Icon name="User" className="size-5"/>}<span className="min-w-0"><span className="block break-words text-sm font-semibold">{shown}</span><span className="mt-0.5 block text-xs text-muted-foreground">{agent?.role||"Сотрудник недоступен"}{agent&&!agent.enabled?" · На паузе":""}</span></span></span>
  </button>;
 }
 return <section aria-label="Организационная схема" className="space-y-3">
  <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground"><span className="flex items-center gap-2"><span aria-hidden className="w-6 border-t border-foreground/40"/>Подчинение в отделе</span>{isProject&&<span className="flex items-center gap-2"><span aria-hidden className="w-6 border-t border-dashed border-foreground/40"/>Координация в проекте</span>}</div>
  <div className="overflow-x-auto rounded-xl border border-border bg-muted/20 p-5" tabIndex={0} aria-label="Схема команды, доступна горизонтальная прокрутка">
   <div className="flex min-w-max flex-col items-center py-3">
    {person(group.lead,isProject?"Менеджер проекта":"Руководитель отдела",true)}
    {members.length>0&&<><div aria-hidden className={`h-8 border-l border-foreground/30 ${isProject?"border-dashed":""}`}/><ul aria-label={isProject?"Подключённые отделы":"Подчинённые сотрудники"} className="flex list-none p-0">
     {members.map((name,i)=>{
      const department=isProject?resolveDepartment(departments,name):undefined;
      const hidden=department&&collapsed.includes(department.id);
      const team=department?[...new Set(department.members)].filter(n=>n!==department.lead):[];
      const shown=department?.name||name;
      return <li key={name} className="relative flex w-64 flex-col items-center px-4 pt-8">
       {members.length>1&&<span aria-hidden className={`absolute top-0 border-t border-foreground/30 ${isProject?"border-dashed":""}`} style={{left:i===0?"50%":0,right:i===members.length-1?"50%":0}}/>}
       <span aria-hidden className={`absolute top-0 h-8 border-l border-foreground/30 ${isProject?"border-dashed":""}`}/>
       {!isProject?person(name,"Сотрудник"):<>
        <div className="w-56 rounded-lg border border-border bg-background p-3">
         <button type="button" disabled={!department} onClick={()=>department&&openDepartment(department.id)} className="flex w-full items-center gap-2 text-left text-sm font-semibold focus-visible:outline focus-visible:outline-ring"><Icon name="Layers" className="size-4 shrink-0"/>{shown}</button>
         {department?<Button size="sm" variant="ghost" className="mt-2 h-7 w-full justify-between px-0 text-xs text-muted-foreground" aria-expanded={!hidden} onClick={()=>setCollapsed(hidden?collapsed.filter(id=>id!==department.id):[...collapsed,department.id])}>Команда · {new Set([department.lead,...department.members]).size}<span aria-hidden>{hidden?"+":"−"}</span></Button>:<p className="mt-2 text-xs text-muted-foreground">Отдел недоступен</p>}
        </div>
        {department&&!hidden&&<><div aria-hidden className="h-5 border-l border-foreground/30"/>{person(department.lead,"Руководитель отдела")}{team.length>0&&<ul aria-label={`Сотрудники отдела ${shown}`} className="ml-4 w-52 list-none border-l border-foreground/30 pl-4">{team.map(member=><li key={member} className="relative pt-4 [&>button]:w-full"><span aria-hidden className="absolute -left-4 top-10 w-4 border-t border-foreground/30"/>{person(member,"Сотрудник")}</li>)}</ul>}</>}
       </>}
      </li>;
     })}
    </ul></>}
    {!members.length&&<p className="mt-6 max-w-xs text-center text-sm text-muted-foreground">{isProject?"Отделы ещё не подключены.":"Кроме руководителя, сотрудников пока нет."} Добавьте их в режиме «Состав».</p>}
   </div>
  </div>
  <p className="text-xs text-muted-foreground">Нажмите на имя, чтобы открыть карточку.{isProject?" Команды отделов можно свернуть. Один сотрудник может участвовать в нескольких отделах.":""}</p>
 </section>;
}
