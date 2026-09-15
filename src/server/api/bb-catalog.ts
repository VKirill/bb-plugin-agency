import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { fail, ok, type DomainResult } from "../../domain";
import { listStoredPolicies } from "./catalog";
import type { SqlDatabase } from "../db/sql";

export type BbProjectRow = { id: string; name: string };
export type BbHostRow = { id: string; name: string };
export type BbEnvironmentRow = {
  id: string;
  projectId: string;
  hostId: string;
  hostName: string;
  path: string;
  label: string;
};

export type BbPolicyRow = { id: string; label: string };

export type EnvironmentPlacement = {
  bbProjectId: string;
  environmentId: string;
  hostId: string;
  canonicalRoot: string;
  projectName: string;
  environmentName: string;
  hostName: string;
};

export type ProvisioningCatalog = {
  projects: BbProjectRow[];
  environments: BbEnvironmentRow[];
  hosts: BbHostRow[];
  policies: BbPolicyRow[];
};

async function listProjects(bb: BbPluginApi): Promise<DomainResult<BbProjectRow[]>> {
  try {
    const projects = await bb.sdk.projects.list();
    return ok(projects.map((project) => ({ id: project.id, name: project.name?.trim() || project.id })));
  } catch {
    return fail("bb_catalog_unavailable", "BB project catalog could not be read");
  }
}

async function listHosts(bb: BbPluginApi): Promise<DomainResult<BbHostRow[]>> {
  try {
    const hosts = await bb.sdk.hosts.list();
    return ok(hosts.map((host) => ({ id: host.id, name: host.name?.trim() || host.id })));
  } catch {
    return fail("bb_host_missing", "BB host catalog could not be read");
  }
}

export async function resolveEnvironmentPlacement(
  bb: BbPluginApi,
  environmentId: string,
): Promise<DomainResult<EnvironmentPlacement>> {
  const projects = await listProjects(bb);
  if (!projects.ok) return projects;
  const hosts = await listHosts(bb);
  if (!hosts.ok) return hosts;

  let environment: { id: string; projectId: string; hostId: string; path: string | null; name: string | null };
  try {
    environment = await bb.sdk.environments.get({ environmentId });
  } catch {
    return fail("bb_environment_missing", `BB environment ${environmentId} could not be read`);
  }

  const project = projects.value.find((item) => item.id === environment.projectId);
  if (!project) {
    return fail("bb_project_missing", `BB project ${environment.projectId} is not in the catalog`);
  }
  const host = hosts.value.find((item) => item.id === environment.hostId);
  if (!host) {
    return fail("bb_host_missing", `BB host ${environment.hostId} is not in the catalog`);
  }
  const canonicalRoot = environment.path?.trim() ?? "";
  if (!canonicalRoot) {
    return fail("untrusted_root", "BB environment has no path");
  }
  return ok({
    bbProjectId: environment.projectId,
    environmentId: environment.id,
    hostId: environment.hostId,
    canonicalRoot,
    projectName: project.name,
    environmentName: environment.name?.trim() || canonicalRoot,
    hostName: host.name,
  });
}

export function toBbCatalog(catalog: ProvisioningCatalog) {
  return {
    projects: catalog.projects,
    environments: catalog.environments,
    policies: catalog.policies,
  };
}

export async function loadProvisioningCatalog(bb: BbPluginApi, db: SqlDatabase): Promise<DomainResult<ProvisioningCatalog>> {
  const projects = await listProjects(bb);
  if (!projects.ok) return projects;
  const hosts = await listHosts(bb);
  if (!hosts.ok) return hosts;
  let environments: Array<{ id: string; projectId: string; hostId: string; path: string | null; name: string | null }>;
  try {
    environments = await bb.sdk.environments.list();
  } catch {
    return fail("bb_catalog_unavailable", "BB environment catalog could not be read");
  }
  const rows: BbEnvironmentRow[] = [];
  for (const environment of environments) {
    const project = projects.value.find((item) => item.id === environment.projectId);
    const host = hosts.value.find((item) => item.id === environment.hostId);
    const path = environment.path?.trim() ?? "";
    if (!project || !host || !path) continue;
    rows.push({
      id: environment.id,
      projectId: environment.projectId,
      hostId: environment.hostId,
      hostName: host.name,
      path,
      label: environment.name?.trim() || `${project.name} · ${host.name}`,
    });
  }
  return ok({
    projects: projects.value,
    environments: rows,
    hosts: hosts.value,
    policies: listStoredPolicies(db).map((policy) => ({
      id: policy.id,
      label: policy.allowedCapabilities[0] ? `Политика · ${policy.allowedCapabilities.join(", ")}` : `Политика ${policy.id}`,
    })),
  });
}

export function labelBinding(
  binding: {
    bbProjectId: string;
    environmentId: string;
    hostId: string;
  },
  catalog: ProvisioningCatalog | undefined,
): { bbProjectName: string; environmentName: string | null; hostName: string | null } {
  const project = catalog?.projects.find((item) => item.id === binding.bbProjectId);
  const environment = catalog?.environments.find((item) => item.id === binding.environmentId);
  const host = catalog?.hosts.find((item) => item.id === binding.hostId);
  return {
    bbProjectName: project?.name || binding.bbProjectId,
    environmentName: environment?.label ?? null,
    hostName: host?.name ?? null,
  };
}
