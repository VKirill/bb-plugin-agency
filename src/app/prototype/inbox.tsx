import { useEffect, useState } from "react";
import type { Agent, Job } from "./data";
import type { DispatcherApi, ListedActionIntent } from "../data/dispatcher";
import { inboxDecisionJobs } from "../data/inbox";
import { intentsAwaitingApproval, LEGACY_NOTIFY_HINT } from "../data/dispatcher";
import { AgentMark, Button, PageHead, TabBar, Status, Empty } from "./shared";
import { DispatcherIntentList } from "./dispatcher-intents";
import "./inbox.css";

export function InboxPage({ jobs, agents, readIds, setReadIds, go, dispatcher, notice }: {
  jobs: Job[];
  agents: Agent[];
  readIds: string[];
  setReadIds: (ids: string[]) => void;
  go: (s: string, id?: string) => void;
  dispatcher?: Pick<DispatcherApi, "listActionIntents" | "approveActionIntent" | "claimActionIntent">;
  notice?: (text: string) => void;
}) {
  const [tab, setTab] = useState("Нужно ваше решение");
  const [intents, setIntents] = useState<ListedActionIntent[]>([]);
  const decisions = inboxDecisionJobs(jobs);
  const updates = jobs.filter((job) => job.state === "done");
  const isDecision = tab === "Нужно ваше решение";
  const isRules = tab === "Согласование";
  const list = isDecision ? decisions : updates;

  useEffect(() => {
    if (!dispatcher) return;
    void dispatcher.listActionIntents({}).then((result) => {
      if (result.ok) setIntents(intentsAwaitingApproval(result.value));
    });
  }, [dispatcher]);
  const unread = updates.filter((job) => !readIds.includes(job.id)).length;
  const open = (job: Job) => {
    if (!isDecision) setReadIds([...new Set([...readIds, job.id])]);
    go("jobs", job.id);
  };
  return (
    <div className="agency-inbox space-y-3">
      <PageHead title="Входящие" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TabBar value={tab} onChange={setTab} tabs={dispatcher ? ["Нужно ваше решение", "Согласование", "Уведомления"] : ["Нужно ваше решение", "Уведомления"]} />
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">{isRules ? `К согласованию: ${intents.length}` : isDecision ? `К рассмотрению: ${decisions.length}` : `Непрочитанных: ${unread}`}</span>
          {!isDecision && !isRules && (
            <Button size="sm" variant="ghost" disabled={!unread} onClick={() => setReadIds([...new Set([...readIds, ...updates.map((job) => job.id)])])}>
              Прочитать все
            </Button>
          )}
        </div>
      </div>
      {isRules && dispatcher ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{LEGACY_NOTIFY_HINT}</p>
          <DispatcherIntentList
            intents={intents}
            api={dispatcher}
            notice={notice ?? (() => undefined)}
            onChanged={() => {
              void dispatcher.listActionIntents({}).then((result) => {
                if (result.ok) setIntents(intentsAwaitingApproval(result.value));
              });
            }}
            allowClaim={false}
          />
        </div>
      ) : !list.length ? (
        <Empty title={isDecision ? "Ваших решений сейчас не требуется" : "Новых уведомлений нет"} description="Можно продолжить работу со списком задач." />
      ) : (
        <ul className="divide-y divide-border border-y border-border" aria-label={isDecision ? "Запросы на решение" : "Уведомления о задачах"} data-testid="inbox-list">
          {list.map((job) => {
            const review = job.state === "review";
            const action = review ? "Проверить" : "Открыть";
            return (
              <li key={job.id} className="agency-inbox-row hover:bg-muted/40" data-testid={`inbox-row-${job.id}`}>
                <button
                  className="agency-inbox-item rounded-sm text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                  data-testid={`inbox-open-${job.id}`}
                  onClick={() => open(job)}
                >
                  <AgentMark id={agents.find((agent) => agent.name === job.agent)?.selection.providerId || ""} className="size-5 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium" title={job.title}>{job.title}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">{job.id} · {job.project} · {job.agent}</span>
                  </span>
                </button>
                <span className="agency-inbox-state">
                  {isDecision ? <Status state={job.state} /> : <span className="text-xs text-muted-foreground">{readIds.includes(job.id) ? "Прочитано" : "Новое"}</span>}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="agency-inbox-action"
                  data-testid={`inbox-action-${job.id}`}
                  aria-label={`${action} задачу: ${job.title}`}
                  onClick={() => open(job)}
                >
                  {action} <span aria-hidden="true">→</span>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
