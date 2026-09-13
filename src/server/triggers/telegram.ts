import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { telegramCapabilitiesSchema, telegramPreferenceSchema, type TelegramInfo, type TelegramPreference } from '../../shared/telegram-contract';
const pluginId='telegram-projects';
export function telegramAdapter(bb:BbPluginApi) {
 const inspect=async():Promise<TelegramInfo>=>{
  const list=await bb.sdk.plugins.list();const plugin=list.plugins.find(p=>p.id===pluginId);
  if(!plugin)return {installed:false,running:false,compatible:false,version:null,reason:'Telegram Projects не установлен.',capabilities:null};
  if(plugin.status!=='running')return {installed:true,running:false,compatible:false,version:plugin.version,reason:'Telegram Projects выключен или недоступен.',capabilities:null};
  try{const capabilities=await bb.sdk.plugins.callRpc({pluginId,method:'agencyCapabilities',input:null,outputSchema:telegramCapabilitiesSchema});return {installed:true,running:true,compatible:true,version:plugin.version,reason:null,capabilities};}
  catch{return {installed:true,running:true,compatible:false,version:plugin.version,reason:'Эта версия Telegram Projects не предоставляет API Агентства v1.',capabilities:null};}
 };
 const preferences=async()=>telegramPreferenceSchema.parse(await bb.storage.kv.get('telegram-preference')||{enabled:false,projectId:'',notifications:true,questions:true});
 const configure=async(value:TelegramPreference)=>{if(value.enabled){const info=await inspect();if(!info.compatible||!info.capabilities?.destinations.some(d=>d.projectId===value.projectId))throw Error('Выберите существующую тему подключённого Telegram Projects.');await bb.sdk.plugins.callRpc({pluginId,method:'agencyConfigure',input:{enabled:true},outputSchema:z.object({saved:z.literal(true)})});}await bb.storage.kv.set('telegram-preference',value);return {saved:true as const};};
 // Dispatcher will call this with a verified Job and redacted summary, never form values or secrets.
 const enqueue=async(input:{deliveryId:string;projectId:string;jobId:string;title:string;kind:'notification'|'question_link'})=>{const pref=await preferences();if(!pref.enabled||pref.projectId!==input.projectId||!(input.kind==='notification'?pref.notifications:pref.questions))throw Error('Telegram delivery is not enabled for this project.');const info=await inspect();if(!info.compatible||!info.capabilities?.enabled)throw Error('Telegram is unavailable.');return bb.sdk.plugins.callRpc({pluginId,method:'agencyEnqueue',input,outputSchema:z.object({deliveryId:z.string(),state:z.enum(['queued','delivered','unknown']),duplicate:z.boolean()})});};
 return {inspect,preferences,configure,enqueue};
}
