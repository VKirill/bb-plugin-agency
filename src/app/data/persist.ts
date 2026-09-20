import { tr } from "../i18n";
import { CONTRACT_PARTS, optionalFallbackModels, type JobState } from "../../shared/contracts";
import { fallbackModelsFromPicks, fallbackProblems, type FallbackProblem } from "./agent-fallbacks";
import type { Agent, Group, Job, TaskFile } from "../prototype/data";
import type { AgencyApi } from "./agency-api";
import { asRelativePath, bytesToBase64, fileBytes, isOpaqueRecordId, mimeOf, sha256Hex } from "./content-hash";
import type { OpenArtifactResult } from "./store-commands";
import { conflictMessage, type MutationFailure, type MutationOutcome } from "./envelope";
import type { ArtifactVersion } from "../../shared/contracts";
import { jobNeedsServerPatch } from "./job-record-patch";
import { jobPersistStatusRefusal } from "./job-lifecycle";
import { dueAtFromDate, dueDate, parseDescription, PRIORITY_CODE, splitDescription } from "./view-models";
import type { WorkspaceSnapshot } from "./snapshot";
import { unsupportedAgentFieldChanges, unsupportedAgentSaveMessage } from "./agent-profile-fields";
import { DEFAULT_PROVIDER_ID, policyForAnyCli, policyWithProvider, samePolicyContent, type PolicyContent } from "./role-types";
import type { ProjectBinding } from "../../shared/contracts";
import { productDomainNotice, productServerReason } from "./product-reasons";

export function newRequestId(): string {
  return crypto.randomUUID();
}

export const BRIEF_REQUIRED_NOTICE = "Заполните «Что нужно сделать» и «Критерии приёмки»: без них сотрудник не поймёт задачу, а вы не сможете её принять.";

const DOMAIN_NOTICE: Record<string, string> = {
  assignee_required: "Сначала назначьте исполнителя из состава этого отдела.",
  assignee_not_member:
    "Исполнитель должен состоять в выбранном отделе. Выберите сотрудника из состава отдела.",
  job_has_children:
    "У задачи есть подзадачи в этом проекте. Перенос в другой проект пока недоступен — файлы и связи не мигрируются.",
  job_has_dependencies:
    "У задачи есть зависимости в этом проекте. Перенос в другой проект пока недоступен.",
  job_has_artifacts:
    "У задачи есть файлы в текущем корне проекта. Перенос не копирует файлы молча.",
  job_has_run: "Задача в работе или привязана к запуску. Сначала завершите или отмените запуск.",
  binding_move_blocked:
    "Подзадачу нельзя перенести в другой проект отдельно от родителя. Перенос файлов не выполняется.",
  unlink_unsupported: "Снять отдел с проекта пока нельзя. Отдел остаётся подключённым к этой папке.",
  binding_archived: "Проект отключён от Агентства: новые задачи, отделы и запуски в нём недоступны. Верните проект в его карточке.",
  binding_duplicate: "Эта папка уже подключена к Агентству. Откройте существующий проект вместо нового подключения.",
  binding_in_use: "У проекта есть задачи или файлы, поэтому удалить его нельзя. Отключите проект: история сохранится.",
  self_review: "Проверяющий не может проверять работу, которую сделал сам. Назначьте другого проверяющего.",
  department_in_use: "У отдела есть открытые задачи в этом проекте. Завершите или перенесите их, затем меняйте доступ.",
  department_not_on_binding: "Отдел ограничен выбранными проектами и не подключён к этому. Подключите его в карточке проекта.",
  versions_changed: "Процесс или текст задачи изменились. Обновите карточку и ответьте на текущий запрос.",
  snapshot_stale: "Снимок запуска устарел. Ответ с этим digest не принимается.",
  request_conflict: "Этот ответ уже привязан к другому запросу или wait. Старый request новый цикл не закрывает.",
  team_agent_not_member:
    "Проверяющий и наблюдатель должны состоять в отделе этой задачи.",
  illegal_transition: "Сейчас это действие недоступно.",
  capability_unavailable: "Задачу из этого правила сейчас запустить нельзя.",
  dependency_cycle: "Так задачи ждали бы друг друга по кругу. Уберите встречную зависимость.",
  duplicate_dependency: "Эта зависимость уже есть.",
  binding_mismatch: "Задача может ждать только задачу из той же папки или из того же дерева задач.",
  next_step_done: "Следующий шаг уже выполнен и не меняется.",
  job_closed: "Задача закрыта: следующий шаг не задаётся.",
};

