import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../../components/ui/tabs';
import { AgentMark, Button, Checkbox, Textarea, Input, Icon } from './shared';
import { type Answers, type TaskQuestion, validateAnswers } from './question-contract';
import { tr } from '../i18n';
export type { TaskQuestion } from './question-contract';

export function TaskQuestionBlock({question,agent,onDraft,onAnswer}:{question:TaskQuestion;agent:string;onDraft:(a:Answers)=>void;onAnswer:(a:Answers)=>void}) {
 const [current,setCurrent]=useState(0);
 const answers=question.draft||{};
 const validAt=(index:number)=>{const q=question.questions[index];return q&&!validateAnswers([q],{[q.id]:answers[q.id]||{selected:[]}});};
 const total=question.questions.length;
 const last=current===total-1;
 const error=validateAnswers(question.questions,answers);
 if(question.kind==='secret_request')return <section aria-label={tr("Защищённый запрос")} className="mb-5 rounded-lg border border-border bg-muted/20 p-4">
  <div className="mb-3 flex items-center gap-2"><Icon name="KeyRound" className="size-4"/><h2 className="text-sm font-semibold">{tr("{agent}: доступ к сервису",{agent})}</h2></div>
  <p className="mb-4 text-sm">{tr("Ключ будет введён через штатную форму Secrets и сохранён в указанное окружение.")}</p>
  <label className="block text-sm font-medium" htmlFor="secret-example">{tr("API-ключ сервиса")}</label><Input id="secret-example" type="password" disabled placeholder={tr("Форма появится в подключённом запуске")} className="mt-2 max-w-md"/>
  <p className="mt-2 text-xs text-muted-foreground">{tr("Пример защищённого запроса. Здесь нельзя вводить настоящий ключ: ожидающего запроса агента ещё нет.")}</p>
  <Button size="sm" className="mt-4" disabled>{tr("Открыть защищённую форму")}</Button>
 </section>;
 if(question.status==='resolved')return <section className="mb-5 rounded-lg border border-border p-4"><h2 className="text-sm font-semibold">{tr("Ответ сохранён в примере")}</h2><p className="mt-1 text-xs text-muted-foreground">{tr("Связан с запросом {agent}. Реальная доставка агенту ещё не подключена.",{agent})}</p><details className="mt-3"><summary className="cursor-pointer text-xs">{tr("Ваши ответы")}</summary><dl className="mt-3 space-y-3 text-sm">{question.questions.map(q=><div key={q.id}><dt className="text-muted-foreground">{tr(q.prompt)}</dt><dd>{question.answers?.[q.id]?.selected.map(v=>tr(q.options?.find(o=>o.value===v)?.label||v)).join(', ')} {question.answers?.[q.id]?.freeText}</dd></div>)}</dl></details></section>;
 return <section aria-label={tr("Вопросы агента")} className="mb-5 rounded-lg border border-foreground/20 bg-muted/20 p-4">
  <div className="mb-4 flex items-center gap-2"><AgentMark id="codex" className="size-5"/><div><h2 className="text-sm font-semibold">{tr("{agent} ждёт вашего ответа",{agent})}</h2><p className="mt-1 text-xs text-muted-foreground">{tr("Заполните вопросы, чтобы продолжить этот этап.")}</p></div></div>
  <form onSubmit={e=>{e.preventDefault();if(!last){if(validAt(current))setCurrent(current+1);}else if(!error)onAnswer(answers);}} className="space-y-4">
   <Tabs value={String(current)} onValueChange={v=>setCurrent(Number(v))}><div className="overflow-x-auto">{total>1&&<TabsList className="h-auto w-max gap-1 bg-muted/50">{question.questions.map((q,index)=><TabsTrigger key={q.id} value={String(index)} className="px-3 py-2 text-xs">{tr("Вопрос {number}",{number:index+1})}{validAt(index)&&<span aria-label={tr("заполнен")} className="ml-1 text-emerald-600">✓</span>}</TabsTrigger>)}</TabsList>}</div>
   {question.questions.map((q,index)=>{const a=answers[q.id]||{selected:[]};return <TabsContent key={q.id} value={String(index)} className="mt-4"><fieldset className="min-w-0 space-y-2"><legend className="mb-2 text-sm font-medium">{tr(q.prompt)}</legend>
    {q.options?.map(option=><label key={option.value} className="flex min-h-9 cursor-pointer items-center gap-2 text-sm">{q.multiSelect?<Checkbox checked={a.selected.includes(option.value)} onCheckedChange={checked=>onDraft({...answers,[q.id]:{...a,selected:checked?[...a.selected,option.value]:a.selected.filter(v=>v!==option.value)}})}/>:<input type="radio" name={`${question.id}-${q.id}`} value={option.value} checked={a.selected.includes(option.value)} onChange={()=>onDraft({...answers,[q.id]:{...a,selected:[option.value]}})} className="size-4 accent-[var(--foreground)]"/>}<span>{tr(option.label)}{option.description&&<span className="block text-xs text-muted-foreground">{tr(option.description)}</span>}</span></label>)}
    {q.allowFreeText&&<><label htmlFor={`${question.id}-${q.id}`} className={q.options?'block text-xs text-muted-foreground':'sr-only'}>{q.options?tr('Свой вариант или уточнение'):tr(q.prompt)}</label><Textarea id={`${question.id}-${q.id}`} value={a.freeText||''} maxLength={16000} rows={q.options?2:3} onChange={e=>onDraft({...answers,[q.id]:{...a,freeText:e.target.value}})} placeholder={q.options?tr('Можно дополнить выбор'):tr('Напишите ответ')}/></>}
   </fieldset></TabsContent>;})}</Tabs>
   <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3"><span className="text-xs text-muted-foreground">{tr("Заполнено {done} из {total}",{done:question.questions.filter((_,i)=>validAt(i)).length,total})}</span><div className="flex items-center gap-2">{current>0&&<Button size="sm" variant="outline" type="button" onClick={()=>setCurrent(current-1)}>{tr("Назад")}</Button>}<Button size="sm" type="submit" disabled={last?Boolean(error):!validAt(current)}>{last?tr('Отправить'):tr('Далее')}</Button></div></div><p className="text-xs text-muted-foreground">{tr("Ответ сохраняется в примере. Реальная доставка агенту ещё не подключена.")}</p>
  </form>
 </section>;
}
