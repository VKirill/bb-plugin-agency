import { tr } from "../i18n";
import { picksFromFallbackModels } from "./agent-fallbacks";
import { policySummary } from "./role-types";
import { charterPurpose } from "./charter";
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

/** The due date as the person picked it: the local calendar day of the instant. */
export function dueDate(dueAt: string | null): string {
  if (!dueAt) return "";
  const at = new Date(dueAt);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** A picked day is due at its local end: «до 18 сентября» includes the 18th. */
export function dueAtFromDate(due: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return null;
  const at = new Date(`${due}T23:59:00`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
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
  if (actor.kind === "user") return tr("Вы");
  return tr("Система");
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
    const label = UI_STATES.has(to as State) ? tr(stateNames[to as State]) : to;
    return tr("Статус: {state}", { state: label });
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
  return tr(ACTIVITY_KIND_LABEL[kind] ?? kind.replaceAll("_", " "));
}

/**
 * History rows for a card. `subtaskOf` marks the job the card shows: a row from another
 * job is a subtask comment, and the card labels it with that subtask's key.
 */
export function mapActivity(
  rows: Activity[],
  agents: readonly NamedActor[],
  subtaskOf?: { jobId: string | undefined; keyOf: (jobId: string) => string | undefined },
): TaskActivity[] {
  return rows.map((row) => {
    const foreign = subtaskOf && subtaskOf.jobId && row.jobId !== subtaskOf.jobId ? subtaskOf.keyOf(row.jobId) : undefined;
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
      role: actor.kind === "agent" ? (agent?.role || tr("Сотрудник")) : actor.kind === "user" ? tr("Участник") : undefined,
      providerId: agent?.selection?.providerId,
      model: agent?.selection?.model,
      reasoningEffort: agent?.selection?.reasoningLevel,
      fileIds: row.references.filter((item) => item.type === "artifact").map((item) => item.id),
      references: row.references.map((item) => ({ type: item.type, id: item.id })),
      ...(foreign ? { jobKey: foreign, jobId: row.jobId } : {}),
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
      project: binding?.bbProjectName || binding?.bbProjectId || tr("Проект"),
      department: department?.name || job.departmentId,
      agent: agent?.name || tr("Не назначен"),
      priority: PRIORITY_LABEL[job.priority],
      due: dueDate(job.dueAt),
      dueAt: job.dueAt,
      dueWindowHours: snapshot.dueReminderHours?.[job.departmentId],
      ...(job.contract ? { contract: job.contract } : {}),
      ...(snapshot.escalations?.[job.id] ? { escalatedToId: snapshot.escalations[job.id] } : {}),
      ...(snapshot.jobGoals?.[job.id] ? { goalId: snapshot.jobGoals[job.id] } : {}),
      ...(snapshot.launchQueue?.[job.id] ? { launchQueue: { position: snapshot.launchQueue[job.id].position, waitingReason: snapshot.launchQueue[job.id].waitingReason } } : {}),
      description: jobDescription(job),
      comments: [],
      parentId: job.parentJobId ? snapshot.jobs.find((item) => item.id === job.parentJobId)?.key : undefined,
      ...(job.closedAt ? { closedAt: job.closedAt } : {}),
    };
  });
}

export function mapAgents(snapshot: WorkspaceSnapshot): Agent[] {
  return snapshot.agents.map((agent) => {
    const version = snapshot.agentVersions.find((item) => item.id === agent.currentVersionId);
    const membership = snapshot.memberships.find((row) => row.agentId === agent.id);
    const policy = snapshot.policies.find((item) => item.id === version?.policyVersionId);
    const department = snapshot.memberships
      .filter((row) => row.agentId === agent.id)
      .map((row) => snapshot.departments.find((item) => item.id === row.departmentId)?.name)
      .find(Boolean);
    return {
      id: agent.id,
      recordId: agent.id,
      revision: agent.revision,
      name: agent.name,
      role: version?.role || tr("Должность уточняется в карточке"),
      department: department || "",
      ...(membership ? { roleType: membership.role } : {}),
      memberships: snapshot.memberships
        .filter((row) => row.agentId === agent.id)
        .map((row) => ({
          departmentId: row.departmentId,
          departmentName: snapshot.departments.find((item) => item.id === row.departmentId)?.name ?? row.departmentId,
          roleType: row.role,
        })),
      ...(policy ? { policySummary: policySummary(policy), policyVersionId: policy.id } : {}),
      liveJobs: snapshot.jobs.filter((job) => job.assignedAgentId === agent.id && (job.state === "running" || job.state === "waiting_input")).length,
      ...(version?.reasoningEffort ? { reasoningEffort: version.reasoningEffort } : {}),
      instructions: version?.instructions || "Задайте инструкции сотрудника.",
      skills: version?.skillIds ?? [],
      mcps: version?.mcpIds ?? [],
      plugins: version?.pluginIds ?? [],
      ...(agent.workplaceBindingId ? { workplaceBindingId: agent.workplaceBindingId } : {}),
      selection: {
        providerId: version?.providerId || "",
        model: version?.model || "",
        reasoningLevel: version?.reasoningEffort ?? "medium",
        ...(version?.serviceTier ? { serviceTier: version.serviceTier } : {}),
      },
      ...(version?.fallbackModels?.length ? { fallbackSelections: picksFromFallbackModels(version.fallbackModels) } : {}),
      permission: "auto",
      hostId: "",
      concurrency: 1,
      enabled: agent.state === "active",
      ...(agent.state === "archived" ? { archived: true } : {}),
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
      description: charterPurpose(process?.instructions) || tr("Отдел агентства"),
      lead: department.leadAgentId,
      members: snapshot.memberships.filter((row) => row.departmentId === department.id).map((row) => row.agentId),
      memberRoles: Object.fromEntries(
        snapshot.memberships
          .filter((row) => row.departmentId === department.id && (row.role === "reviewer" || row.role === "assistant"))
          .map((row) => [row.agentId, row.role as "reviewer" | "assistant"]),
      ),
      memberHelps: Object.fromEntries(
        snapshot.memberships
          .filter((row) => row.departmentId === department.id && row.role === "assistant" && row.helpsAgentId)
          .map((row) => [row.agentId, row.helpsAgentId!]),
      ),
      instructions: process?.instructions || "",
      acceptance: process?.acceptance,
      reviewRequired: process?.reviewPolicy.required ?? true,
      parentDepartmentId: snapshot.departmentParents?.[department.id] ?? null,
      enabled: true,
      ...(department.availability === "selected" ? { availability: "selected" as const } : {}),
      ...(department.archivedAt ? { archivedAt: department.archivedAt } : {}),
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
      bbProjectName: binding.bbProjectName,
      hostId: binding.hostId,
      environmentId: binding.environmentId,
      root: binding.canonicalRoot,
      environmentName: binding.environmentName,
      allowedProviders: snapshot.policies.find((policy) => policy.id === binding.policyVersionId)?.cliHostConstraints.providerIds ?? [],
      ...(binding.archivedAt ? { archivedAt: binding.archivedAt } : {}),
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
    attention: byState.blocked + byState.waiting_input,
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
