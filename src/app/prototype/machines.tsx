import { SkillPinsPanel } from "./skill-pins";
import { useCallback, useEffect, useState } from 'react';
import { useRpc, useBbNavigate } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from '../../shared/rpc-contract';
import type { CliPolicy, MachineInventory } from '../../shared/machine-contract';
import { Button, Icon, AgentMark, Choice, Empty } from './shared';
import { Switch } from '../../../components/ui/switch';
import { tr, uiLocale } from '../i18n';

type Machine=MachineInventory['machine'];
export function MachinesPage() {
 const rpc=useRpc<typeof rpcContract>();const navigate=useBbNavigate();
 const [machines,setMachines]=useState<Machine[]>([]);const [inventory,setInventory]=useState<Record<string,MachineInventory>>({});
 const [loading,setLoading]=useState(false);const [error,setError]=useState('');const [busy,setBusy]=useState('');
 const refresh=useCallback(async()=>{setLoading(true);setError('');try{const hosts=await rpc.call('machines');setMachines(hosts);const results=await Promise.allSettled(hosts.map(async h=>[h.id,await rpc.call('machineInventory',{hostId:h.id})] as const));const next:Record<string,MachineInventory>={};results.forEach((r,i)=>{if(r.status==='fulfilled')next[r.value[0]]=r.value[1];else next[hosts[i].id]={machine:hosts[i],providers:[],checkedAt:new Date().toISOString(),error:tr('Проверка не завершена. Повторите попытку.')};});setInventory(next);}catch{setError(tr('Не удалось получить машины из BB.'));}finally{setLoading(false);}},[rpc]);
 useEffect(()=>{void refresh();},[refresh]);
 const setPolicy=async(hostId:string,providerId:string,policy:CliPolicy)=>{setBusy(`${hostId}/${providerId}`);setError('');try{await rpc.call('setCliPolicy',{hostId,providerId,policy});setInventory(prev=>({...prev,[hostId]:{...prev[hostId],providers:prev[hostId].providers.map(p=>p.id===providerId?{...p,policy}:p)}}));}catch{setError(tr('Не удалось сохранить настройку CLI. Обновите состояние машины.'));}finally{setBusy('');}};
 return <div className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">{tr('Машины и CLI')}</h2><Button size="sm" variant="outline" disabled={loading} onClick={()=>void refresh()}><Icon name="RefreshCw" className={`mr-2 size-3.5 ${loading?'animate-spin':''}`}/>{loading?tr('Проверка…'):tr('Обновить состояние')}</Button></div>
 {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
 {!loading&&!machines.length&&!error&&<Empty title="Нет подключённых машин" description="Добавьте машину в настройках BB."/>}
 {machines.map(h=>{const result=inventory[h.id];return <section key={h.id} className="overflow-hidden rounded-lg border border-border"><header className="flex flex-wrap items-center justify-between gap-2 bg-muted/30 px-4 py-3"><div className="flex items-center gap-2"><Icon name="Server" className="size-4 text-muted-foreground"/><h3 className="text-sm font-medium">{h.name}</h3></div><span className="inline-flex items-center gap-2 text-xs"><span className={`size-2 rounded-full ${h.connected?'bg-emerald-500':'bg-muted-foreground'}`}/>{h.connected?tr('На связи'):tr('Нет связи')}</span></header>
 <div className="px-4 py-2 text-xs text-muted-foreground">{h.lastSeenAt?tr('Последняя связь: {time}', { time: new Date(h.lastSeenAt).toLocaleString(uiLocale()) }):tr('Время последней связи неизвестно')}{h.phase!=='active'&&` · ${h.phase}`}</div>
 {result?.error&&<p className="px-4 py-2 text-xs text-muted-foreground">{result.error}</p>}
 {!result&&<p className="px-4 py-3 text-xs text-muted-foreground">{tr('Проверяем установленные CLI…')}</p>}
 {result?.providers.map(p=><div key={p.id} className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3"><AgentMark id={p.id} className="size-5"/><div className="min-w-32 flex-1"><span className="text-sm font-medium">{p.name}</span><span className="ml-2 text-xs text-muted-foreground">{p.version||''}</span><p className="mt-1 text-xs text-muted-foreground">{p.installed===false?tr('Не установлен'):p.versionUnsupported?tr('Нужна поддерживаемая версия'):p.available?tr('Доступен в BB'):p.installed?tr('Установлен · провайдер недоступен'):tr('Установка не подтверждена')}</p></div><div className="w-32"><Choice disabled={Boolean(busy)||p.policy==='disabled'} label={tr('Роль {provider} на {host}', { provider: p.name, host: h.name })} value={p.policy==='reserve'?'reserve':'enabled'} onChange={v=>void setPolicy(h.id,p.id,v as CliPolicy)} options={[{value:'enabled',label:'Основной'},{value:'reserve',label:'Резерв'}]}/></div><Switch aria-label={tr('Разрешить {provider} на {host}', { provider: p.name, host: h.name })} checked={p.policy!=='disabled'} disabled={Boolean(busy)} onCheckedChange={checked=>void setPolicy(h.id,p.id,checked?'enabled':'disabled')}/></div>)}
 {result&&<p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">{tr('Проверено: {time}. Авторизация и квоты отдельно не проверялись.', { time: new Date(result.checkedAt).toLocaleTimeString(uiLocale()) })}</p>}
 </section>;})}
 <SkillPinsPanel/>
 <p className="text-xs text-muted-foreground">{tr('Разрешения и роль CLI сохраняются на сервере для Агентства. Они не выключают провайдер в других чатах. Автоматическое переключение на резерв появится вместе с исполнением задач.')}</p>
 <Button size="sm" variant="outline" onClick={()=>navigate.openUrl('/settings')}>{tr('Настройки BB: установка и авторизация CLI')}</Button>
 <p className="text-xs text-muted-foreground">{tr('Qwen, Kimi и другие CLI появятся после подключения совместимого провайдера в BB на выбранной машине.')}</p>
 </div>;
}
