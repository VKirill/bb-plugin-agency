import { useState } from 'react';
import type { Agent, Job } from './data';
import { AgentMark, Button, PageHead, TabBar, Status, Empty } from './shared';
import './inbox.css';

export function InboxPage({ jobs, agents, readIds, setReadIds, go }: {
 jobs: Job[]; agents: Agent[]; readIds: string[];
 setReadIds: (ids: string[]) => void; go: (s: string, id?: string) => void;
}) {
 const [tab, setTab] = useState('Нужно ваше решение');
 const decisions = jobs.filter(j => j.state === 'blocked' || j.state === 'review');
 const updates = jobs.filter(j => j.state === 'done');
 const isDecision = tab === 'Нужно ваше решение';
 const list = isDecision ? decisions : updates;
 const unread = updates.filter(j => !readIds.includes(j.id)).length;
 const open = (job: Job) => {
  if (!isDecision) setReadIds([...new Set([...readIds, job.id])]);
  go('jobs', job.id);
 };
 return <div className="agency-inbox space-y-3">
  <PageHead title="Входящие"/>
  <div className="flex flex-wrap items-center justify-between gap-2">
   <TabBar value={tab} onChange={setTab} tabs={['Нужно ваше решение', 'Уведомления']}/>
   <div className="flex items-center gap-3">
    <span className="text-xs text-muted-foreground">{isDecision ? `К рассмотрению: ${decisions.length}` : `Непрочитанных: ${unread}`}</span>
    {!isDecision && <Button size="sm" variant="ghost" disabled={!unread} onClick={() => setReadIds([...new Set([...readIds, ...updates.map(j => j.id)])])}>Прочитать все</Button>}
   </div>
  </div>
  {!list.length ? <Empty title={isDecision ? 'Ваших решений сейчас не требуется' : 'Новых уведомлений нет'} description="Можно продолжить работу со списком задач."/> :
   <ul className="divide-y divide-border border-y border-border" aria-label={isDecision ? 'Запросы на решение' : 'Уведомления о задачах'}>
    {list.map(j => <li key={j.id} className="agency-inbox-row hover:bg-muted/40">
     <button className="agency-inbox-item rounded-sm text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => open(j)}>
      <AgentMark id={agents.find(a => a.name === j.agent)?.selection.providerId || ''} className="size-5 text-muted-foreground"/>
      <span className="min-w-0">
       <span className="block truncate text-sm font-medium" title={j.title}>{j.title}</span>
       <span className="mt-0.5 block truncate text-xs text-muted-foreground">{j.id} · {j.project} · {j.agent}</span>
      </span>
     </button>
     <span className="agency-inbox-state">{isDecision ? <Status state={j.state}/> : <span className="text-xs text-muted-foreground">{readIds.includes(j.id) ? 'Прочитано' : 'Новое'}</span>}</span>
     <Button size="sm" variant="ghost" className="agency-inbox-action" aria-label={`${j.state === 'review' ? 'Проверить результат' : 'Открыть задачу'}: ${j.title}`} onClick={() => open(j)}>{j.state === 'review' ? 'Проверить' : 'Открыть'} <span aria-hidden="true">→</span></Button>
    </li>)}
   </ul>}
 </div>;
}
