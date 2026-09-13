import { useEffect, useSyncExternalStore } from 'react';
import type { PluginFileOpenerProps } from '@get-bb/plugin-sdk/app';
import { FileWorkspace } from './file-workspace';
import type { TaskFile } from './data';
export const documentSessionId=crypto.randomUUID();
const targets=new Map<string,{jobId:string;fileId:string}>();
export const registerDocumentTarget=(path:string,jobId:string,fileId:string)=>targets.set(path,{jobId,fileId});
type Document={jobId:string;file:TaskFile;draft:string;onDraft:(s:string)=>void;onSave:()=>void;close:()=>void;select:(f:TaskFile)=>void;files:TaskFile[]};
let document:Document|null=null;
let shown:string|null=null;
const listeners=new Set<()=>void>();
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
const emit=()=>listeners.forEach(l=>l());
export const publishDocument=(value:Document|null)=>{document=value;emit();};
export const useDocumentVisible=(jobId:string)=>useSyncExternalStore(subscribe,()=>shown===jobId,()=>false);
export function DocumentPanel({path,Original}:PluginFileOpenerProps){
 const target=targets.get(path);
 const doc=useSyncExternalStore(subscribe,()=>document,()=>null);
 const matches=doc&&target?.jobId===doc.jobId&&target.fileId===doc.file.id;
 useEffect(()=>{
  shown=matches?doc.jobId:null;emit();
  return()=>{shown=null;emit();};
 },[Boolean(matches),doc?.jobId]);
 if(!matches)return <Original/>;
 return <div className="h-full overflow-auto p-3">
   <FileWorkspace key={doc.file.id} file={doc.file} draft={doc.draft} onDraft={doc.onDraft} onSave={doc.onSave} close={doc.close} nativePanel/>
 </div>;
}
