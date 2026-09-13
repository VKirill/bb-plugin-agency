import { useMemo } from 'react';
import { Markdown, experimental_SourceCode as SourceCode } from '@get-bb/plugin-sdk/app';
import { parseDocumentProperties } from './document-properties-data';

function PropertyValue({value,depth=0}:{value:unknown;depth?:number}) {
 if(depth>10)return <span className="text-muted-foreground">Вложенность более 10 уровней — см. исходник.</span>;
 if(Array.isArray(value))return value.length?<ul className="list-disc space-y-1 pl-4">{value.map((item,i)=><li key={i}><PropertyValue value={item} depth={depth+1}/></li>)}</ul>:<span>[]</span>;
 if(value!==null&&typeof value==='object'){
  const entries=Object.entries(value);
  return entries.length?<dl className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,3fr)] gap-x-4 gap-y-1.5">{entries.map(([key,item])=><div className="contents" key={key}><dt className="break-words text-muted-foreground">{key}</dt><dd className="min-w-0 whitespace-pre-wrap break-words"><PropertyValue value={item} depth={depth+1}/></dd></div>)}</dl>:<span>{'{}'}</span>;
 }
 return <span className="whitespace-pre-wrap break-words">{value===null?'null':value===''?'""':String(value)}</span>;
}
export function DocumentMarkdown({content}:{content:string}) {
 const document=useMemo(()=>parseDocumentProperties(content),[content]);
 return <>
  {document.source!==null&&<details className="mb-5 rounded-lg border border-border bg-muted/20 text-xs leading-relaxed">
   <summary className="cursor-pointer rounded-lg px-3 py-2.5 text-sm font-medium hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">Свойства документа</summary>
   <div className="px-3 pb-3 pt-1">
    {document.error?<><p className="mb-2 text-muted-foreground">Не удалось разобрать YAML. Исходные свойства сохранены:</p><SourceCode content={document.source} path="properties.yaml" overflow="scroll"/></>:<PropertyValue value={document.value}/>}
   </div>
  </details>}
  <Markdown content={document.body} className="min-w-0 break-words"/>
 </>;
}