export function failureNotice(failure: MutationFailure): string {
  if (failure.kind === "revision_conflict") return conflictMessage(failure.conflict);
  if (failure.kind === "domain") {
    const notice = DOMAIN_NOTICE[failure.error.code];
    return notice ? tr(notice) : productDomainNotice(failure.error.code, failure.error.message);
  }
  return productServerReason(failure.message);
}

function requireExactId(
  rows: readonly { id: string }[],
  token: string,
  message: string,
): { ok: true; id: string } | { ok: false; failure: MutationFailure } {
  if (!token.trim()) {
    return { ok: false, failure: { kind: "domain", error: { code: "invalid_command", message } } };
  }
  const row = rows.find((item) => item.id === token);
  if (!row) {
    return { ok: false, failure: { kind: "domain", error: { code: "not_found", message } } };
  }
  return { ok: true, id: row.id };
}

function draftRevisionConflict(expected: number | undefined, actual: number): MutationFailure | null {
  if (expected === undefined) {
    return { kind: "domain", error: { code: "invalid_command", message: tr("Нет ревизии черновика.") } };
  }
  if (expected !== actual) {
    return {
      kind: "revision_conflict",
      conflict: {
        code: "revision_conflict",
        expectedRevision: expected,
        actualRevision: actual,
        requestId: newRequestId(),
      },
    };
  }
  return null;
}

export async function persistJobPatch(
  api: AgencyApi,
  snapshot: WorkspaceSnapshot,
  current: Job,
  next: Job,
): Promise<{ ok: true } | { ok: false; failure: MutationFailure }> {
  const record = snapshot.jobs.find((job) => job.id === current.recordId || job.key === current.id);
  if (!record) return { ok: false, failure: { kind: "domain", error: { code: "not_found", message: tr("Задача не найдена на сервере.") } } };
  if (!jobNeedsServerPatch(current, next)) return { ok: true };
  const statusChanged = next.state !== current.state;
  if (statusChanged) {
    const refusal = jobPersistStatusRefusal(current, next.state);
    if (refusal) return { ok: false, failure: { kind: "domain", error: { code: "lifecycle_guard", message: refusal } } };
  }
  // Field edits first, then the status on the new revision: one dialog save keeps both.
  let revision = record.revision;
  if (jobNeedsServerPatch(current, { ...next, state: current.state })) {
    const updated = await persistJobFields(api, snapshot, record, current, next);
    if (!updated.ok) return updated;
    revision = updated.revision;
  }
  if (statusChanged) {
    const result = await api.transitionJob({
      requestId: newRequestId(),
      expectedRevision: revision,
      jobId: record.id,
      to: next.state as JobState,
    });
    return result.ok ? { ok: true } : result;
  }
  return { ok: true };
}

