import { tr } from "../i18n";
import type { AgencyApi } from "./agency-api";
import { failureNotice, newRequestId } from "./persist";
import type { BbCatalog } from "./store-commands";
import type { MutationFailure, MutationOutcome } from "./envelope";
import type { Agent, Department, ProjectBinding } from "../../shared/contracts";
import { environmentPlacementLabel } from "./placement-label";
import { DEFAULT_PROVIDER_ID, samePolicyContent, standardAgentPolicy, standardBindingPolicy, type PolicyContent } from "./role-types";
import type { ReasoningEffort, ServiceTier } from "../../shared/contracts";

export { bindingPlacementLabel, environmentPlacementLabel } from "./placement-label";

export type CreateBindingInput = {
  bbProjectId: string;
  environmentId: string;
  hostId: string;
  canonicalRoot: string;
  policyVersionId: string;
};

export type CreateAgentInput = {
  name: string;
  /** Free-text job title. */
  role: string;
  instructions: string;
  providerId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** The provider's fast mode, present only for providers with service tiers. */
  serviceTier?: ServiceTier;
  policyVersionId?: string;
  /** Adds the new employee to a department with this role type. */
  departmentId?: string;
  roleType?: "executor" | "reviewer";
};

export type CreateDepartmentInput = {
  name: string;
  leadAgentId: string;
  instructions: string;
  acceptance: string;
  bindingId?: string;
  executorIds?: string[];
  reviewerIds?: string[];
};

type StoredPolicy = PolicyContent & { id: string };

/** An explicit policy wins; otherwise the standard one is reused when it already exists. */
async function resolvePolicy(
  api: AgencyApi,
  policyVersionId: string | undefined,
  standard: PolicyContent,
  existing: readonly StoredPolicy[] = [],
): Promise<MutationOutcome<string>> {
  if (policyVersionId) return { ok: true, value: policyVersionId };
  const same = existing.find((policy) => samePolicyContent(policy, standard));
  if (same) return { ok: true, value: same.id };
  const created = await api.createPolicyVersion({ requestId: newRequestId(), ...standard });
  if (!created.ok) return created;
  return { ok: true, value: created.value.id };
}

export async function persistCreateBinding(
  api: AgencyApi,
  input: CreateBindingInput,
  policies: readonly StoredPolicy[] = [],
): Promise<MutationOutcome<ProjectBinding>> {
  const policy = await resolvePolicy(api, input.policyVersionId || undefined, standardBindingPolicy(input.hostId), policies);
  if (!policy.ok) return policy;
  return api.createProjectBinding({
    requestId: newRequestId(),
    bbProjectId: input.bbProjectId,
    environmentId: input.environmentId,
    hostId: input.hostId,
    canonicalRoot: input.canonicalRoot,
    policyVersionId: policy.value,
    sectionId: null,
  });
}

export async function persistCreateAgent(
  api: AgencyApi,
  input: CreateAgentInput,
  policies: readonly StoredPolicy[] = [],
): Promise<MutationOutcome<{ agent: Agent }>> {
  const model = input.model?.trim();
  if (!model) {
    return { ok: false, failure: { kind: "domain", error: { code: "model_required", message: tr("Выберите модель сотрудника.") } } };
  }
  const providerId = input.providerId?.trim() || DEFAULT_PROVIDER_ID;
  const policy = await resolvePolicy(api, input.policyVersionId, standardAgentPolicy(), policies);
  if (!policy.ok) return policy;
  const created = await api.provisionAgent({
    requestId: newRequestId(),
    name: input.name.trim(),
    state: "active",
    version: {
      version: 1,
      role: input.role.trim(),
      instructions: input.instructions.trim(),
      // The CLI chosen in the form; never a silent fallback to another provider.
      providerId,
      model,
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
      skillIds: [],
      mcpIds: [],
      policyVersionId: policy.value,
    },
  });
  if (!created.ok) return created;
  if (input.departmentId) {
    const joined = await api.addMembership({
      requestId: newRequestId(),
      departmentId: input.departmentId,
      agentId: created.value.agent.id,
      role: input.roleType ?? "executor",
    });
    if (!joined.ok) return joined;
  }
  return { ok: true, value: { agent: created.value.agent } };
}

