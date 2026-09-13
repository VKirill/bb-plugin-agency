import { DocumentMarkdown } from './document-properties';
import { useEffect, useState } from 'react';
import { experimental_SourceCode as SourceCode } from '@get-bb/plugin-sdk/app';
import { Button, Icon, TabBar, Textarea } from './shared';
import type { TaskFile } from './data';

export function FileWorkspace({file,draft,onDraft,onSave,close,nativePanel=false}:{
 file:TaskFile;draft:string;onDraft:(value:string)=>void;onSave:()=>void;close:()=>void;nativePanel?:boolean;
}) {
 const [mode,setMode]=useState('Чтение');
 const dirty=draft!==file.content;
 const markdown=/\.(md|markdown)$/i.test(file.name);
 useEffect(()=>{
  if(!dirty)return;
  const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};
  window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);
 },[dirty]);
 return <section aria-label={`Документ ${file.name}`} className={`agency-file-workspace rounded-lg border border-border bg-background ${nativePanel?"agency-native-doc":""}`}>
  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
   <div className="flex min-w-0 items-center gap-2"><Icon name="FileText" className="size-4 shrink-0 text-muted-foreground"/><h2 className="truncate text-sm font-semibold" title={file.name}>{file.name}</h2><span className="whitespace-nowrap text-xs text-muted-foreground">v{file.version||1}</span></div>
   {!nativePanel&&<Button size="sm" variant="ghost" onClick={close}>← К задаче</Button>}
  </div>
  {file.kind==='text'&&<div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
   <TabBar value={mode} onChange={setMode} tabs={['Чтение','Исходник','Редактор']}/>
   <div className="flex items-center gap-2"><span role="status" className="text-xs text-muted-foreground">{dirty?'Есть изменения':'Сохранено в примере'}</span><Button size="sm" disabled={!dirty} onClick={onSave}>Сохранить файл</Button></div>
  </div>}
  <div className="agency-file-body min-w-0 overflow-auto p-4 sm:p-5">
   {file.kind==='image'?<img src={file.content} alt={file.name} className="mx-auto max-h-[65dvh] max-w-full object-contain"/>:
    mode==='Редактор'?<><label htmlFor={`file-editor-${file.id}`} className="sr-only">Исходный текст {file.name}</label><Textarea id={`file-editor-${file.id}`} value={draft} onChange={e=>onDraft(e.target.value)} spellCheck={false} className="min-h-[55dvh] w-full resize-y font-mono text-sm leading-6"/></>:
    mode==='Чтение'&&markdown?<DocumentMarkdown content={draft}/>:<SourceCode content={draft} path={file.name} overflow="scroll"/>}
  </div>
  <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">{file.kind==='text'?'Правки и предыдущие версии хранятся в примере до перезагрузки.':'Вложение хранится в примере до перезагрузки.'}</p>
 </section>;
}
