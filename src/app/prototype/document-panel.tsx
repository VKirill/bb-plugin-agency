import { useEffect, useSyncExternalStore } from 'react';
import { experimental_useFixedTabTarget } from '@get-bb/plugin-sdk/app';
import type { JsonValue, PluginNavPanelProps } from '@get-bb/plugin-sdk';
import { FileWorkspace } from './file-workspace';
import type { TaskFile } from './data';

type Target={jobId:string;fileId:string};
export const documentTab={panelId:'agency',id:'document',title:'Документ',icon:'FileText',layout:'flush' as const,component:DocumentPanel,experimental_target:{validate(value:JsonValue):value is Target{return Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&typeof value.jobId==='string'&&typeof value.fileId==='string');}}};
type Document={jobId:string;file:TaskFile;draft:string;onDraft:(s:string)=>void;onSave:()=>void;close:()=>void;select:(f:TaskFile)=>void;files:TaskFile[]};
let document:Document|null=null;
let shown:string|null=null;
const listeners=new Set<()=>void>();
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
const emit=()=>listeners.forEach(l=>l());
export const publishDocument=(value:Document|null)=>{document=value;emit();};
export const useDocumentVisible=(jobId:string)=>useSyncExternalStore(subscribe,()=>shown===jobId,()=>false);
function DocumentPanel({subPath}:PluginNavPanelProps){
 const target=experimental_useFixedTabTarget(documentTab);
 const doc=useSyncExternalStore(subscribe,()=>document,()=>null);
 const matches=doc&&target?.target.jobId===doc.jobId&&target.target.fileId===doc.file.id&&subPath===`jobs/${doc.jobId}`;
 useEffect(()=>{shown=matches?doc.jobId:null;emit();return()=>{shown=null;emit();};},[Boolean(matches),doc?.jobId]);
 if(!matches)return <div className="p-5 text-sm text-muted-foreground">Откройте вложение в задаче. Документ появится здесь рядом с её содержимым.</div>;
 return <div className="h-full overflow-auto p-3"><div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{doc.jobId} · Вложения</span>{doc.files.map(file=><button key={file.id} className={`rounded px-2 py-1 ${file.id===doc.file.id?'bg-muted text-foreground':'hover:bg-muted'}`} onClick={()=>doc.select(file)}>{file.name}</button>)}</div><FileWorkspace key={doc.file.id} file={doc.file} draft={doc.draft} onDraft={doc.onDraft} onSave={doc.onSave} close={doc.close} nativePanel/></div>;
}
