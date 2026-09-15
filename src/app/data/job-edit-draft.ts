import type { Job, State } from "../prototype/data";
import { stateNames } from "../prototype/data";
import { UNASSIGNED_AGENT, assigneeFields, selectedAgentId, type NamedPlacement } from "./job-placement";

/**
 * Draft of the fields the "Редактировать" dialog owns.
 *
 * The task rail is read-only, so every property change is collected here and
 * committed once, when the user saves. Nothing is written while the dialog is
 * open, which keeps "Отмена" honest.
 */
export type JobEditDraft = {
  title: string;
  description: string;
  state: State;
  /** Live mode: agent id or UNASSIGNED_AGENT. Demo mode: agent name. */
  assignee: string;
  priority: string;
  due: string;
};

export type JobEditCommit = { patch: Partial<Job>; summary: string };

export function jobEditDraftFrom(
  job: Job,
  agents: readonly NamedPlacement[],
  demoMode: boolean,
): JobEditDraft {
  return {
    title: job.title,
    description: job.description,
    state: job.state,
    assignee: demoMode ? job.agent : selectedAgentId(job, agents),
    priority: job.priority,
    due: job.due,
  };
}

/**
 * Fields that actually changed, plus a single history line describing them.
 * Returns null when the draft matches the job, so saving stays a no-op.
 */
export function jobEditCommit(
  draft: JobEditDraft,
  job: Job,
  agents: readonly NamedPlacement[],
  options: { demoMode: boolean; statusLocked: boolean },
): JobEditCommit | null {
  const patch: Partial<Job> = {};
  const notes: string[] = [];
  const title = draft.title.trim();
  if (title && title !== job.title) {
    patch.title = title;
    notes.push("название");
  }
  if (draft.description !== job.description) {
    patch.description = draft.description;
    notes.push("описание");
  }
  if (!options.statusLocked && draft.state !== job.state) {
    patch.state = draft.state;
    notes.push(`статус: ${stateNames[job.state]} → ${stateNames[draft.state]}`);
  }
  if (draft.priority !== job.priority) {
    patch.priority = draft.priority;
    notes.push(`приоритет: ${draft.priority}`);
  }
  if (draft.due !== job.due) {
    patch.due = draft.due;
    notes.push(`срок: ${draft.due || "не задан"}`);
  }
  if (options.demoMode) {
    if (draft.assignee !== job.agent) {
      patch.agent = draft.assignee;
      notes.push(`исполнитель: ${draft.assignee}`);
    }
  } else if (draft.assignee !== selectedAgentId(job, agents)) {
    const next = assigneeFields(draft.assignee === UNASSIGNED_AGENT ? null : draft.assignee, agents);
    patch.assignedAgentId = next.assignedAgentId;
    patch.agent = next.agent;
    notes.push(`исполнитель: ${next.agent}`);
  }
  if (!notes.length) return null;
  return { patch, summary: `Вы обновили задачу — ${notes.join(", ")}` };
}
