import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../shared/rpc-contract";
import type { WorkerContextPolicy, WorkerContextView } from "../../shared/contracts/worker-context";
import { Checkbox } from "../../../components/ui/checkbox";
import { Button, Choice, Panel, SearchInput, TextField } from "./shared";
import { tr } from "../i18n";

const FILTERS = {skills:"Навыки",bbPlugins:"Плагины BB",mcpServers:"MCP-серверы CLI",nativePlugins:"Плагины CLI"} as const;
const FLAGS = {userInstructions:"Общие инструкции BB",projectInstructions:"Инструкции проекта",claudeAiSync:"Синхронизация claude.ai"} as const;
export function WorkerContextPanel({scope,scopeId,skills=[],notice}:{scope:"agent"|"department";scopeId:string;skills?:readonly {label:string}[];notice:(s:string)=>void}) {
 const rpc = useRpc<typeof rpcContract>();
 const [view,setView]=useState<WorkerContextView|null>(null);
 const [draft,setDraft]=useState<WorkerContextPolicy>({});
 const [pending,setPending]=useState(false);
 const [error,setError]=useState("");
 const [search,setSearch]=useState("");
 useEffect(()=>{let active=true;setView(null);setError("");
  void rpc.call("getWorkerContext",{scope,scopeId}).then(result=>{
   if(!active)return;
   if(result.ok){setView(result.value);setDraft(result.value.policy);}else setError(result.error.message);
  }).catch(()=>{if(active)setError(tr("Не удалось прочитать служебный контекст."));});
  return ()=>{active=false;};
 },[rpc,scope,scopeId]);
 const reload=async()=>{
  if(pending)return;setPending(true);
  try {const result=await rpc.call("getWorkerContext",{scope,scopeId});if(result.ok){setView(result.value);setDraft(result.value.policy);setError("");}else setError(result.error.message);}
  catch {setError(tr("Не удалось прочитать служебный контекст."));} finally {setPending(false);}
 };
 const save=async()=>{
  if(!view||pending)return;setPending(true);setError("");
  try{const result=await rpc.call("saveWorkerContext",{scope,scopeId,requestId:crypto.randomUUID(),expectedRevision:view.revision,policy:Object.fromEntries(Object.entries(draft).map(([k,v])=>[k,typeof v === "object"?{...v,names:v.names.map(n=>n.trim()).filter(Boolean)}:v]))});
   if(!result.ok){setError(result.error.message);return;}
   setView({...view,...result.value});setDraft(result.value.policy);notice(tr("Контекст сохранён для новых сессий сотрудников."));
  }catch{setError(tr("Не удалось сохранить контекст. Черновик сохранён на экране."));}finally{setPending(false);}
 };
 if(error&&!view)return <p role="alert">{error}</p>;
 if(!view)return <p className="text-sm text-muted-foreground">{tr("Проверяем поддержку служебного контекста…")}</p>;
 if(!view.available)return null;
 const change=(key:keyof WorkerContextPolicy,value:unknown)=>setDraft(current=>{const next={...current,[key]:value};if(value===undefined)delete next[key];return next;});
 const dirty=JSON.stringify(draft)!==JSON.stringify(view.policy);
 return <Panel title={scope === "agent" ? "Дополнительные настройки контекста" : "Служебный контекст (VK)"}>
  <fieldset disabled={pending} className="space-y-4" data-testid="worker-context">
   <p className="text-sm text-muted-foreground">{tr("Отдел задаёт основу. Сотрудник переопределяет отдельные поля. По умолчанию используются списки профиля сотрудника. Изменения получает новая сессия; уже работающие сотрудники сохраняют прежний контекст.")}</p>
   <p className="text-sm text-muted-foreground">{tr("Своя политика заменяет правила контекста project-folders для служебного треда. Агентство и его обязательные навыки остаются доступны. Это фильтр загрузки, а не ограничение прав доступа.")}</p>
   {view.inherited?.length>0&&<details className="text-sm"><summary>{tr("Настройки отделов сотрудника")}</summary>{view.inherited.map(d=><div key={d.departmentId} className="mt-2"><strong>{d.name}</strong><ul>{Object.entries({...FILTERS,...FLAGS}).map(([key,label])=>{const value=d.policy[key as keyof WorkerContextPolicy];return <li key={key}>{tr(label)}: {value===undefined?tr("Наследовать"):typeof value==="boolean"?tr(value?"Загружать":"Не загружать"): `${tr(value.mode==="assigned"?"Только назначенное":value.mode==="allow"?"Только перечисленные":"Все, кроме перечисленных")} · ${value.names.join(", ") || "—"}`}</li>;})}</ul></div>)}</details>}
   {scope === "department" && <Button variant="outline" size="sm" disabled={pending} onClick={()=>setDraft({skills:{mode:"assigned",names:[]},bbPlugins:{mode:"assigned",names:[]},mcpServers:{mode:"allow",names:[]},nativePlugins:{mode:"allow",names:[]}})}>{tr("Только назначенное в профиле и задаче")}</Button>}
   {scope === "department" ? <SearchInput aria-label={tr("Поиск в контексте")} placeholder={tr("Найти навык или плагин…")} value={search} onChange={e=>setSearch(e.target.value)}/> : <p className="text-sm text-muted-foreground">{tr("Основные списки находятся на вкладках «Навыки» и «Плагины» и сохраняются кнопкой «Сохранить профиль». Здесь задаются только исключения, MCP, плагины CLI и инструкции.")}</p>}
   {Object.entries(FILTERS).map(([raw,label])=>{
    const key=raw as keyof typeof FILTERS;const rule=draft[key];
    const options=[{value:"inherit",label:"Наследовать"},...(key==="skills"||key==="bbPlugins"?[{value:"assigned",label:"Только назначенное"}]:[]),{value:"allow",label:"Только перечисленные"},{value:"deny",label:"Все, кроме перечисленных"}];
    const mode=!rule?"inherit":rule.mode;
    const choices=key==="skills"?[...new Set(skills.map(s=>s.label))].map(id=>({id,detail:""})):key==="bbPlugins"?view.contributions.map(c=>({id:c.pluginId,detail:`${c.tools.length} ${tr("инструментов")} · ${c.skills.length} ${tr("навыков")}`})):[];
    return <div key={key} className="space-y-2 border-t border-border pt-3">
     <Choice label={label} value={mode} options={options} onChange={value=>change(key,value==="inherit"?undefined:{mode:value,names:rule?.names??[]})}/>
     {rule&&<>
      <TextField label="Имена: по одному в строке; * в конце — префикс" multiline value={rule.names.join("\n")} onChange={text=>change(key,{...rule,names:text.split("\n")})}/>
      {scope === "department" && choices.length>0&&<div className="max-h-48 overflow-auto rounded-md border border-border">{choices.filter(c=>c.id.toLowerCase().includes(search.toLowerCase())).map(c=><label key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm"><Checkbox checked={rule.names.includes(c.id)} disabled={pending} onCheckedChange={checked=>change(key,{...rule,names:checked?[...rule.names.filter(Boolean),c.id]:rule.names.filter(n=>n!==c.id)})}/><span>{c.id} <span className="text-muted-foreground">{c.detail}</span></span></label>)}</div>}
     </>}
    </div>;
   })}
   <p className="text-xs text-muted-foreground">{tr("MCP и плагины CLI задаются именами из конфигурации провайдера. Для навыка плагина разрешите также сам плагин BB. Служебный bb-bridge остаётся подключён.")}</p>
   {Object.entries(FLAGS).map(([raw,label])=>{const key=raw as keyof typeof FLAGS;return <Choice key={key} label={label} value={draft[key]===undefined?"inherit":String(draft[key])} options={[{value:"inherit",label:"Наследовать"},{value:"true",label:"Загружать"},{value:"false",label:"Не загружать"}]} onChange={v=>change(key,v==="inherit"?undefined:v==="true")}/>;})}
   {error&&<div role="alert" className="text-sm text-destructive">{error}<Button variant="outline" size="sm" onClick={()=>void reload()}>{tr("Отбросить черновик и перечитать")}</Button></div>}
   <div className="flex gap-2"><Button size="sm" disabled={!dirty||pending} onClick={()=>void save()}>{pending?tr("Сохраняем…"):tr("Сохранить контекст")}</Button><Button size="sm" variant="outline" disabled={pending} onClick={()=>setDraft({})}>{tr("Наследовать всё")}</Button></div>
  </fieldset>
 </Panel>;
}
