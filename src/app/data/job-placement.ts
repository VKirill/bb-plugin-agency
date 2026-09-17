import { tr } from "../i18n";

/** availability is set for departments only; omitted means the department is open to all projects. */
export type NamedPlacement = { id: string; name: string; availability?: "all" | "selected" };
export type ProjectDepartmentLink = { bindingId: string; departmentId: string };

export const JOB_CREATE_HINT = "Поручение отделу: что сделать, как проверить результат и кто отвечает. Задача создаётся в бэклоге, запуск — из её карточки.";
export const JOB_CREATE_NO_DEPARTMENTS =
  "Для выбранного проекта нет доступных отделов. Создайте отдел или откройте доступ отдела к этому проекту.";

export function resolveDepartmentId(
  departments: readonly NamedPlacement[],
  token: string,
): string | null {
  return departments.find((item) => item.id === token || item.name === token)?.id ?? null;
}

export function linksForProject(
  bindingId: string,
  memberTokens: readonly string[],
  departments: readonly NamedPlacement[],
): ProjectDepartmentLink[] {
  return memberTokens
    .map((token) => resolveDepartmentId(departments, token))
    .filter((departmentId): departmentId is string => Boolean(departmentId))
    .map((departmentId) => ({ bindingId, departmentId }));
}

export function linksFromProjects(
  projects: readonly { id: string; members: readonly string[] }[],
  departments: readonly NamedPlacement[],
): ProjectDepartmentLink[] {
  return projects.flatMap((project) => linksForProject(project.id, project.members, departments));
}

export function departmentsForBinding(
  departments: readonly NamedPlacement[],
  links: readonly ProjectDepartmentLink[],
  bindingId: string,
): NamedPlacement[] {
  if (!bindingId) return [];
  const allowed = new Set(
    links.filter((row) => row.bindingId === bindingId).map((row) => row.departmentId),
  );
  return departments.filter((item) => item.availability !== "selected" || allowed.has(item.id));
}

export function sanitizeDepartmentId(
  departmentId: string,
  allowed: readonly NamedPlacement[],
): string {
  return allowed.some((item) => item.id === departmentId) ? departmentId : "";
}

export const UNASSIGNED_AGENT = "unassigned";

export function selectedBindingId(
  job: { bindingId?: string; project: string },
  projects: readonly NamedPlacement[],
): string {
  if (job.bindingId && projects.some((item) => item.id === job.bindingId)) return job.bindingId;
  return projects.find((item) => item.id === job.project || item.name === job.project)?.id || "";
}

export function selectedDepartmentId(
  job: { departmentId?: string; department: string },
  departments: readonly NamedPlacement[],
): string {
  if (job.departmentId && departments.some((item) => item.id === job.departmentId)) return job.departmentId;
  return resolveDepartmentId(departments, job.department) || "";
}

export function selectedAgentId(
  job: { assignedAgentId?: string | null; agent: string },
  agents: readonly NamedPlacement[],
): string {
  if (job.assignedAgentId && agents.some((item) => item.id === job.assignedAgentId)) return job.assignedAgentId;
  return agents.find((item) => item.id === job.agent || item.name === job.agent)?.id || UNASSIGNED_AGENT;
}

export function canConfirmPlacement(
  bindingId: string,
  departmentId: string,
  links: readonly ProjectDepartmentLink[],
  departments: readonly NamedPlacement[] = [],
): boolean {
  if (!bindingId || !departmentId) return false;
  const department = departments.find((item) => item.id === departmentId);
  if (department && department.availability !== "selected") return true;
  return links.some((row) => row.bindingId === bindingId && row.departmentId === departmentId);
}

export function placementFields(
  bindingId: string,
  departmentId: string,
  projects: readonly NamedPlacement[],
  departments: readonly NamedPlacement[],
): { bindingId: string; departmentId: string; project: string; department: string } | null {
  const project = projects.find((item) => item.id === bindingId);
  const department = departments.find((item) => item.id === departmentId);
  if (!project || !department) return null;
  return { bindingId, departmentId, project: project.name, department: department.name };
}

