import { tr } from "../i18n";

/**
 * Fixed choices for building a team: role types, reasoning levels and the
 * standard permissions. Labels and explanations live here so the create
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

export type ReasoningLevel = "low" | "medium" | "high" | "xhigh" | "max";

export const REASONING_OPTIONS: HintedOption<ReasoningLevel>[] = [
  { value: "low", label: "Низкий", description: "Быстро и дёшево: рутина по чёткому брифу.", hint: ["Подходит для простых правок, форматирования, сбора данных по готовой схеме."] },
  { value: "medium", label: "Средний", description: "Баланс скорости и качества для большинства исполнителей.", hint: ["Типовые изменения в коде, черновики текстов, обычный анализ."] },
  { value: "high", label: "Высокий", description: "Для руководителей и проверяющих: оценка, план, поиск дефектов.", hint: ["Модель дольше рассуждает перед ответом: дороже, но меньше ошибок в решениях."] },
  { value: "xhigh", label: "Очень высокий", description: "Сложные изменения в нескольких модулях, архитектура.", hint: ["Заметно дороже и медленнее. Включайте для задач с высоким риском."] },
  { value: "max", label: "Максимальный", description: "Самые трудные задачи, где цена ошибки высока.", hint: ["Самый дорогой режим. Обычно не нужен постоянно."] },
];

export const DEFAULT_REASONING: Record<RoleType, ReasoningLevel> = {
  lead: "high",
  executor: "medium",
  reviewer: "high",
};

export const TITLE_PLACEHOLDER: Record<RoleType, string> = {
  lead: "Например: Руководитель разработки",
  executor: "Например: Разработчик TypeScript",
  reviewer: "Например: Проверяющий кода",
};

/** The only CLI the Agency launches today; others stay in the catalog but cannot run a job. */
export const LAUNCH_PROVIDER_ID = "claude-code";

export type PolicyContent = {
  allowedCapabilities: string[];
  cliHostConstraints: { providerIds: string[]; hostIds: string[] };
  secretRefs: string[];
};

/** Standard employee permissions: project files, the employee's own CLI, any machine of the project. */
export function standardAgentPolicy(providerId: string = LAUNCH_PROVIDER_ID): PolicyContent {
  return {
    allowedCapabilities: ["read.files", "write.files"],
    cliHostConstraints: { providerIds: [providerId], hostIds: [] },
    secretRefs: [],
  };
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

const CAPABILITY_LABELS: Record<string, string> = {
  "read.files": "чтение файлов",
  "write.files": "запись файлов",
};

/** One line a person can read: what the policy allows. */
export function policySummary(policy: PolicyContent, hostName: (id: string) => string = (id) => id): string {
  const caps = policy.allowedCapabilities.map((cap) => tr(CAPABILITY_LABELS[cap] ?? cap)).join(", ") || tr("ничего");
  const providers = policy.cliHostConstraints.providerIds.length
    ? policy.cliHostConstraints.providerIds.map((id) => (id === LAUNCH_PROVIDER_ID ? "Claude Code" : id)).join(", ")
    : tr("любой CLI");
  const hosts = policy.cliHostConstraints.hostIds.length ? policy.cliHostConstraints.hostIds.map(hostName).join(", ") : tr("любая машина");
  return `${caps[0]?.toUpperCase() ?? ""}${caps.slice(1)} · ${providers} · ${hosts}`;
}
