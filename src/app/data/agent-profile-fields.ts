import type { Agent } from "../prototype/data";

/** Fields `saveAgentProfile` / AgentVersion draft persist (AGY-17). */
export const AGENT_PROFILE_SAVED_HINT =
  "В версии профиля сохраняются имя, статус, роль, инструкции, CLI, модель и отмеченные навыки и MCP из каталога.";

export const AGENT_PROFILE_UNSUPPORTED = {
  department: "Отдел задаётся в составе отдела, в версии профиля не хранится.",
  host: "Машина в версии профиля не хранится. Запуск идёт в окружении проекта задачи.",
  reasoning: "Уровень рассуждения в версии профиля не хранится.",
  serviceTier: "Тариф модели в версии профиля не хранится.",
  permission: "Режим разрешений в версии профиля не хранится.",
  concurrency: "Число одновременных задач в версии профиля не хранится.",
  shell: "Доступ к терминалу в версии профиля не хранится.",
  delegate: "Передача работы другим сотрудникам в версии профиля не хранится.",
  customMcps: "Свои MCP в версии профиля не хранятся — только идентификаторы из каталога.",
} as const;

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export const AGENT_PROFILE_STALE_HINT =
  "Профиль на сервере изменился. Черновик оставлен. Сохранение сверит исходную ревизию и не перезапишет чужую версию молча.";

export function agentDraftStale(baseline: Agent, server: Agent): boolean {
  const baselineRecord = baseline.recordId || baseline.id;
  const serverRecord = server.recordId || server.id;
  return (baseline.revision ?? null) !== (server.revision ?? null) || baselineRecord !== serverRecord;
}

/** Server matches the draft we just saved; revision may have advanced. */
export function isOwnProfileEcho(draft: Agent, server: Agent, baseline: Agent): boolean {
  if (persistedAgentDirty(draft, server)) return false;
  return (server.revision ?? 0) >= (baseline.revision ?? 0);
}

export function persistedAgentDirty(current: Agent, next: Agent): boolean {
  return (
    current.name !== next.name ||
    current.role !== next.role ||
    current.instructions !== next.instructions ||
    current.enabled !== next.enabled ||
    current.selection.providerId !== next.selection.providerId ||
    current.selection.model !== next.selection.model ||
    !sameIds(current.skills, next.skills) ||
    !sameIds(current.mcps, next.mcps)
  );
}

export function unsupportedAgentFieldChanges(current: Agent, next: Agent): string[] {
  const labels: string[] = [];
  if ((current.department || "") !== (next.department || "")) labels.push("отдел");
  if ((current.hostId || "") !== (next.hostId || "")) labels.push("машина");
  if (current.selection.reasoningLevel !== next.selection.reasoningLevel) labels.push("уровень рассуждения");
  if ((current.selection.serviceTier || "") !== (next.selection.serviceTier || "")) labels.push("тариф модели");
  if (current.permission !== next.permission) labels.push("режим разрешений");
  if (current.concurrency !== next.concurrency) labels.push("одновременные задачи");
  if (Boolean(current.shell) !== Boolean(next.shell)) labels.push("терминал");
  if (Boolean(current.delegate) !== Boolean(next.delegate)) labels.push("делегирование");
  if (JSON.stringify(current.customMcps || []) !== JSON.stringify(next.customMcps || [])) labels.push("свои MCP");
  return labels;
}

export function unsupportedAgentSaveMessage(fields: readonly string[]): string {
  return `Нельзя сохранить: ${fields.join(", ")}. Эти поля ещё не входят в версию профиля.`;
}
