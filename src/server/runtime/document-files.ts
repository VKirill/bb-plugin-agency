import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { documentInput } from '../../shared/document-contract';
export async function materializeDocument(raw:unknown,root:string,signal?:AbortSignal){
  const input=documentInput.parse(raw);
  const id=createHash('sha256').update(input.fileId).digest('hex').slice(0,24);
  const dir=join(root,'document-previews',input.sessionId,input.jobId,id);
  const path=join(dir,input.name);
  let bytes:Buffer;
  if(input.kind==='image'){
   const match=/^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(input.content);
   if(!match)throw new Error('Неподдерживаемое изображение.');
   bytes=Buffer.from(match[1],'base64');
  }else bytes=Buffer.from(input.content,'utf8');
  if(bytes.length>5*1024*1024)throw new Error('Размер документа превышает 5 МБ.');
  await mkdir(dir,{recursive:true,mode:0o700});
  await writeFile(path,bytes,{mode:0o600,signal:signal});
  return {path};
}