async function persistJobFields(
  api: AgencyApi,
  snapshot: WorkspaceSnapshot,
  record: WorkspaceSnapshot["jobs"][number],
  current: Job,
  next: Job,
): Promise<{ ok: true; revision: number } | { ok: false; failure: MutationFailure }> {
  const written = splitDescription(next.description);
  if (!written.brief.trim() || !written.acceptance?.trim()) {
    return { ok: false, failure: { kind: "domain", error: { code: "brief_required", message: BRIEF_REQUIRED_NOTICE } } };
  }
  const parsed = parseDescription(next.description);
  const assigned = next.assignedAgentId === undefined
    ? snapshot.agents.find((agent) => agent.name === next.agent)?.id ?? record.assignedAgentId
    : next.assignedAgentId;
  const bindingId =
    next.bindingId ||
    snapshot.bindings.find((binding) => binding.bbProjectName === next.project || binding.bbProjectId === next.project)?.id;
  const departmentId =
    next.departmentId || snapshot.departments.find((item) => item.name === next.department || item.id === next.department)?.id;
  if ((next.bindingId || next.department || next.project) && (!bindingId || !departmentId)) {
    return { ok: false, failure: { kind: "domain", error: { code: "placement_required", message: tr("Укажите проект и отдел из каталога. Первый в списке не подставляется.") } } };
  }
  const restricted = snapshot.departments.find((item) => item.id === departmentId)?.availability === "selected";
  if (bindingId && departmentId && restricted && !snapshot.projectDepartments.some((row) => row.bindingId === bindingId && row.departmentId === departmentId)) {
    return { ok: false, failure: { kind: "domain", error: { code: "department_not_on_binding", message: tr("Отдел не привязан к этому проекту.") } } };
  }
  if (bindingId && bindingId !== record.bindingId) {
    if (record.parentJobId) {
      return {
        ok: false,
        failure: {
          kind: "domain",
          error: { code: "binding_move_blocked", message: DOMAIN_NOTICE.binding_move_blocked },
        },
      };
    }
    if (snapshot.jobs.some((job) => job.parentJobId === record.id)) {
      return {
        ok: false,
        failure: { kind: "domain", error: { code: "job_has_children", message: DOMAIN_NOTICE.job_has_children } },
      };
    }
    if (record.state === "queued" || record.state === "running" || record.state === "waiting_input") {
      return { ok: false, failure: { kind: "domain", error: { code: "job_has_run", message: DOMAIN_NOTICE.job_has_run } } };
    }
  }
  const reviewerAgentIds = [...(next.reviewerAgentIds ?? current.reviewerAgentIds ?? [])];
  const observerAgentIds = [...(next.observerAgentIds ?? current.observerAgentIds ?? [])];
  const teamChanged =
    JSON.stringify(reviewerAgentIds) !== JSON.stringify([...(current.reviewerAgentIds ?? [])]) ||
    JSON.stringify(observerAgentIds) !== JSON.stringify([...(current.observerAgentIds ?? [])]);
  if (teamChanged) {
    const scopedDepartmentId = departmentId || record.departmentId;
    const members = new Set(
      snapshot.memberships
        .filter((row) => row.departmentId === scopedDepartmentId)
        .map((row) => row.agentId),
    );
    for (const id of [...reviewerAgentIds, ...observerAgentIds]) {
      if (!members.has(id)) {
        return {
          ok: false,
          failure: { kind: "domain", error: { code: "team_agent_not_member", message: DOMAIN_NOTICE.team_agent_not_member } },
        };
      }
    }
  }
  const result = await api.updateJob({
    requestId: newRequestId(),
    expectedRevision: record.revision,
    jobId: record.id,
    title: next.title,
    brief: parsed.brief,
    acceptance: parsed.acceptance,
    bindingId,
    departmentId,
    assignedAgentId: assigned ?? null,
    ...(teamChanged ? { reviewerAgentIds, observerAgentIds } : {}),
    priority: PRIORITY_CODE[next.priority] || record.priority,
    // An untouched date keeps its exact instant; only a picked day is converted.
    dueAt: next.due === dueDate(record.dueAt) ? record.dueAt : dueAtFromDate(next.due),
    ...(sameContract(next.contract, record.contract) ? {} : { contract: next.contract ?? null }),
  });
  return result.ok ? { ok: true, revision: result.value.revision } : result;
}

