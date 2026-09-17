import { tr } from "../i18n";
import { JOB_CANCELED_LABEL, LAST_LAUNCH_UNACCEPTED, jobIsCanceled } from "./job-lifecycle";
import { launchStateLabel } from "./launch-rpc";

export const TEAM_UNASSIGNED = "Не назначены";
export const TEAM_UNASSIGNED_ONE = "Не назначен";
export const TEAM_ATTEMPT_UNKNOWN = "Не запущено";
export const TEAM_ATTEMPT_NONE = "Не запущено";
export const TEAM_ROLES_PENDING =
  "Поля проверяющих и наблюдателей сервер ещё не отдаёт. Запись из названия или описания не подставляется.";
export const TEAM_ATTEMPT_HINT = "Назначение и попытка — разные поля.";

export type JobTeamPerson = { id: string; name: string } | null;

export type JobTeamRoles = {
  reviewerIds: readonly string[];
  watcherIds: readonly string[];
};

export type AttemptStatus =
  | { kind: "unknown" }
  | { kind: "none" }
  | { kind: "state"; state: string };

export type JobTeamView = {
  project: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
  lead: JobTeamPerson;
  assigned: JobTeamPerson;
  reviewers: readonly { id: string; name: string }[];
  watchers: readonly { id: string; name: string }[];
  reviewersPending: boolean;
  watchersPending: boolean;
  attemptLabel: string;
  due: string | null;
  updatedAt: string | null;
};

type Named = { id: string; name: string };
type DepartmentRow = Named & { lead?: string };

export function emptyJobTeamRoles(): JobTeamRoles {
  return { reviewerIds: [], watcherIds: [] };
}

export function sameAgentIdList(left?: readonly string[], right?: readonly string[]): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function addTeamAgentId(current: readonly string[], id: string): string[] {
  if (!id || current.includes(id)) return [...current];
  return [...current, id];
}

export function removeTeamAgentId(current: readonly string[], id: string): string[] {
  return current.filter((item) => item !== id);
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/** Typed adapter only. Never reads title/brief/description. */
export function parseJobTeamRoles(input: unknown): JobTeamRoles {
  if (!input || typeof input !== "object") return emptyJobTeamRoles();
  const row = input as Record<string, unknown>;
  return {
    reviewerIds: idList(row.reviewerAgentIds ?? row.reviewerIds),
    watcherIds: idList(row.observerAgentIds ?? row.watcherIds ?? row.watcherAgentIds),
  };
}

export function exactNamed(rows: readonly Named[], id: string | null | undefined): JobTeamPerson {
  if (!id) return null;
  const row = rows.find((item) => item.id === id);
  return row ? { id: row.id, name: row.name } : { id, name: id };
}

export function attemptStatusEqual(left: AttemptStatus, right: AttemptStatus): boolean {
  if (left.kind === "state" && right.kind === "state") return left.state === right.state;
  return left.kind === right.kind;
}

export function attemptStatusLabel(status: AttemptStatus): string {
  if (status.kind === "unknown") return tr(TEAM_ATTEMPT_UNKNOWN);
  if (status.kind === "none") return tr(TEAM_ATTEMPT_NONE);
  return launchStateLabel(status.state);
}

export function currentWorkLabel(input: {
  job: { state?: string; sourceState?: string };
  assigned: JobTeamPerson;
  attemptLabel: string;
}): string {
  if (jobIsCanceled(input.job)) return tr(JOB_CANCELED_LABEL);
  if (input.attemptLabel === tr(TEAM_ATTEMPT_NONE) || !input.assigned) return input.attemptLabel;
  return `${input.assigned.name} · ${input.attemptLabel}`;
}

export function historicalAttemptNote(input: {
  job: { state?: string; sourceState?: string };
  assigned: JobTeamPerson;
  attempt?: AttemptStatus;
}): string | null {
  if (!jobIsCanceled(input.job) || input.attempt?.kind !== "state") return null;
  const state = attemptStatusLabel(input.attempt);
  const label = tr(LAST_LAUNCH_UNACCEPTED);
  return input.assigned ? `${label}: ${input.assigned.name} · ${state}` : `${label}: ${state}`;
}

export function provenDue(due: string | undefined): string | null {
  return due && /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null;
}

export function provenInstant(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  return value;
}

export function resolveJobTeam(input: {
  job: {
    bindingId?: string;
    departmentId?: string;
    assignedAgentId?: string | null;
    due?: string;
    updatedAt?: string;
    project?: string;
    department?: string;
    agent?: string;
  };
  projects: readonly Named[];
  departments: readonly DepartmentRow[];
  agents: readonly Named[];
  roles?: JobTeamRoles;
  attempt?: AttemptStatus;
  demoFallback?: boolean;
}): JobTeamView {
  const roles = input.roles ?? emptyJobTeamRoles();
  const department = exactNamed(input.departments, input.job.departmentId);
  const leadId = department
    ? input.departments.find((item) => item.id === department.id)?.lead
    : undefined;
  const assignedId = input.job.assignedAgentId ?? null;
  return {
    project: exactNamed(input.projects, input.job.bindingId) ?? (input.demoFallback && input.job.project
      ? { id: "", name: input.job.project }
      : null),
    department: department ?? (input.demoFallback && input.job.department
      ? { id: "", name: input.job.department }
      : null),
    lead: exactNamed(input.agents, leadId),
    assigned: assignedId
      ? exactNamed(input.agents, assignedId)
      : input.demoFallback && input.job.agent && input.job.agent !== TEAM_UNASSIGNED_ONE
        ? { id: "", name: input.job.agent }
        : null,
    reviewers: roles.reviewerIds.map((id) => exactNamed(input.agents, id)).filter((row): row is { id: string; name: string } => Boolean(row)),
    watchers: roles.watcherIds.map((id) => exactNamed(input.agents, id)).filter((row): row is { id: string; name: string } => Boolean(row)),
    reviewersPending: roles.reviewerIds.length === 0,
    watchersPending: roles.watcherIds.length === 0,
    attemptLabel: attemptStatusLabel(input.attempt ?? { kind: "unknown" }),
    due: provenDue(input.job.due),
    updatedAt: provenInstant(input.job.updatedAt),
  };
}
