import type { Activity, Job as DomainJob, JobPriority, JobState } from "../../shared/contracts";
import { stateNames, type Agent, type Group, type Job, type State, type TaskActivity, type TaskFile } from "../prototype/data";
import type { JobDetail } from "./agency-api";
import type { WorkspaceSnapshot } from "./snapshot";
import { mapJobFilesFromArtifacts } from "./job-artifacts";
import { bindingPlacementLabel } from "./placement-label";

export const PRIORITY_LABEL: Record<JobPriority, string> = {
  low: "Низкий",
  normal: "Обычный",
  high: "Высокий",
  urgent: "Срочный",
};

export const PRIORITY_CODE: Record<string, JobPriority> = {
  Низкий: "low",
  Обычный: "normal",
  Высокий: "high",
  Срочный: "urgent",
};

const UI_STATES = new Set<State>(["backlog", "queued", "running", "review", "waiting_input", "blocked", "done", "canceled"]);

export function asUiState(state: JobState): State {
  return UI_STATES.has(state as State) ? (state as State) : "blocked";
}

export function dueDate(dueAt: string | null): string {
  return dueAt ? dueAt.slice(0, 10) : "";
}

export function dueAtFromDate(due: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return null;
  return `${due}T00:00:00Z`;
}

export function jobDescription(job: DomainJob): string {
  return `${job.brief}\n\nКритерии приёмки:\n${job.acceptance}`;
}

/**
 * Splits a stored description for display without inventing anything: the
 * acceptance part is null when the job has no "Критерии приёмки" marker, so the
 * card never shows criteria the job does not carry.
 */
export function splitDescription(description: string): { brief: string; acceptance: string | null } {
  const parts = description.split(/\n\nКритерии приёмки:\n/);
  if (parts.length < 2) return { brief: description.trim(), acceptance: null };
  const acceptance = parts.slice(1).join("\n\n").trim();
  return { brief: (parts[0] || "").trim(), acceptance: acceptance || null };
}

export function parseDescription(description: string): { brief: string; acceptance: string } {
  const parts = description.split(/\n\nКритерии приёмки:\n/);
  const brief = (parts[0] || description).trim() || "Опишите ожидаемый результат.";
  const acceptance = (parts[1] || "Результат проверен и приложен файл.").trim();
  return { brief, acceptance };
}

type NamedActor = { id: string; name: string; role?: string; selection?: { providerId?: string; model?: string; reasoningLevel?: string } };

function actorLabel(row: Activity, agents: readonly NamedActor[]): string {
  const actor = row.actor;
  if (actor.kind === "agent") {
    const found = agents.find((agent) => agent.id === actor.agentId);
    return found ? found.name : actor.agentId;
  }
  if (actor.kind === "user") return "Вы";
  return "Система";
}

export function transitionTargetState(refs: Activity["references"]): string | null {
  const hit = refs.find((item) => item.type === "job_state" && item.id);
  return hit?.id ?? null;
}

export function activityEventText(row: Activity): string {
  if (row.kind === "comment" && row.comment) return row.comment;
  if (row.kind === "job_transitioned") {
    const to = transitionTargetState(row.references);
    if (!to) return humanActivityLabel(row.kind);
    if (UI_STATES.has(to as State)) return `Статус: ${stateNames[to as State]}`;
    return `Статус: ${to}`;
  }
  return row.comment || humanActivityLabel(row.kind);
}

export const ACTIVITY_KIND_LABEL: Record<string, string> = {
  job_created: "Задача создана",
  job_updated: "Задача обновлена",
  job_dependency_added: "Добавлена зависимость",
  job_transitioned: "Изменён статус",
  artifact_published: "Опубликован файл",
  artifact_accepted: "Результат принят",
  comment: "Комментарий",
};

export function humanActivityLabel(kind: string): string {
  return ACTIVITY_KIND_LABEL[kind] ?? kind.replaceAll("_", " ");
}

export function mapActivity(rows: Activity[], agents: readonly NamedActor[]): TaskActivity[] {
  return rows.map((row) => {
    const author = actorLabel(row, agents);
    const isComment = row.kind === "comment" && Boolean(row.comment);
    const actor = row.actor;
    const agent = actor.kind === "agent" ? agents.find((item) => item.id === actor.agentId) : undefined;
    return {
      id: row.id,
      kind: isComment ? "comment" : "event",
      text: activityEventText(row),
      at: row.timestamp,
      author,
      role: actor.kind === "agent" ? (agent?.role || "Сотрудник") : actor.kind === "user" ? "Участник" : undefined,
      providerId: agent?.selection?.providerId,
      model: agent?.selection?.model,
      reasoningEffort: agent?.selection?.reasoningLevel,
      fileIds: row.references.filter((item) => item.type === "artifact").map((item) => item.id),
      references: row.references.map((item) => ({ type: item.type, id: item.id })),
    };
  });
}

export function mapJobFiles(detail: Pick<JobDetail, "artifacts"> | { artifacts?: unknown }): TaskFile[] {
  return mapJobFilesFromArtifacts(detail.artifacts);
}