export async function persistAgentPatch(
  api: AgencyApi,
  snapshot: WorkspaceSnapshot,
  current: Agent,
  next: Agent,
): Promise<{ ok: true } | { ok: false; failure: MutationFailure }> {
  const leaked = unsupportedAgentFieldChanges(current, next);
  if (leaked.length) {
    return { ok: false, failure: { kind: "domain", error: { code: "invalid_command", message: unsupportedAgentSaveMessage(leaked) } } };
  }
  const record = snapshot.agents.find((agent) => agent.id === current.id);
  if (!record) return { ok: false, failure: { kind: "domain", error: { code: "not_found", message: tr("Сотрудник не найден на сервере.") } } };
  const stale = draftRevisionConflict(next.revision, record.revision);
  if (stale) return { ok: false, failure: stale };
  const currentVersion = snapshot.agentVersions.find((item) => item.id === record.currentVersionId);
  const chosenPolicyId =
    (next.policyVersionId && snapshot.policies.some((policy) => policy.id === next.policyVersionId) ? next.policyVersionId : undefined) ||
    currentVersion?.policyVersionId;
  if (!chosenPolicyId) {
    return { ok: false, failure: { kind: "domain", error: { code: "not_found", message: tr("Нет политики для версии профиля.") } } };
  }
  const named = next.role.trim() || currentVersion?.role || "Роль";
  const instructions = next.instructions.trim() || currentVersion?.instructions || "Задайте инструкции сотрудника.";
  const providerId = next.selection.providerId.trim() || currentVersion?.providerId || DEFAULT_PROVIDER_ID;
  const primaryModel = next.selection.model.trim() || currentVersion?.model || "";
  // The list goes to the server as the owner built it: a wrong row is named here, never dropped in silence.
  const picks = next.fallbackSelections ?? [];
  const problem = fallbackProblems({ providerId, model: primaryModel }, picks)[0];
  if (problem) {
    return { ok: false, failure: { kind: "domain", error: { code: "invalid_command", message: fallbackProblemText(problem) } } };
  }
  const reserves = fallbackModelsFromPicks(picks);
  // The owner picked this CLI: a policy that lists other CLIs (older ones name only Claude Code) gets it added.
  const chosenPolicy = snapshot.policies.find((policy) => policy.id === chosenPolicyId);
  let widened = chosenPolicy ? policyWithProvider(chosenPolicy, providerId) : null;
  for (const reserve of reserves) {
    const base = widened ?? chosenPolicy;
    const extra = base ? policyWithProvider(base, reserve.providerId) : null;
    if (extra) widened = extra;
  }
  let policyVersionId = chosenPolicyId;
  if (widened) {
    const resolved = await resolvePolicyContent(api, snapshot, widened);
    if (!resolved.ok) return resolved;
    policyVersionId = resolved.value;
  }
  const model = next.selection.model.trim() || currentVersion?.model;
  if (!model) {
    return { ok: false, failure: { kind: "domain", error: { code: "model_required", message: tr("Выберите модель сотрудника.") } } };
  }
  const result = await api.saveAgentProfile({
    requestId: newRequestId(),
    expectedRevision: next.revision!,
    agentId: record.id,
    name: next.name,
    state: next.archived ? "archived" : next.enabled ? "active" : "paused",
    workplaceBindingId: next.workplaceBindingId ?? null,
    version: {
      version: (currentVersion?.version ?? 0) + 1,
      role: named,
      instructions,
      providerId,
      model,
      ...(next.reasoningEffort ? { reasoningEffort: next.reasoningEffort } : {}),
      ...(next.selection.serviceTier ? { serviceTier: next.selection.serviceTier } : {}),
      skillIds: next.skills.map((item) => item.trim()).filter(Boolean),
      mcpIds: next.mcps.map((item) => item.trim()).filter(Boolean),
      pluginIds: (next.plugins ?? []).map((item) => item.trim()).filter(Boolean),
      policyVersionId,
      ...optionalFallbackModels(reserves),
    },
  });
  return result.ok ? { ok: true } : result;
}

export async function persistDepartmentPatch(
  api: AgencyApi,
  snapshot: WorkspaceSnapshot,
  current: Group,
  next: Group,
): Promise<{ ok: true } | { ok: false; failure: MutationFailure }> {
  const record = snapshot.departments.find((item) => item.id === current.id);
  if (!record) return { ok: false, failure: { kind: "domain", error: { code: "not_found", message: tr("Отдел не найден на сервере.") } } };
  const stale = draftRevisionConflict(next.revision, record.revision);
  if (stale) return { ok: false, failure: stale };
  const lead = requireExactId(snapshot.agents, next.lead, tr("Руководитель отдела должен быть выбран из каталога по идентификатору."));
  if (!lead.ok) return lead;
  const wantedIds: string[] = [];
  for (const token of next.members) {
    const member = requireExactId(snapshot.agents, token, tr("В составе отдела есть неизвестный сотрудник. Имя не подставляется."));
    if (!member.ok) return member;
    if (!wantedIds.includes(member.id)) wantedIds.push(member.id);
  }
  if (!wantedIds.includes(lead.id)) wantedIds.unshift(lead.id);
  const currentProcess = snapshot.processVersions.find((item) => item.id === record.processVersionId);
  const reviewRequired = next.reviewRequired ?? currentProcess?.reviewPolicy.required ?? true;
  const processChanged =
    Boolean(next.instructions || next.acceptance) &&
    (next.instructions !== currentProcess?.instructions ||
      next.acceptance !== currentProcess?.acceptance ||
      reviewRequired !== (currentProcess?.reviewPolicy.required ?? true));
  const result = await api.saveDepartmentProfile({
    requestId: newRequestId(),
    expectedRevision: next.revision!,
    departmentId: record.id,
    name: next.name,
    leadAgentId: lead.id,
    ...(processChanged
      ? {
          process: {
            instructions: (next.instructions || currentProcess?.instructions || "Опишите процесс.").trim(),
            acceptance: (next.acceptance || currentProcess?.acceptance || "Результат проверен.").trim(),
            reviewPolicy: { required: reviewRequired },
          },
        }
      : {}),
    memberships: wantedIds.map((agentId) => {
      const role = agentId === lead.id ? "lead" : (next.memberRoles?.[agentId] ?? "executor");
      // Who an assistant helps travels with the membership; for anyone else the field stays empty.
      const helpsAgentId = role === "assistant" ? next.memberHelps?.[agentId] ?? null : null;
      return { agentId, role, ...(helpsAgentId ? { helpsAgentId } : {}) };
    }),
  });
  return result.ok ? { ok: true } : result;
}

