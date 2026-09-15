import type { AgencyApi } from "./agency-api";
import { failureNotice, newRequestId } from "./persist";
import type { BbCatalog } from "./store-commands";
import type { MutationFailure, MutationOutcome } from "./envelope";
import type { Agent, Department, ProjectBinding } from "../../shared/contracts";
import { environmentPlacementLabel } from "./placement-label";

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
  role: string;
  instructions: string;
  providerId?: string;
  model?: string;
  policyVersionId?: string;
};

export type CreateDepartmentInput = {
  name: string;
  leadAgentId: string;
  instructions: string;
  acceptance: string;
  bindingId?: string;
};

async function resolvePolicy(api: AgencyApi, policyVersionId?: string): Promise<MutationOutcome<string>> {
  if (policyVersionId) return { ok: true, value: policyVersionId };
  const created = await api.createPolicyVersion({
    requestId: newRequestId(),
    allowedCapabilities: ["read.files"],
    cliHostConstraints: { providerIds: [], hostIds: [] },
    secretRefs: [],
  });
  if (!created.ok) return created;
  return { ok: true, value: created.value.id };
}

export async function persistCreateBinding(
  api: AgencyApi,
  input: CreateBindingInput,
): Promise<MutationOutcome<ProjectBinding>> {
  const policy = await resolvePolicy(api, input.policyVersionId || undefined);
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
): Promise<MutationOutcome<{ agent: Agent }>> {
  const policy = await resolvePolicy(api, input.policyVersionId);
  if (!policy.ok) return policy;
  const created = await api.provisionAgent({
    requestId: newRequestId(),
    name: input.name.trim(),
    state: "active",
    version: {
      version: 1,
      role: input.role.trim(),
      instructions: input.instructions.trim(),
      providerId: input.providerId?.trim() || "codex",
      model: input.model?.trim() || "default",
      skillIds: [],
      mcpIds: [],
      policyVersionId: policy.value,
    },
  });
  if (!created.ok) return created;
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
  "Обычная привязка записывает в каталог ограничение «чтение файлов проекта». Это не включает исполнение и не проверяет доступ на машине.";

export const DEFAULT_AGENT_POLICY_HINT =
  "Обычный профиль записывает в каталог ограничение «чтение файлов». Это не включает исполнение и не проверяет доступ на машине.";

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

export function catalogEnvironmentOptions(catalog: BbCatalog, projectId: string) {
  return catalog.environments
    .filter((item) => item.projectId === projectId)
    .map((item) => ({ value: item.id, label: environmentPlacementLabel(item) }));
}

export function createFailureMessage(failure: MutationFailure): string {
  return failureNotice(failure);
}