export function assigneeFields(
  agentId: string | null,
  agents: readonly NamedPlacement[],
): { assignedAgentId: string | null; agent: string } {
  if (!agentId || agentId === UNASSIGNED_AGENT) return { assignedAgentId: null, agent: "Не назначен" };
  const agent = agents.find((item) => item.id === agentId);
  return { assignedAgentId: agentId, agent: agent?.name || "Не назначен" };
}

export const JOB_ASSIGNEE_EMPTY_DEPARTMENT =
  "В этом отделе нет сотрудников. Назначить можно только тех, кто входит в состав отдела.";

export type AssigneeCatalogAgent = NamedPlacement & {
  role?: string;
  selection?: { providerId?: string };
};

export type DepartmentMembership = {
  id: string;
  members?: readonly string[];
  lead?: string;
  memberRoles?: Readonly<Record<string, string>>;
};

export function membershipRoleLabel(role: string): string {
  if (role === "lead") return tr("руководитель");
  if (role === "reviewer") return tr("проверяющий");
  if (role === "executor" || role === "member") return tr("исполнитель");
  return role;
}

function providerContext(providerId: string | undefined): string {
  if (!providerId?.trim()) return "";
  if (providerId === "claude-code") return "Claude";
  if (providerId === "codex") return "Codex";
  return providerId;
}

export function assigneesForDepartment(
  departmentId: string | undefined,
  departments: readonly DepartmentMembership[],
  agents: readonly AssigneeCatalogAgent[],
): AssigneeCatalogAgent[] {
  if (!departmentId) return [];
  const department = departments.find((item) => item.id === departmentId);
  if (!department) return [];
  const allowed = new Set((department.members ?? []).filter((id) => typeof id === "string" && id.length > 0));
  return agents.filter((agent) => allowed.has(agent.id));
}

export function assigneeMembershipRole(
  agentId: string,
  department: DepartmentMembership | undefined,
): string {
  if (!department) return "executor";
  if (department.lead === agentId) return "lead";
  return department.memberRoles?.[agentId] === "reviewer" ? "reviewer" : "executor";
}

export function assigneeOptionLabel(
  agent: AssigneeCatalogAgent,
  membershipRole: string,
): string {
  const profileRole = agent.role?.trim() && agent.role !== "Роль уточняется в карточке" ? agent.role : "";
  const role = profileRole || membershipRoleLabel(membershipRole);
  const context = providerContext(agent.selection?.providerId);
  return [agent.name, role, context].filter(Boolean).join(" · ");
}

export function assigneeChoiceOptions(
  departmentId: string | undefined,
  departments: readonly DepartmentMembership[],
  agents: readonly AssigneeCatalogAgent[],
  currentAssignedId?: string | null,
): { value: string; label: string }[] {
  const members = assigneesForDepartment(departmentId, departments, agents);
  const department = departments.find((item) => item.id === departmentId);
  const seen = new Map<string, number>();
  const options = members.map((agent) => {
    const base = assigneeOptionLabel(agent, assigneeMembershipRole(agent.id, department));
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { value: agent.id, label: base, base };
  });
  const labeled = options.map((item) => {
    if ((seen.get(item.base) ?? 0) < 2) return { value: item.value, label: item.label };
    return { value: item.value, label: `${item.label} · ${item.value.slice(-6)}` };
  });
  const choices = [{ value: UNASSIGNED_AGENT, label: "Не назначен" }, ...labeled];
  if (
    currentAssignedId &&
    currentAssignedId !== UNASSIGNED_AGENT &&
    !labeled.some((item) => item.value === currentAssignedId)
  ) {
    const stray = agents.find((item) => item.id === currentAssignedId);
    choices.splice(1, 0, {
      value: currentAssignedId,
      label: `${stray?.name || tr("Сотрудник")} · ${tr("не в этом отделе")}`,
    });
  }
  return choices;
}
