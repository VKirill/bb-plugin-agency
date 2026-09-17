import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { shortAgentName } from "../data/agent-name";
import { displayJobTitle, isClosedJob } from "../data/job-board";
import { childProgressLabel } from "../data/job-tree";
import { stateNames, type Job } from "./data";
import { Button, Status } from "./shared";
import { tr } from "../i18n";

/**
 * Subtasks of a main job, read like Tasks: progress first, then one row per
 * subtask with status, key, title and executor. On a subtask card the same list
 * shows its siblings with the current one marked.
 */
export function SubtaskSection({
  title,
  parent,
  subtasks,
  currentId,
  openJob,
  onAdd,
}: {
  title: string;
  parent?: Job;
  subtasks: readonly Job[];
  currentId?: string;
  openJob: (id: string) => void;
  onAdd?: () => void;
}) {
  const closed = subtasks.filter(isClosedJob).length;
  const percent = subtasks.length ? Math.round((closed / subtasks.length) * 100) : 0;
  return (
    <section className="agency-subtasks" aria-label={tr(title)}>
      <div className="agency-subtasks-head">
        <h2 className="text-sm font-medium">
          {tr(title)}
          {parent && (
            <Button size="sm" variant="ghost" className="ml-1.5 h-auto px-0 text-sm font-normal text-muted-foreground hover:bg-transparent hover:text-foreground" onClick={() => openJob(parent.id)}>
              {`${parent.id} · ${displayJobTitle(parent)}`}
            </Button>
          )}
        </h2>
        {onAdd && <Button size="sm" variant="ghost" onClick={onAdd}>{tr("+ Добавить подзадачу")}</Button>}
      </div>
      {subtasks.length > 0 ? (
        <>
          <div className="agency-subtasks-progress" aria-label={tr("Закрыто {closed} из {total}", { closed, total: subtasks.length })}>
            <span className="agency-subtasks-bar" aria-hidden><span style={{ width: `${percent}%` }} /></span>
            <span className="text-xs text-muted-foreground">{`${closed}/${subtasks.length}`}{childProgressLabel(subtasks) ? ` · ${childProgressLabel(subtasks)}` : ""}</span>
          </div>
          <ul className="agency-subtasks-list">
            {subtasks.map((child) => {
              const current = child.id === currentId;
              const agent = shortAgentName(child.agent);
              return (
                <li key={child.id}>
                  <button
                    type="button"
                    className="agency-subtask-row"
                    data-current={current || undefined}
                    aria-current={current ? "page" : undefined}
                    onClick={() => { if (!current) openJob(child.id); }}
                  >
                    <Status state={child.state} iconOnly />
                    <span className="agency-subtask-key">{child.id}</span>
                    <span className="agency-subtask-title">{displayJobTitle(child)}</span>
                    <span className="agency-subtask-meta">{current ? tr("эта задача") : [agent, tr(stateNames[child.state])].filter(Boolean).join(" · ")}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{tr("Подзадач пока нет. Добавьте отдельный результат, который нужно поручить.")}</p>
      )}
    </section>
  );
}

/** Long text shows its first lines; the rest opens on click. Short text renders as is. */
export function CollapsibleText({ children, lines = 6 }: { children: ReactNode; lines?: number }) {
  const body = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const node = body.current;
    if (!node || open) return;
    setOverflows(node.scrollHeight > node.clientHeight + 4);
  });
  return (
    <div className="agency-collapsible" data-open={open || undefined} data-overflows={overflows || undefined} style={{ ["--agency-collapsible-lines" as string]: lines }}>
      <div ref={body} className="agency-collapsible-body">{children}</div>
      {(overflows || open) && (
        <Button size="sm" variant="ghost" className="agency-collapsible-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? tr("Свернуть") : tr("Показать полностью")}
        </Button>
      )}
    </div>
  );
}
