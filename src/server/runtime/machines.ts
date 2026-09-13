import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { cliPolicySchema, type CliPolicy, type MachineInventory } from '../../shared/machine-contract';
export function machineDirectory(bb:BbPluginApi) {
 const key=(hostId:string,providerId:string)=>`cli-policy:${encodeURIComponent(hostId)}:${encodeURIComponent(providerId)}`;
 const list=async()=> (await bb.sdk.hosts.list()).map(h=>({id:h.id,name:h.name,connected:h.status==='connected',phase:h.lifecycle.phase,lastSeenAt:h.lastSeenAt}));
 const inspect=async(hostId:string):Promise<MachineInventory>=>{
  const h=await bb.sdk.hosts.get({hostId});
  const machine={id:h.id,name:h.name,connected:h.status==='connected',phase:h.lifecycle.phase,lastSeenAt:h.lastSeenAt};
  const base={machine,checkedAt:new Date().toISOString()};
  if(!machine.connected)return {...base,error:'Нет связи с машиной. Состояние CLI неизвестно.',providers:[]};
  const [providerResult,cliResult]=await Promise.allSettled([
   bb.sdk.providers.list({hostId,signal:AbortSignal.timeout(12000)}),
   bb.sdk.hosts.providerCliStatus({hostId,signal:AbortSignal.timeout(12000)}),
  ]);
  const providers=providerResult.status==='fulfilled'?providerResult.value:[];
  const cli=cliResult.status==='fulfilled'?cliResult.value:{};
  const ids=[...new Set([...providers.map(p=>p.id),...Object.keys(cli)])];
  return {...base,error:providerResult.status==='rejected'?'Не удалось получить каталог провайдеров.':cliResult.status==='rejected'?'Проверка установки CLI недоступна; показан каталог BB.':null,
   providers:await Promise.all(ids.map(async id=>{const p=providers.find(p=>p.id===id);const c=cli[id];const saved=cliPolicySchema.safeParse(await bb.storage.kv.get(key(hostId,id)));return {id,name:p?.displayName||c?.displayName||id,available:p?.available||false,installed:c?.installed??null,version:c?.currentVersion||null,versionUnsupported:c?.versionUnsupported||false,policy:saved.success?saved.data:'enabled' as const};}))};
 };
 const setPolicy=async(input:{hostId:string;providerId:string;policy:CliPolicy})=>{
  const found=await inspect(input.hostId);
  if(!found.providers.some(p=>p.id===input.providerId))throw new Error('Провайдер не найден на этой машине. Обновите каталог.');
  await bb.storage.kv.set(key(input.hostId,input.providerId),input.policy);
  return {saved:true as const};
 };
 return {list,inspect,setPolicy};
}
