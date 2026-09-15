import type { Agent, Group } from "../prototype/data";

export function resolveAgent(agents: readonly Agent[], ref: string): Agent | undefined {
  return agents.find((agent) => agent.id === ref) ?? agents.find((agent) => agent.name === ref);
}

export function resolveDepartment(departments: readonly Group[], ref: string): Group | undefined {
  return departments.find((item) => item.id === ref) ?? departments.find((item) => item.name === ref);
}

export function agentLabel(agents: readonly Agent[], ref: string): string {
  return resolveAgent(agents, ref)?.name || ref || "Не назначен";
}

export function departmentLabel(departments: readonly Group[], ref: string): string {
  return resolveDepartment(departments, ref)?.name || ref;
}

export function usesCatalogIds(group: Group, agents: readonly Agent[], departments: readonly Group[]): boolean {
  if (group.recordId) return true;
  if (group.lead && agents.some((agent) => agent.id === group.lead)) return true;
  return group.members.some(
    (ref) => agents.some((agent) => agent.id === ref) || departments.some((item) => item.id === ref),
  );
}