export async function persistProjectPatch(
  api: AgencyApi,
  snapshot: WorkspaceSnapshot,
  current: Group,
  next: Group,
): Promise<{ ok: true } | { ok: false; failure: MutationFailure }> {
  const record = snapshot.bindings.find((binding) => binding.id === current.id);
  if (!record) return { ok: false, failure: { kind: "domain", error: { code: "not_found", message: tr("Привязка проекта не найдена на сервере.") } } };
  const currentLinked = snapshot.projectDepartments
    .filter((row) => row.bindingId === record.id)
    .map((row) => row.departmentId);
  const wanted: string[] = [];
  for (const token of next.members) {
    const linked = requireExactId(snapshot.departments, token, tr("К проекту подключён неизвестный отдел. Название не подставляется."));
    if (!linked.ok) return linked;
    if (!wanted.includes(linked.id)) wanted.push(linked.id);
  }
  if (currentLinked.some((departmentId) => !wanted.includes(departmentId))) {
    return { ok: false, failure: { kind: "domain", error: { code: "unlink_unsupported", message: DOMAIN_NOTICE.unlink_unsupported } } };
  }
  for (const departmentId of wanted) {
    if (snapshot.projectDepartments.some((row) => row.bindingId === record.id && row.departmentId === departmentId)) {
      continue;
    }
    const linked = await api.linkDepartment({
      requestId: newRequestId(),
      bindingId: record.id,
      departmentId,
    });
    if (!linked.ok) return linked;
  }
  return { ok: true };
}

export function canCreateJob(
  snapshot: WorkspaceSnapshot,
  placement?: { bindingId?: string; departmentId?: string },
): { bindingId: string; departmentId: string } | null {
  const bindingId = placement?.bindingId;
  const departmentId = placement?.departmentId;
  if (!bindingId || !departmentId) return null;
  const binding = snapshot.bindings.find((item) => item.id === bindingId);
  if (!binding || binding.archivedAt) return null;
  const department = snapshot.departments.find((item) => item.id === departmentId);
  if (!department) return null;
  if (
    department.availability === "selected" &&
    !snapshot.projectDepartments.some((row) => row.bindingId === bindingId && row.departmentId === departmentId)
  ) {
    return null;
  }
  return { bindingId, departmentId };
}

export async function persistArtifactUpload(
  api: AgencyApi,
  jobId: string,
  file: TaskFile,
): Promise<MutationOutcome<ArtifactVersion>> {
  const bytes = fileBytes(file);
  const hash = await sha256Hex(bytes);
  let artifactId = file.id;
  if (!isOpaqueRecordId(file.id)) {
    const created = await api.createArtifact({ requestId: newRequestId(), jobId });
    if (!created.ok) return created;
    artifactId = created.value.id;
  }
  return api.publishArtifactVersion({
    requestId: newRequestId(),
    artifactId,
    jobId,
    relativePath: asRelativePath(file.name),
    mime: mimeOf(file),
    size: bytes.byteLength,
    hash,
    bytesBase64: bytesToBase64(bytes),
  });
}

export async function openPersistedArtifact(
  api: AgencyApi,
  input: { artifactId: string; jobId: string; version: number; expectedHash?: string },
): Promise<MutationOutcome<OpenArtifactResult>> {
  const opened = await api.openArtifact({
    artifactId: input.artifactId,
    jobId: input.jobId,
    version: input.version,
  });
  if (!opened.ok) return opened;
  const actual = await sha256Hex(Uint8Array.from(atob(opened.value.bytesBase64), (char) => char.charCodeAt(0)));
  if (actual !== opened.value.hash || (input.expectedHash && input.expectedHash !== opened.value.hash)) {
    return { ok: false, failure: { kind: "domain", error: { code: "artifact_hash_mismatch", message: tr("Хеш открытого файла не совпал с записью версии.") } } };
  }
  return opened;
}

export async function persistJobComment(
  api: AgencyApi,
  jobId: string,
  comment: string,
  fileIds: string[],
): Promise<MutationOutcome<unknown>> {
  return api.createActivity({
    requestId: newRequestId(),
    jobId,
    kind: "comment",
    causationId: null,
    references: fileIds.filter(isOpaqueRecordId).map((id) => ({ type: "artifact", id })),
    ...(comment.trim() ? { comment: comment.trim() } : {}),
  });
}

