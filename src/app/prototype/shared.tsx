import { experimental_ProviderIcon, experimental_useProviders } from "@get-bb/plugin-sdk/app";
import { useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Textarea } from "../../../components/ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../../../components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { Checkbox } from "../../../components/ui/checkbox";
import { Icon } from "../../../components/ui/icon";
import { stateNames, type State } from "./data";
import { tr, trNode } from "../i18n";
export { Button, Input, Textarea, Checkbox, Icon };
export function Field({ label, hint, children, info, required }: { label: string; hint?: string; children: ReactNode; info?: ReactNode; required?: boolean }) { return <div className="space-y-1.5"><div className="flex items-center gap-1"><div className="text-sm font-medium">{tr(label)}{required&&<span aria-hidden className="ml-0.5 text-muted-foreground">*</span>}</div>{info&&<InfoHint title={label}>{info}</InfoHint>}</div>{children}{hint && <p className="text-xs text-muted-foreground">{tr(hint)}</p>}</div>; }
export function TextField({ label, value, onChange, multiline = false, type = "text", disabled, hint, info, placeholder, rows = 6, maxLength, required }: { label: string; value: string; onChange: (v: string) => void; multiline?: boolean; type?: string; disabled?: boolean; hint?: string; info?: ReactNode; placeholder?: string; rows?: number; maxLength?: number; required?: boolean }) { const id = useId(); return <div className="space-y-1.5"><div className="flex items-center gap-1"><label htmlFor={id} className="text-sm font-medium">{tr(label)}{required&&<span aria-hidden className="ml-0.5 text-muted-foreground">*</span>}</label>{info&&<InfoHint title={label}>{info}</InfoHint>}</div>{multiline ? <Textarea id={id} value={value} disabled={disabled} placeholder={placeholder===undefined?undefined:tr(placeholder)} maxLength={maxLength} aria-required={required||undefined} onChange={e => onChange(e.target.value)} rows={rows}/> : <Input id={id} type={type} value={value} disabled={disabled} placeholder={placeholder===undefined?undefined:tr(placeholder)} maxLength={maxLength} aria-required={required||undefined} onChange={e => onChange(e.target.value)}/>}{hint && <p className="text-xs text-muted-foreground">{tr(hint)}</p>}</div>; }
export function Choice({ label, value, onChange, options, disabled }: { label: string; value: string; onChange: (v: string) => void; options: readonly (string | { value: string; label: string })[]; disabled?:boolean }) { return <Select disabled={disabled} value={value} onValueChange={onChange}><SelectTrigger aria-label={tr(label)} className="w-full min-w-0"><SelectValue placeholder={tr(label)}/></SelectTrigger><SelectContent>{options.map(o => <SelectItem key={typeof o === "string" ? o : o.value} value={typeof o === "string" ? o : o.value}>{tr(typeof o === "string" ? o : o.label)}</SelectItem>)}</SelectContent></Select>; }
export function PageHead({ title, description, children, level=1 }: { level?:1|2; title: string; description?: string; children?: ReactNode }) { const Heading=level===1?"h1":"h2"; return <header className="flex flex-wrap items-center justify-between gap-3 pb-2 [&_button]:h-8 [&_button]:text-xs"><div><Heading className={level===1?"text-lg font-semibold tracking-tight":"text-sm font-semibold"}>{tr(title)}</Heading>{description && <p className="mt-1 text-sm text-muted-foreground">{tr(description)}</p>}</div><div className="flex flex-wrap items-center gap-2">{children}</div></header>; }
/** A tab label may carry a count, «Задачи (3)»: the words are translated, the count kept. */
function tabLabel(tab: string): string {
 const counted = /^(.*\S)\s+\((\d+)\)$/.exec(tab);
 return counted ? `${tr(counted[1]!)} (${counted[2]})` : tr(tab);
}
export function TabBar({ value, onChange, tabs, idPrefix }: { value: string; onChange: (v: string) => void; tabs: readonly string[]; idPrefix?: string }) { return <Tabs value={value} onValueChange={onChange}><div className="overflow-x-auto"><TabsList className="h-auto w-max justify-start gap-4 rounded-none border-b border-border bg-transparent p-0">{tabs.map(t => <TabsTrigger className="rounded-none border-b-2 border-transparent px-1 py-2 text-xs shadow-none data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none" value={t} key={t} data-testid={idPrefix ? `${idPrefix}-${t}` : undefined}>{tabLabel(t)}</TabsTrigger>)}</TabsList></div></Tabs>; }
export function Panel({ title, children, info }: { title?: string; children: ReactNode; info?: ReactNode }) { return <section className="border-b border-border py-3">{title && <div className="mb-3 flex items-center gap-1"><h2 className="text-sm font-semibold">{tr(title)}</h2>{info&&<InfoHint title={title}>{info}</InfoHint>}</div>}{children}</section>; }
export function Status({ state, iconOnly }: { state: State; iconOnly?: boolean }) { const icon = state === "done" ? "CircleCheck" : state === "review" ? "Eye" : state === "blocked" || state === "waiting_input" ? "AlertCircle" : state === "running" ? "Play" : state === "canceled" ? "CircleX" : "Circle"; const color = state === "running" ? "text-amber-500" : state === "review" ? "text-blue-500" : state === "done" ? "text-emerald-500" : state === "blocked" || state === "waiting_input" ? "text-orange-500" : "text-muted-foreground"; if (iconOnly) return <Icon name={icon} aria-label={tr(stateNames[state])} className={`size-3.5 shrink-0 ${color}`}/>; return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs"><Icon name={icon} className={`size-3.5 shrink-0 ${color}`}/>{tr(stateNames[state])}</span>; }
export function Checks({ options, selected, onChange, locked = [] }: { options: readonly (string | { value: string; label: string })[]; selected: string[]; onChange: (v: string[]) => void; locked?: readonly string[] }) { return <div className="divide-y divide-border rounded-lg border border-border">{options.map(option => { const value = typeof option === "string" ? option : option.value; const label = typeof option === "string" ? option : option.label; const hold = locked.includes(value); return <label key={value} className={`flex items-center gap-2 px-3 py-2 text-sm ${hold ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:bg-muted/50"}`}><Checkbox disabled={hold} checked={selected.includes(value)} onCheckedChange={checked => { if (hold) return; onChange(checked ? [...selected, value] : selected.filter(x => x !== value)); }}/><span>{tr(label)}</span></label>; })}</div>; }
export function Empty({ title, description }: { title: string; description: string }) { return <div className="rounded-lg border border-dashed border-border px-5 py-10 text-center"><p className="font-medium">{tr(title)}</p><p className="mt-1 text-sm text-muted-foreground">{tr(description)}</p></div>; }
export function Rows({ rows }: { rows: [string, ReactNode][] }) { return <dl className="divide-y divide-border">{rows.map(([k,v]) => <div key={k} className="flex min-w-0 justify-between gap-3 py-2 text-sm"><dt className="shrink-0 text-muted-foreground">{tr(k)}</dt><dd className="min-w-0 max-w-[min(100%,28rem)] text-right">{trNode(v)}</dd></div>)}</dl>; }

export function Collection({columns,rows}:{columns:string[];rows:{id:string;name:ReactNode;cells:ReactNode[];open:()=>void}[]}) {
 return <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full text-left text-sm"><thead className="bg-muted/40 text-xs text-muted-foreground"><tr>{columns.map((c,i)=><th key={c} className={`px-4 py-2 font-medium ${i>1?"hidden md:table-cell":""}`}>{tr(c)}</th>)}</tr></thead><tbody className="divide-y divide-border">{rows.map(row=><tr key={row.id} className="cursor-pointer hover:bg-muted/30" onClick={event=>{if((event.target as HTMLElement).closest("button,a,input,select,textarea,[role=switch],[role=checkbox]"))return;row.open();}}><td className="px-4 py-3"><button className="text-left focus-visible:outline focus-visible:outline-ring" onClick={row.open}>{row.name}</button></td>{row.cells.map((c,i)=><td key={i} className={`px-4 py-3 text-xs text-muted-foreground ${i>0?"hidden md:table-cell":""}`}>{c}</td>)}</tr>)}</tbody></table>{!rows.length&&<p className="p-6 text-sm text-muted-foreground">{tr("Ничего не найдено. Измените фильтры.")}</p>}</div>;
}

export function AgentMark({id,className="size-5"}:{id:string;className?:string}) { const {providers}=experimental_useProviders();const ProviderIcon=experimental_ProviderIcon;return <ProviderIcon providerKind="agent" provider={providers.find(p=>p.id===id)||{id}} fallback="Bot" className={className}/>; }

export function SearchInput({className="",...props}:ComponentProps<"input">) {
 return <div className={`relative w-full max-w-sm ${className}`}><Icon name="Search" aria-hidden className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground"/><Input {...props} type="search" className="h-9 border-foreground/25 bg-muted/30 pl-9 pr-3 shadow-sm hover:border-foreground/40 focus-visible:bg-background"/></div>;
}

/**
 * «?» next to a block: what the block means and how it works. Opens on hover
 * with a pointer and on tap or keyboard everywhere; on a compact viewport the
 * registry popover becomes a bottom sheet. Text only, no actions inside.
 */
export function InfoHint({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
 const [open,setOpen]=useState(false);
 const closeTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const hover=(next:boolean)=>{if(closeTimer.current)clearTimeout(closeTimer.current);if(next)setOpen(true);else closeTimer.current=setTimeout(()=>setOpen(false),150);};
 const pointerHover=(event:{pointerType:string},next:boolean)=>{if(event.pointerType==="mouse")hover(next);};
 return <Popover open={open} onOpenChange={setOpen}>
  <PopoverTrigger asChild><button type="button" aria-label={tr("Как это работает: {title}", { title: tr(title) })} onPointerEnter={e=>pointerHover(e,true)} onPointerLeave={e=>pointerHover(e,false)} className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full align-middle text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${className}`}><Icon name="CircleQuestion" className="size-3.5"/></button></PopoverTrigger>
  <PopoverContent mobileTitle={tr(title)} align="start" className="w-80 p-3" onPointerEnter={e=>pointerHover(e,true)} onPointerLeave={e=>pointerHover(e,false)}>
   <p className="text-sm font-medium">{tr(title)}</p>
   <div className="mt-1.5 space-y-1.5 text-xs leading-relaxed text-muted-foreground">{children}</div>
  </PopoverContent>
 </Popover>;
}

/**
 * A fixed choice as a dropdown where every option carries its own «?»: the
 * person sees what each role or level means before picking it. The selected
 * option's short description stays under the field.
 */
export function HintedChoice<T extends string>({ label, value, onChange, options, info, disabled, required }: { label: string; value: T; onChange: (value: T) => void; options: readonly { value: T; label: string; description: string; hint?: readonly string[] }[]; info?: ReactNode; disabled?: boolean; required?: boolean }) {
 const [open,setOpen]=useState(false);
 const labelId=useId();
 const selected=options.find(option=>option.value===value);
 return <div className="space-y-1.5">
  <div className="flex items-center gap-1"><span id={labelId} className="text-sm font-medium">{tr(label)}{required&&<span aria-hidden className="ml-0.5 text-muted-foreground">*</span>}</span>{info&&<InfoHint title={label}>{info}</InfoHint>}</div>
  <Popover open={open} onOpenChange={setOpen}>
   <PopoverTrigger asChild><button type="button" disabled={disabled} aria-labelledby={labelId} aria-haspopup="listbox" aria-expanded={open} className="flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"><span className="truncate">{tr(selected?.label??"Выберите")}</span><Icon name="ChevronDown" className="size-4 shrink-0 opacity-60"/></button></PopoverTrigger>
   <PopoverContent mobileTitle={tr(label)} align="start" className="w-[var(--radix-popover-trigger-width)] min-w-72 max-w-[calc(100vw-2rem)] p-1">
    <div role="listbox" aria-labelledby={labelId} className="flex flex-col">
     {options.map(option=>{const active=option.value===value;return <div key={option.value} className={`flex items-start gap-1 rounded-md ${active?"bg-muted":"hover:bg-muted"}`}>
      <button type="button" role="option" aria-selected={active} onClick={()=>{onChange(option.value);setOpen(false);}} className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
       <span className="flex items-center gap-1.5 text-sm font-medium">{active&&<Icon name="Check" className="size-3.5"/>}{tr(option.label)}</span>
       <span className="text-xs text-muted-foreground">{tr(option.description)}</span>
      </button>
      {option.hint&&option.hint.length>0&&<InfoHint title={option.label} className="mr-1.5 mt-2">{option.hint.map(line=><p key={line}>{tr(line)}</p>)}</InfoHint>}
     </div>;})}
    </div>
   </PopoverContent>
  </Popover>
  {selected&&<p className="text-xs text-muted-foreground">{tr(selected.description)}</p>}
 </div>;
}

/** Section heading with an optional «?» hint, shared by project and department pages. */
export function HintHeading({ title, hint, level = 2, children }: { title: string; hint?: ReactNode; level?: 2 | 3; children?: ReactNode }) {
 const Heading = level === 2 ? "h2" : "h3";
 return <div className="mb-3 flex items-center justify-between gap-2"><div className="flex items-center gap-1"><Heading className="text-sm font-semibold">{tr(title)}</Heading>{hint&&<InfoHint title={title}>{hint}</InfoHint>}</div>{children&&<div className="flex items-center gap-2">{children}</div>}</div>;
}
