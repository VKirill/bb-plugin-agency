import { tr } from "../i18n";
import type { Agent, Group } from "../prototype/data";

export function resolveAgent(agents: readonly Agent[], ref: string): Agent | undefined {
  return agents.find((agent) => agent.id === ref) ?? agents.find((agent) => agent.name === ref);
}

export function resolveDepartment(departments: readonly Group[], ref: string): Group | undefined {
  return departments.find((item) => item.id === ref) ?? departments.find((item) => item.name === ref);
}

export function agentLabel(agents: readonly Agent[], ref: string): string {
  return resolveAgent(agents, ref)?.name || ref || tr("Не назначен");
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

/** Fields of a department the page edits; the draft is dirty when any of them differs. */
export function departmentDraftDirty(
  baseline: { name: string; lead: string; members: readonly string[]; memberRoles?: Record<string, string>; instructions?: string; acceptance?: string; reviewRequired?: boolean },
  draft: { name: string; lead: string; members: readonly string[]; memberRoles?: Record<string, string>; instructions?: string; acceptance?: string; reviewRequired?: boolean },
): boolean {
  const roles = (value?: Record<string, string>) => JSON.stringify(Object.entries(value ?? {}).filter(([, role]) => role !== "executor").sort());
  return (
    baseline.name !== draft.name ||
    baseline.lead !== draft.lead ||
    JSON.stringify([...baseline.members].sort()) !== JSON.stringify([...draft.members].sort()) ||
    roles(baseline.memberRoles) !== roles(draft.memberRoles) ||
    (baseline.instructions ?? "") !== (draft.instructions ?? "") ||
    (baseline.acceptance ?? "") !== (draft.acceptance ?? "") ||
    (baseline.reviewRequired ?? true) !== (draft.reviewRequired ?? true)
  );
}
