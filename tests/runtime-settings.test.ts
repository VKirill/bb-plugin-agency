import {describe,it,expect,vi} from 'vitest';
import {machineDirectory} from '../src/server/runtime/machines';
import {telegramAdapter} from '../src/server/triggers/telegram';
import {validateAnswers,designQuestion} from '../src/app/prototype/question-contract';
function host(connected=true){const values=new Map();return {sdk:{hosts:{list:vi.fn(),get:vi.fn(async()=>({id:'h',name:'Mini',status:connected?'connected':'disconnected',lifecycle:{phase:'active'},lastSeenAt:null})),providerCliStatus:vi.fn(async()=>({codex:{installed:true,currentVersion:'1.2'}}))},providers:{list:vi.fn(async()=>[{id:'codex',displayName:'Codex',available:true}])},plugins:{list:vi.fn(async()=>({plugins:[]})),callRpc:vi.fn()}},storage:{kv:{get:vi.fn(async(k:string)=>values.get(k)),set:vi.fn(async(k:string,v:unknown)=>{values.set(k,v);})}}};}
describe('machine inventory',()=>{
 it('does not probe disconnected machines',async()=>{const bb=host(false);expect((await machineDirectory(bb as any).inspect('h')).providers).toEqual([]);expect(bb.sdk.providers.list).not.toHaveBeenCalled();});
 it('keeps persisted per-provider policy and rejects unknown providers',async()=>{const bb=host();const d=machineDirectory(bb as any);await d.setPolicy({hostId:'h',providerId:'codex',policy:'reserve'});expect((await d.inspect('h')).providers[0].policy).toBe('reserve');await expect(d.setPolicy({hostId:'h',providerId:'invented',policy:'enabled'})).rejects.toThrow();});
 it('distinguishes an unavailable CLI probe from not installed',async()=>{const bb=host();bb.sdk.hosts.providerCliStatus.mockRejectedValueOnce(Error('offline'));const r=await machineDirectory(bb as any).inspect('h');expect(r.providers[0].installed).toBeNull();expect(r.error).toContain('недоступна');});
});
describe('optional Telegram',()=>{
 it('works without the plugin and denies delivery',async()=>{const a=telegramAdapter(host() as any);expect((await a.inspect()).installed).toBe(false);await expect(a.enqueue({deliveryId:'x',projectId:'p',jobId:'AG-1',title:'Title',kind:'notification'})).rejects.toThrow();});
 it('does not accept an unbound destination',async()=>{const bb=host();await expect(telegramAdapter(bb as any).configure({enabled:true,projectId:'p',notifications:true,questions:true})).rejects.toThrow();expect(bb.sdk.plugins.callRpc).not.toHaveBeenCalled();});
});
describe('structured answers',()=>{
 const answers={style:{selected:['minimal']},formats:{selected:['square','wide']},constraints:{selected:[],freeText:'Светлый фон'}};
 it('accepts separate single, multiple and text answers',()=>expect(validateAnswers(designQuestion.questions,answers)).toBeNull());
 it('rejects missing answers and injected option/question ids',()=>{expect(validateAnswers(designQuestion.questions,{})).not.toBeNull();expect(validateAnswers(designQuestion.questions,{...answers,style:{selected:['foreign']}})).not.toBeNull();expect(validateAnswers(designQuestion.questions,{...answers,injected:{selected:[]}})).not.toBeNull();});
 it('rejects multiple answers for a single-choice field',()=>expect(validateAnswers(designQuestion.questions,{...answers,style:{selected:['minimal','bright']}})).not.toBeNull());
});
