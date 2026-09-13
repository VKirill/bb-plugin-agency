import { markdownShowcase } from './markdown-showcase';
import { useRef } from "react";
import { Button, Icon } from "./shared";
import type { TaskFile } from "./data";

export const exampleFiles:TaskFile[] = [
 {id:"offer-v2",version:2,name:"Оффер.md",size:540,kind:"text",content:"# AI-фотосессия для вашего профиля\n\nПодберите образ и подготовьте фотографии для личной страницы.\n\n## Перед публикацией\nПроверить фактические условия услуги и согласовать формулировки.\n\n_Демонстрационный материал, версия 2._"},
 {id:"review-notes",name:"Проверка.md",size:310,kind:"text",content:"# Проверка оффера\n\n- Уточнить условия услуги перед публикацией.\n- Сопоставить обещания с актуальным описанием продукта.\n\n_Пример замечаний проверяющего._"},
 {id:"markdown-demo",version:1,name:"Возможности Markdown.md",size:new TextEncoder().encode(markdownShowcase).length,kind:"text",content:markdownShowcase},
];
export function FileChip({file,open}:{file:TaskFile;open:(f:TaskFile)=>void}) {
 return <button onClick={()=>open(file)} className="flex min-h-14 max-w-full items-center gap-3 rounded-lg border border-border bg-background px-3 py-2 text-left shadow-sm transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"><span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted"><Icon name="FileText" className="size-4"/></span><span className="min-w-0"><span className="block truncate text-sm font-medium">{file.name}</span><span className="block text-xs text-muted-foreground">{Math.max(1,Math.round(file.size/1024))} КБ · Открыть</span></span></button>;
}
export function FilePicker({onFiles,notice,label="Прикрепить файл"}:{onFiles:(files:TaskFile[])=>void;notice:(s:string)=>void;label?:string}) {
 const input=useRef<HTMLInputElement>(null);
 return <><input ref={input} type="file" multiple accept=".md,.markdown,.mdx,.txt,.json,.yaml,.yml,.csv,image/png,image/jpeg,image/webp,image/gif" className="hidden" aria-label={label} onChange={async e=>{
 const selected=Array.from(e.target.files||[]);e.target.value="";const files:TaskFile[]=[];
 for(const file of selected){if(file.size>5*1024*1024){notice(`${file.name}: максимум 5 МБ для предпросмотра.`);continue;}
 const isImage=/^image\/(png|jpeg|webp|gif)$/.test(file.type);const isText=/\.(md|markdown|mdx|txt|json|yaml|yml|csv)$/i.test(file.name);
 if(!isImage&&!isText){notice(`${file.name}: пока поддерживаются тексты и изображения.`);continue;}
 try {const content=isImage?await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);}):await file.text();files.push({id:crypto.randomUUID(),name:file.name,size:file.size,kind:isImage?"image":"text",content});}catch{notice(`Не удалось прочитать ${file.name}. Попробуйте снова.`);}}
 if(files.length)onFiles(files);
 }}/><Button size="sm" variant="ghost" onClick={()=>input.current?.click()}><Icon name="Paperclip" className="mr-1.5 size-3.5"/>{label}</Button></>;
}
