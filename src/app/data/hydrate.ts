import type { AgentVersion, Membership, ProcessVersion } from "../../shared/contracts";
import type { AgencyApi } from "./agency-api";
import type { BbCatalog } from "./store-commands";
import type { WorkspaceSnapshot } from "./snapshot";

export type WorkspaceDetails = {
  catalog: BbCatalog;
  agentVersions: Record<string, AgentVersion>;
  memberships: Record<string, Membership[]>;
  processes: Record<string, ProcessVersion | undefined>;
};

export const EMPTY_DETAILS: WorkspaceDetails = {
  catalog: { projects: [], environments: [], policies: [], skills: [], mcps: [], skillDiscovery: "unavailable", mcpDiscovery: "unavailable" },
  agentVersions: {},
  memberships: {},
  processes: {},
};

export async function loadWorkspaceDetails(api: AgencyApi, snapshot: WorkspaceSnapshot): Promise<WorkspaceDetails> {
  const catalog = await api.listBbCatalog();
  const agentVersions: Record<string, AgentVersion> = {};
  const memberships: Record<string, Membership[]> = {};
  const processes: Record<string, ProcessVersion | undefined> = {};
  await Promise.all(snapshot.agents.map(async (agent) => {
    const detail = await api.getAgent({ agentId: agent.id });
    if (detail.ok && detail.value.version) agentVersions[agent.id] = detail.value.version;
  }));
  await Promise.all(snapshot.departments.map(async (department) => {
    const detail = await api.getDepartment({ departmentId: department.id });
    if (!detail.ok) return;
    memberships[department.id] = detail.value.memberships;
    processes[department.id] = detail.value.process;
  }));
  return {
    catalog: catalog.ok ? catalog.value : EMPTY_DETAILS.catalog,
    agentVersions,
    memberships,
    processes,
  };
}

export function departmentsOfAgent(details: WorkspaceDetails, agentId: string): string[] {
  return Object.entries(details.memberships)
    .filter(([, rows]) => rows.some((row) => row.agentId === agentId))
    .map(([departmentId]) => departmentId);
}
