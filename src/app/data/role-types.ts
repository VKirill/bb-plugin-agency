import { tr } from "../i18n";

/**
 * Fixed choices for building a team: role types and the standard
 * permissions. The CLI, model and reasoning come from BB's own picker. Labels and explanations live here so the create
 * dialogs, profiles and department pages say the same thing.
 */

export type RoleType = "lead" | "executor" | "reviewer";

export type HintedOption<T extends string = string> = {
  value: T;
  label: string;
  description: string;
  hint: string[];
};

export const ROLE_TYPE_OPTIONS: HintedOption<RoleType>[] = [
  {
    value: "lead",
    label: "Руководитель",
    description: "Ведёт отдел: принимает поручения, раздаёт подзадачи, собирает итог. Сам не исполняет.",
    hint: [
      "Получает главные задачи отдела, оценивает их и разбивает на подзадачи.",
      "Назначает исполнителей и проверяющих, получает сообщения о ходе подзадач, собирает итоговый отчёт.",
      "Руководителя назначают в карточке отдела. У отдела он ровно один.",
    ],
  },
  {
    value: "executor",
    label: "Исполнитель",
    description: "Делает работу по поручению и сдаёт версию результата. Не своё — возвращает руководителю.",
    hint: [
      "Разработчик, копирайтер, аналитик, дизайнер — любой, кто создаёт результат.",
      "Сверяет поручение со своей инструкцией, работает в границах брифа, публикует отчёт и файлы версией.",
    ],
  },
  {
    value: "reviewer",
    label: "Проверяющий",
    description: "Независимо проверяет чужие версии и выносит вердикт. Свою работу проверить не может.",
    hint: [
      "QA, ревьюер кода, редактор, фактчекер, юрист на согласовании.",
      "Открывает опубликованную версию, проверяет по критериям, описывает дефекты. Результат не правит и не принимает.",
      "Сервер не даст проверяющему получить на проверку собственную работу.",
    ],
  },
];

export const TITLE_PLACEHOLDER: Record<RoleType, string> = {
  lead: "Например: Руководитель разработки",
  executor: "Например: Разработчик TypeScript",
  reviewer: "Например: Проверяющий кода",
};

/** A profile without a saved CLI starts on this one; any provider connected in BB can be chosen. */
export const DEFAULT_PROVIDER_ID = "claude-code";

export type PolicyContent = {
  allowedCapabilities: string[];
  cliHostConstraints: { providerIds: string[]; hostIds: string[] };
  secretRefs: string[];
};

/** Standard employee permissions: project files, any CLI (the profile names it), any machine of the project. */
export function standardAgentPolicy(): PolicyContent {
  return {
    allowedCapabilities: ["read.files", "write.files"],
    cliHostConstraints: { providerIds: [], hostIds: [] },
    secretRefs: [],
  };
}

/**
 * The owner picked a CLI in the profile, but the profile's policy lists other CLIs (older
 * policies name only Claude Code). The same policy with that CLI added; null when it is allowed.
 * Files, machines and secrets stay as they were.
 */
export function policyWithProvider(policy: PolicyContent, providerId: string): PolicyContent | null {
  const providers = policy.cliHostConstraints.providerIds;
  if (!providers.length || providers.includes(providerId)) return null;
  return policyContent(policy, [...providers, providerId]);
}

/** The same policy without a CLI list: any CLI connected in BB. Null when it already allows any. */
export function policyForAnyCli(policy: PolicyContent): PolicyContent | null {
  if (!policy.cliHostConstraints.providerIds.length) return null;
  return policyContent(policy, []);
}

/** Only the content fields: a stored policy record also carries its id, which a new version must not. */
function policyContent(policy: PolicyContent, providerIds: string[]): PolicyContent {
  return {
    allowedCapabilities: [...policy.allowedCapabilities],
    cliHostConstraints: { providerIds, hostIds: [...policy.cliHostConstraints.hostIds] },
    secretRefs: [...policy.secretRefs],
  };
}

/** Provider name for people; unknown ids stay as they are. */
export function providerName(id: string): string {
  return PROVIDER_NAMES[id] ?? id;
}

export const STANDARD_AGENT_POLICY: PolicyContent = standardAgentPolicy();

/** Standard project permissions: project files, any CLI allowed by the employee, only this machine. */
export function standardBindingPolicy(hostId: string): PolicyContent {
  return {
    allowedCapabilities: ["read.files", "write.files"],
    cliHostConstraints: { providerIds: [], hostIds: [hostId] },
    secretRefs: [],
  };
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

export function samePolicyContent(left: PolicyContent, right: PolicyContent): boolean {
  return (
    JSON.stringify(sorted(left.allowedCapabilities)) === JSON.stringify(sorted(right.allowedCapabilities)) &&
    JSON.stringify(sorted(left.cliHostConstraints.providerIds)) === JSON.stringify(sorted(right.cliHostConstraints.providerIds)) &&
    JSON.stringify(sorted(left.cliHostConstraints.hostIds)) === JSON.stringify(sorted(right.cliHostConstraints.hostIds)) &&
    JSON.stringify(sorted(left.secretRefs)) === JSON.stringify(sorted(right.secretRefs))
  );
}

const PROVIDER_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "acp-cursor": "Cursor",
  "acp-opencode": "OpenCode",
  "acp-antigravity": "Antigravity",
};

const CAPABILITY_LABELS: Record<string, string> = {
  "read.files": "чтение файлов",
  "write.files": "запись файлов",
};

/** One line a person can read: what the policy allows. */
export function policySummary(policy: PolicyContent, hostName: (id: string) => string = (id) => id): string {
  const caps = policy.allowedCapabilities.map((cap) => tr(CAPABILITY_LABELS[cap] ?? cap)).join(", ") || tr("ничего");
  const providers = policy.cliHostConstraints.providerIds.length
    ? policy.cliHostConstraints.providerIds.map((id) => PROVIDER_NAMES[id] ?? id).join(", ")
    : tr("любой CLI");
  const hosts = policy.cliHostConstraints.hostIds.length ? policy.cliHostConstraints.hostIds.map(hostName).join(", ") : tr("любая машина");
  return `${caps[0]?.toUpperCase() ?? ""}${caps.slice(1)} · ${providers} · ${hosts}`;
}
