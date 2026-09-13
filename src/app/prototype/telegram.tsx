import { useCallback, useEffect, useState } from 'react';
import { useRpc, useBbNavigate } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from '../../shared/rpc-contract';
import type { TelegramInfo, TelegramPreference } from '../../shared/telegram-contract';
import { Button, Choice, Field, Icon } from './shared';
import { Switch } from '../../../components/ui/switch';
export function TelegramSettings() {
 const rpc=useRpc<typeof rpcContract>();const nav=useBbNavigate();
 const [info,setInfo]=useState<TelegramInfo|null>(null);const [pref,setPref]=useState<TelegramPreference>({enabled:false,projectId:'',notifications:true,questions:true});const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');
 const refresh=useCallback(async()=>{setBusy(true);try{const [i,p]=await Promise.all([rpc.call('telegramInfo'),rpc.call('telegramPreferences')]);setInfo(i);setPref(p);}catch{setMessage('Не удалось проверить подключение.');}finally{setBusy(false);}},[rpc]);
 useEffect(()=>{void refresh();},[refresh]);
 const save=async()=>{setBusy(true);try{await rpc.call('configureTelegram',pref);setMessage('Настройки связи сохранены. Сообщения не отправлялись.');setInfo(await rpc.call('telegramInfo'));}catch{setMessage('Не удалось сохранить. Проверьте плагин и выбранную тему.');}finally{setBusy(false);}};
 return <section className="space-y-4"><div className="flex items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-sm font-semibold"><Icon name="MessageCircle" className="size-4"/>Telegram Projects</h2><Button size="sm" variant="outline" disabled={busy} onClick={()=>void refresh()}>Проверить подключение</Button></div>
 <p className="text-sm">{info?(info.compatible?`Плагин подключён · ${info.version}`:info.reason):'Проверяем наличие плагина…'}</p>
 {info?.compatible&&<><div className="flex items-center justify-between gap-3"><span className="text-sm">Использовать Telegram для Агентства</span><Switch aria-label="Использовать Telegram для Агентства" checked={pref.enabled} onCheckedChange={enabled=>setPref({...pref,enabled})}/></div><Field label="Тема проекта"><Choice label="Тема Telegram" value={pref.projectId} onChange={projectId=>setPref({...pref,projectId})} options={info.capabilities?.destinations.map(d=>({value:d.projectId,label:d.name}))||[]}/></Field>{!info.capabilities?.destinations.length&&<p className="text-xs text-muted-foreground">Сначала привяжите тему проекта в Telegram Projects.</p>}
 <div className="flex items-center justify-between gap-3"><span className="text-sm">Уведомления о задачах</span><Switch aria-label="Уведомления Telegram" checked={pref.notifications} onCheckedChange={notifications=>setPref({...pref,notifications})}/></div><div className="flex items-center justify-between gap-3"><span className="text-sm">Вопросы со ссылкой на форму в BB</span><Switch aria-label="Вопросы Telegram" checked={pref.questions} onCheckedChange={questions=>setPref({...pref,questions})}/></div>
 <p className="text-xs text-muted-foreground">Простой вопрос можно обработать существующим мостом подключённого чата. Сложные формы и API-ключи заполняются только в BB.</p><Button size="sm" disabled={busy||(pref.enabled&&!pref.projectId)} onClick={()=>void save()}>Сохранить связь</Button></>}
 {info?.installed&&<Button size="sm" variant="ghost" onClick={()=>nav.openUrl('/plugins/telegram-projects/telegram-projects')}>Открыть Telegram Projects →</Button>}
 <p className="text-xs text-muted-foreground">Адаптер не создаёт бота и не читает его токен. Автоматическая отправка из задач будет подключена вместе с диспетчером Агентства.</p>
 {message&&<p role="status" className="text-sm">{message}</p>}
 </section>;
}
export function TelegramActionChoice({value,onChange}:{value:string;onChange:(value:string)=>void}) {
 const rpc=useRpc<typeof rpcContract>();const [info,setInfo]=useState<TelegramInfo|null>(null);
 useEffect(()=>{let live=true;rpc.call('telegramInfo').then(i=>{if(live)setInfo(i);},()=>{});return()=>{live=false;};},[rpc]);
 const options=[{value:'agent',label:'Передать поручение сотруднику'},...(info?.compatible?[{value:'telegram.notify',label:'Telegram: отправить уведомление'},{value:'telegram.question_link',label:'Telegram: отправить ссылку на вопрос'}]:[])];
 if(!options.some(o=>o.value===value))options.push({value,label:`${value} · подключение недоступно`});
 return <div className="space-y-2"><Field label="Что сделать"><Choice label="Действие автоматизации" value={value} onChange={onChange} options={options}/></Field>{value.startsWith('telegram.')&&<p className="text-xs text-muted-foreground">Используется тема из Настройки → Подключения. В макете отправка не выполняется.</p>}</div>;
}