export function mapJobs(snapshot: WorkspaceSnapshot): Job[] {
  return snapshot.jobs.map((job) => {
    const department = snapshot.departments.find((item) => item.id === job.departmentId);
    const agent = job.assignedAgentId ? snapshot.agents.find((item) => item.id === job.assignedAgentId) : undefined;
    const binding = snapshot.bindings.find((item) => item.id === job.bindingId);
    return {
      id: job.key,
      recordId: job.id,
      revision: job.revision,
      bindingId: job.bindingId,
      departmentId: job.departmentId,
      assignedAgentId: job.assignedAgentId,
      reviewerAgentIds: job.reviewerAgentIds ?? [],
      observerAgentIds: job.observerAgentIds ?? [],
      updatedAt: job.updatedAt,
      title: job.title,
      state: asUiState(job.state),
      sourceState: job.state,
      project: binding?.bbProjectName || binding?.bbProjectId || "Проект",
      department: department?.name || job.departmentId,
      agent: agent?.name || "Не назначен",
      priority: PRIORITY_LABEL[job.priority],
      due: dueDate(job.dueAt),
      description: jobDescription(job),
      comments: [],
      parentId: job.parentJobId ? snapshot.jobs.find((item) => item.id === job.parentJobId)?.key : undefined,
    };
  });
}

export function mapAgents(snapshot: WorkspaceSnapshot): Agent[] {
  return snapshot.agents.map((agent) => {
    const version = snapshot.agentVersions.find((item) => item.id === agent.currentVersionId);
    const department = snapshot.memberships
      .filter((row) => row.agentId === agent.id)
      .map((row) => snapshot.departments.find((item) => item.id === row.departmentId)?.name)
      .find(Boolean);
    return {
      id: agent.id,
      recordId: agent.id,
      revision: agent.revision,
      name: agent.name,
      role: version?.role || "Роль уточняется в карточке",
      department: department || "",
      instructions: version?.instructions || "Задайте инструкции сотрудника.",
      skills: version?.skillIds ?? [],
      mcps: version?.mcpIds ?? [],
      selection: { providerId: version?.providerId || "codex", model: version?.model || "", reasoningLevel: "high" },
      permission: "auto",
      hostId: "",
      concurrency: 1,
      enabled: agent.state === "active",
    };
  });
}

export function mapDepartments(snapshot: WorkspaceSnapshot): Group[] {
  return snapshot.departments.map((department) => {
    const process = snapshot.processVersions.find((item) => item.id === department.processVersionId);
    return {
      id: department.id,
      recordId: department.id,
      revision: department.revision,
      name: department.name,
      description: process?.instructions || "Отдел агентства",
      lead: department.leadAgentId,
      members: snapshot.memberships.filter((row) => row.departmentId === department.id).map((row) => row.agentId),
      instructions: process?.instructions || "",
      acceptance: process?.acceptance,
      enabled: true,
    };
  });
}

export function mapProjects(snapshot: WorkspaceSnapshot): Group[] {
  return snapshot.bindings.map((binding) => {
    const departmentIds = snapshot.projectDepartments
      .filter((row) => row.bindingId === binding.id)
      .map((row) => row.departmentId);
    return {
      id: binding.id,
      recordId: binding.id,
      revision: binding.revision,
      bbProjectId: binding.bbProjectId,
      name: bindingPlacementLabel(binding),
      hostName: binding.hostName,
      description: binding.canonicalRoot,
      lead: "",
      members: departmentIds,
      instructions: "",
      enabled: true,
    };
  });
}

export function queueCounts(jobs: Job[], server?: WorkspaceSnapshot["counts"]): { total: number; attention: number; active: number; byState: Record<State, number> } {
  const byState = {
    backlog: 0,
    queued: 0,
    running: 0,
    review: 0,
    waiting_input: 0,
    blocked: 0,
    done: 0,
    canceled: 0,
  } satisfies Record<State, number>;
  if (server && Object.keys(server).length) {
    for (const state of Object.keys(byState) as State[]) {
      byState[state] = server[state] ?? 0;
    }
  } else {
    for (const job of jobs) byState[job.state] += 1;
  }
  return {
    total: Object.values(byState).reduce((sum, value) => sum + value, 0),
    attention: byState.review + byState.blocked + byState.waiting_input,
    active: byState.running,
    byState,
  };
}

/** Next visible job key from stored keys. Floor is 0 so AG-1 → AG-2, not demo AG-101. */
export function nextJobKey(keys: readonly string[]): string {
  const max = keys.reduce((current, key) => {
    const match = /^AG-(\d+)$/.exec(key);
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `AG-${max + 1}`;
}

export function countsMatchJobs(jobs: Job[], server: WorkspaceSnapshot["counts"]): boolean {
  const local = queueCounts(jobs);
  return (Object.keys(local.byState) as State[]).every((state) => (server[state] ?? 0) === local.byState[state]);
}