export async function persistCreateDepartment(
  api: AgencyApi,
  input: CreateDepartmentInput,
): Promise<MutationOutcome<{ department: Department }>> {
  const created = await api.provisionDepartment({
    requestId: newRequestId(),
    name: input.name.trim(),
    leadAgentId: input.leadAgentId,
    process: {
      instructions: input.instructions.trim(),
      acceptance: input.acceptance.trim(),
      reviewPolicy: { required: true },
    },
  });
  if (!created.ok) return created;
  const members: Array<[string, "executor" | "reviewer"]> = [
    ...(input.executorIds ?? []).map((id) => [id, "executor"] as [string, "executor"]),
    ...(input.reviewerIds ?? []).map((id) => [id, "reviewer"] as [string, "reviewer"]),
  ].filter(([id]) => id !== input.leadAgentId);
  for (const [agentId, role] of members) {
    const joined = await api.addMembership({ requestId: newRequestId(), departmentId: created.value.department.id, agentId, role });
    if (!joined.ok) return joined;
  }
  if (input.bindingId) {
    const linked = await api.linkDepartment({
      requestId: newRequestId(),
      bindingId: input.bindingId,
      departmentId: created.value.department.id,
    });
    if (!linked.ok && !(linked.failure.kind === "domain" && linked.failure.error.code === "duplicate_link")) {
      return linked;
    }
  }
  return { ok: true, value: { department: created.value.department } };
}

export const DEFAULT_CATALOG_POLICY = "default";

export const DEFAULT_BINDING_POLICY_HINT =
  "Стандартные права проекта: чтение и запись файлов в этой папке, запуск только на машине этой папки.";

export const DEFAULT_AGENT_POLICY_HINT =
  "Стандартные права сотрудника: чтение и запись файлов проекта, запуск через CLI из его профиля на машине проекта.";

export function isOrdinaryCatalogPolicy(policy: { label: string }): boolean {
  return policy.label.replace(/^Политика · /u, "").trim() === "read.files";
}

export function advancedCatalogPolicies(
  policies: readonly { id: string; label: string }[],
): { id: string; label: string }[] {
  return policies.filter((item) => !isOrdinaryCatalogPolicy(item));
}

export function policyVersionIdForCreate(policyId: string): string {
  return !policyId || policyId === DEFAULT_CATALOG_POLICY ? "" : policyId;
}

/** Folders already connected are left out; a disconnected one is marked, because it is restored rather than connected again. */
/** Without Projects & Sections a BB project connects one folder: its other folders are not offered. */
export function projectHasActiveFolder(
  projectId: string,
  bindings: readonly { bbProjectId?: string; archivedAt?: string }[],
): boolean {
  return bindings.some((binding) => !binding.archivedAt && binding.bbProjectId === projectId);
}

export function catalogEnvironmentOptions(
  catalog: BbCatalog,
  projectId: string,
  bindings: readonly { environmentId?: string; root?: string; archivedAt?: string; bbProjectId?: string }[] = [],
  oneFolderPerProject = false,
) {
  if (oneFolderPerProject && projectHasActiveFolder(projectId, bindings)) return [];
  return catalog.environments
    .filter((item) => item.projectId === projectId)
    .filter((item) => !bindings.some((binding) => !binding.archivedAt && binding.environmentId === item.id && binding.root === item.path))
    .map((item) => {
      const disconnected = bindings.some((binding) => binding.archivedAt && binding.environmentId === item.id && binding.root === item.path);
      return { value: item.id, label: `${environmentPlacementLabel(item)}${disconnected ? ` · ${tr("отключена, верните её в «Проекты»")}` : ""}` };
    });
}

export function createFailureMessage(failure: MutationFailure): string {
  return failureNotice(failure);
}
