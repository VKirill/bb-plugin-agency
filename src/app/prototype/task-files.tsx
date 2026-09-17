import { useRef } from "react";
import { Button, Icon } from "./shared";
import type { TaskFile } from "./data";
import { tr } from "../i18n";

export function formatFileChipMeta(file: Pick<TaskFile, "size" | "version" | "hash">): string {
  const size = !Number.isFinite(file.size) || file.size <= 0
    ? tr("0 Б")
    : file.size < 1024
      ? tr("{size} Б", { size: Math.round(file.size) })
      : tr("{size} КБ", { size: Math.round(file.size / 1024) });
  if (file.version && file.hash) {
    return `${size} · v${file.version} · ${file.hash.slice(0, 8)} · ${tr("Открыть")}`;
  }
  return `${size} · ${tr("Открыть")}`;
}

export function FileChip({file,open}:{file:TaskFile;open:(f:TaskFile)=>void}) {
 return <button onClick={()=>open(file)} className="flex min-h-14 max-w-full items-center gap-3 rounded-lg border border-border bg-background px-3 py-2 text-left shadow-sm transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"><span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted"><Icon name="FileText" className="size-4"/></span><span className="min-w-0"><span className="block truncate text-sm font-medium">{file.name}</span><span className="block text-xs text-muted-foreground">{formatFileChipMeta(file)}</span></span></button>;
}
export function FilePicker({onFiles,notice,label="Прикрепить файл",icon=true}:{onFiles:(files:TaskFile[])=>void;notice:(s:string)=>void;label?:string;icon?:boolean}) {
 const input=useRef<HTMLInputElement>(null);
 return <><input ref={input} type="file" multiple accept=".md,.markdown,.mdx,.txt,.json,.yaml,.yml,.csv,image/png,image/jpeg,image/webp,image/gif" className="hidden" aria-label={tr(label)} onChange={async e=>{
 const selected=Array.from(e.target.files||[]);e.target.value="";const files:TaskFile[]=[];
 for(const file of selected){if(file.size>5*1024*1024){notice(tr("{name}: максимум 5 МБ для предпросмотра.",{name:file.name}));continue;}
 const isImage=/^image\/(png|jpeg|webp|gif)$/.test(file.type);const isText=/\.(md|markdown|mdx|txt|json|yaml|yml|csv)$/i.test(file.name);
 if(!isImage&&!isText){notice(tr("{name}: пока поддерживаются тексты и изображения.",{name:file.name}));continue;}
 try {const content=isImage?await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);}):await file.text();files.push({id:crypto.randomUUID(),name:file.name,size:file.size,kind:isImage?"image":"text",content});}catch{notice(tr("Не удалось прочитать {name}. Попробуйте снова.",{name:file.name}));}}
 if(files.length)onFiles(files);
 }}/><Button size="sm" variant="ghost" onClick={()=>input.current?.click()}>{icon&&<Icon name="Paperclip" className="mr-1.5 size-3.5"/>}{tr(label)}</Button></>;
}
