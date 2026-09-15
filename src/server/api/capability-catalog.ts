import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { fail, ok, type DomainResult } from "../../domain";
import { assessIsolation } from "../runtime/isolation";
import { listStoredBindings } from "./catalog";
import type { SqlDatabase } from "../db/sql";

export type CapabilityRow = {
  id: string;
  label: string;
  source: string;
};

export type CapabilityCatalog = {
  skills: CapabilityRow[];
  mcps: CapabilityRow[];
  skillDiscovery: "sdk" | "unavailable";
  mcpDiscovery: "unavailable";
  isolation: {
    catalogSkillsIsolated: false;
    catalogMcpIsolated: false;
    execution: "unavailable";
    reason: string;
  };
};

export type CapabilityCatalogQuery = {
  bindingId?: string;
  projectId?: string;
  environmentId?: string | null;
};

function isolationNote() {
  return {
    catalogSkillsIsolated: false as const,
    catalogMcpIsolated: false as const,
    execution: "unavailable" as const,
    reason: assessIsolation().reason,
  };
}

export function emptyCapabilityCatalog(skillDiscovery: "sdk" | "unavailable" = "unavailable"): CapabilityCatalog {
  return {
    skills: [],
    mcps: [],
    skillDiscovery,
    mcpDiscovery: "unavailable",
    isolation: isolationNote(),
  };
}

async function resolveWorkspace(
  bb: BbPluginApi,
  db: SqlDatabase | undefined,
  query: CapabilityCatalogQuery,
): Promise<DomainResult<{ projectId: string; environmentId: string | null }>> {
  if (query.bindingId) {
    const binding = listStoredBindings(db!).find((row) => row.id === query.bindingId);
    if (!binding) return fail("not_found", `binding ${query.bindingId} not found`);
    return ok({ projectId: binding.bbProjectId, environmentId: binding.environmentId });
  }
  if (query.projectId) {
    return ok({ projectId: query.projectId, environmentId: query.environmentId ?? null });
  }
  try {
    const status = await bb.sdk.status.get();
    if (status.project?.id) {
      return ok({
        projectId: status.project.id,
        environmentId: query.environmentId !== undefined ? query.environmentId : status.thread?.environmentId ?? null,
      });
    }
  } catch {
    /* fall through to projects.list */
  }
  try {
    const projects = await bb.sdk.projects.list();
    const projectId = projects[0]?.id;
    if (!projectId) return fail("bb_project_missing", "BB project catalog is empty");
    return ok({ projectId, environmentId: query.environmentId ?? null });
  } catch {
    return fail("bb_catalog_unavailable", "BB project catalog could not be read");
  }
}

export async function loadCapabilityCatalog(
  bb: BbPluginApi,
  query: CapabilityCatalogQuery = {},
  db?: SqlDatabase,
): Promise<DomainResult<CapabilityCatalog>> {
  const workspace = await resolveWorkspace(bb, db, query);
  if (!workspace.ok) return workspace;
  try {
    const listed = await bb.sdk.skills.list({
      projectId: workspace.value.projectId,
      environmentId: workspace.value.environmentId,
    });
    const skills = listed.skills.map((skill) => ({
      id: skill.id,
      label: skill.name?.trim() || skill.id,
      source: skill.pluginId ? `plugin:${skill.pluginId}` : skill.scope,
    }));
    return ok({
      skills,
      mcps: [],
      skillDiscovery: "sdk",
      mcpDiscovery: "unavailable",
      isolation: isolationNote(),
    });
  } catch {
    return fail("capability_catalog_unavailable", "BB skill catalog could not be read");
  }
}
