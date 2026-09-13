import { describe,it,expect } from 'vitest';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,relative } from 'node:path';
import { materializeDocument } from '../src/server/runtime/document-files';
const input={sessionId:'1a9d18d9-6b40-4dc1-843c-2155b6380971',jobId:'AG-102',fileId:'../untrusted-id',name:'Пример.md',kind:'text',content:'# Документ'};
describe('owned document previews',()=>{
 it('writes UTF-8 below the plugin root, hashing untrusted file IDs',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agency-document-test-'));
  try{const {path}=await materializeDocument(input,root);expect(relative(root,path)).not.toMatch(/^\.\./);expect(await readFile(path,'utf8')).toBe(input.content);
   const second=await materializeDocument({...input,content:'# Версия 2'},root);expect(second.path).toBe(path);expect(await readFile(path,'utf8')).toBe('# Версия 2');
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it.each(['../outside.md','/tmp/out.md','..','folder\\file.md'])('rejects unsafe names %s',async name=>{
  await expect(materializeDocument({...input,name},tmpdir())).rejects.toThrow();
 });
 it('rejects oversized UTF-8 content and unsupported image data',async()=>{
  await expect(materializeDocument({...input,content:'Я'.repeat(3*1024*1024)},tmpdir())).rejects.toThrow('5 МБ');
  await expect(materializeDocument({...input,kind:'image',content:'data:text/html;base64,WA=='},tmpdir())).rejects.toThrow('изображение');
 });
});
