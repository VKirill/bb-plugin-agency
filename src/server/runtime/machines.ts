import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { fail, ok, type DomainResult } from '../../domain';
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
 /** Before a launch: the machine is online and the provider CLI is installed and not switched off. Unknown CLI status does not block. */
 // Readiness is asked often by open task cards: a CLI status probe per card would be slow, so results live a minute.
 const launchChecks=new Map<string,{at:number;result:DomainResult<void>}>();
 const checkLaunch=async(input:{hostId:string;providerId:string}):Promise<DomainResult<void>>=>{
  const cacheKey=`${input.hostId}:${input.providerId}`;
  const cached=launchChecks.get(cacheKey);
  if(cached&&Date.now()-cached.at<60_000)return cached.result;
  const result=await probeLaunch(input);
  launchChecks.set(cacheKey,{at:Date.now(),result});
  return result;
 };
 const probeLaunch=async(input:{hostId:string;providerId:string}):Promise<DomainResult<void>>=>{
  let host;
  try{host=await bb.sdk.hosts.get({hostId:input.hostId});}catch{return fail('host_unavailable',`Машина ${input.hostId} не найдена в BB.`);}
  const name=host.name||host.id;
  if(host.status!=='connected')return fail('host_offline',`Машина «${name}» не в сети: сотрудник не запустится. Включите её или поставьте задачу в проект на другой машине.`);
  const saved=cliPolicySchema.safeParse(await bb.storage.kv.get(key(input.hostId,input.providerId)));
  if(saved.success&&saved.data==='disabled')return fail('provider_disabled',`CLI ${input.providerId} выключен для машины «${name}» в разделе «Машины».`);
  try{
   const cli=(await bb.sdk.hosts.providerCliStatus({hostId:input.hostId,signal:AbortSignal.timeout(12000)}))[input.providerId];
   if(cli&&cli.installed===false)return fail('provider_cli_missing',`На машине «${name}» не установлен CLI ${cli.displayName||input.providerId}.`);
   if(cli?.versionUnsupported)return fail('provider_cli_unsupported',`На машине «${name}» версия CLI ${cli.displayName||input.providerId} не поддерживается BB: обновите её.`);
  }catch{/* status unknown: the run watch reports a thread that never starts */}
  return ok(undefined);
 };
 return {list,inspect,setPolicy,checkLaunch};
}