export async function persistAcceptArtifact(
  api: AgencyApi,
  input: { expectedRevision: number; jobId: string; artifactId: string; version: number; hash: string },
): Promise<MutationOutcome<ArtifactVersion>> {
  return api.acceptArtifactVersion({
    requestId: newRequestId(),
    expectedRevision: input.expectedRevision,
    jobId: input.jobId,
    artifactId: input.artifactId,
    version: input.version,
    hash: input.hash,
  });
}

/** acceptArtifactVersion (exact version+hash). The store closes review→done; this only transitions if an older server left the job in review. */
export async function persistAcceptThenDone(
  api: AgencyApi,
  input: { expectedRevision: number; jobId: string; artifactId: string; version: number; hash: string },
): Promise<{ ok: true } | { ok: false; failure: MutationFailure; accepted?: true }> {
  const accepted = await persistAcceptArtifact(api, input);
  if (!accepted.ok) return accepted;
  const detail = await api.getJob({ jobId: input.jobId });
  if (!detail.ok) return { ok: false, failure: detail.failure, accepted: true };
  if (detail.value.job.state === "done") return { ok: true };
  const moved = await api.transitionJob({
    requestId: newRequestId(),
    expectedRevision: detail.value.job.revision,
    jobId: input.jobId,
    to: "done",
  });
  return moved.ok ? { ok: true } : { ok: false, failure: moved.failure, accepted: true };
}

export async function persistAnswerNeedsInput(
  api: AgencyApi,
  input: {
    requestId: string;
    expectedRevision: number;
    jobId: string;
    expectedAttemptRevision: number;
    attemptId: string;
    launchId: string;
    threadId: string;
    waitId: string;
    answers: Array<{ questionId: string; text: string }>;
    expectedProcessVersionId: string;
    expectedSnapshotDigest: string;
    expectedProcessInstructionsHash?: string;
    expectedProcessAcceptanceHash?: string;
    expectedJobBriefHash?: string;
    expectedJobAcceptanceHash?: string;
  },
) {
  return api.answerNeedsInput(input);
}

function sameContract(a: Job["contract"], b: Job["contract"]): boolean {
  const norm = (value: Job["contract"]) => JSON.stringify(CONTRACT_PARTS.map((part) => value?.[part] ?? []));
  return norm(a) === norm(b);
}

/** An existing policy with this content, or a new policy version. */
async function resolvePolicyContent(api: AgencyApi, snapshot: WorkspaceSnapshot, content: PolicyContent): Promise<MutationOutcome<string>> {
  const same = snapshot.policies.find((policy) => samePolicyContent(policy, content));
  if (same) return { ok: true, value: same.id };
  const created = await api.createPolicyVersion({ requestId: newRequestId(), ...content });
  return created.ok ? { ok: true, value: created.value.id } : created;
}

/** The project allows any CLI connected in BB; files, machines and secrets of its policy stay. */
export async function persistProjectAnyCli(api: AgencyApi, snapshot: WorkspaceSnapshot, bindingId: string): Promise<MutationOutcome<ProjectBinding | null>> {
  const binding = snapshot.bindings.find((item) => item.id === bindingId);
  if (!binding) return { ok: false, failure: { kind: "domain", error: { code: "not_found", message: tr("Проект не найден на сервере.") } } };
  const policy = snapshot.policies.find((item) => item.id === binding.policyVersionId);
  const open = policy ? policyForAnyCli(policy) : null;
  if (!open) return { ok: true, value: null };
  const resolved = await resolvePolicyContent(api, snapshot, open);
  if (!resolved.ok) return resolved;
  return api.updateProjectBinding({ requestId: newRequestId(), expectedRevision: binding.revision, bindingId, policyVersionId: resolved.value });
}

/** Why a reserve row cannot be saved, in the owner's words; the row number is 1-based. */
export function fallbackProblemText(problem: FallbackProblem): string {
  const row = String(problem.index + 1);
  if (problem.kind === "same_as_primary") return tr("Запасная модель {row} совпадает с основной. Выберите другую CLI или модель либо уберите строку.", { row });
  if (problem.kind === "repeated") return tr("Запасная модель {row} повторяет строку выше. Выберите другую или уберите строку.", { row });
  return tr("В запасной модели {row} не выбрана CLI или модель.", { row });
}
