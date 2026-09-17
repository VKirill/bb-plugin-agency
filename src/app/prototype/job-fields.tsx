import { ACCEPTANCE_TEMPLATE, BRIEF_TEMPLATE, defaultTemplates } from "../../shared/templates";
import { useState, type ReactNode } from "react";
import { contractIsEmpty, type ContractPart, type JobContract } from "../../shared/contracts/job";
import { ROLE_TYPE_LABELS, type Agent, type Group } from "./data";
import { Button, Choice, Field, TextField } from "./shared";
import { tr, uiLanguage } from "../i18n";
import { Tr } from "../i18n/tr";

/** Stored description keeps the brief and the criteria apart with this marker; the UI edits them as two fields. */
export function composeJobDescription(brief: string, acceptance: string): string {
  return `${brief}\n\nКритерии приёмки:\n${acceptance}`;
}

export const BRIEF_PLACEHOLDER = BRIEF_TEMPLATE;
export const ACCEPTANCE_PLACEHOLDER = ACCEPTANCE_TEMPLATE;

export const BRIEF_HINT: ReactNode = (
  <>
    <p><Tr text="Это поручение, которое получит сотрудник. Пишите цель, контекст, что делать и чего не делать, какой результат нужен."/></p>
    <p><Tr text="Без брифа агенту нечего исполнять: запуск по пустому или шаблонному тексту даст случайный результат."/></p>
  </>
);

export const ACCEPTANCE_HINT: ReactNode = (
  <>
    <p><Tr text="Как проверить результат без автора: какой файл, какая команда, какие признаки."/></p>
    <p><Tr text="По этому списку руководитель и проверяющий принимают работу, а вы нажимаете «Принять результат»."/></p>
  </>
);

export const ASSIGNEE_HINT: ReactNode = (
  <>
    <p><Tr text="Обычно задачу ставят руководителю отдела: он оценит её, разобьёт на подзадачи и назначит исполнителей и проверяющего."/></p>
    <p><Tr text="Исполнителя напрямую назначают для небольшой задачи, которую не нужно делить. Проверяющему ставят только проверку чужой работы."/></p>
  </>
);

export function JobBriefFields({
  brief,
  acceptance,
  onBrief,
  onAcceptance,
  templates,
}: {
  brief: string;
  acceptance: string;
  onBrief: (value: string) => void;
  onAcceptance: (value: string) => void;
  /** Owner's templates («Настройки → Шаблоны»); placeholders and «Вставить шаблон» use them. */
  templates?: { brief: string; acceptance: string };
}) {
  const briefTemplate = templates?.brief ?? defaultTemplates(uiLanguage()).brief;
  const acceptanceTemplate = templates?.acceptance ?? defaultTemplates(uiLanguage()).acceptance;
  return (
    <>
      <TextField label="Что нужно сделать" value={brief} onChange={onBrief} multiline rows={5} placeholder={briefTemplate} info={BRIEF_HINT} maxLength={40_000} required />
      {templates && !brief.trim() && <Button size="sm" variant="ghost" className="-mt-2 h-7 px-2 text-xs" onClick={() => onBrief(templates.brief)}>{tr("Вставить шаблон брифа")}</Button>}
      <TextField label="Критерии приёмки" value={acceptance} onChange={onAcceptance} multiline rows={3} placeholder={acceptanceTemplate} info={ACCEPTANCE_HINT} maxLength={20_000} required />
      {templates && !acceptance.trim() && <Button size="sm" variant="ghost" className="-mt-2 h-7 px-2 text-xs" onClick={() => onAcceptance(templates.acceptance)}>{tr("Вставить шаблон критериев")}</Button>}
    </>
  );
}

type DepartmentTeam = { id: string; lead: string; members: readonly string[]; memberRoles?: Group["memberRoles"] };

/** Lead first and marked as the usual choice, then executors and reviewers with their role type. */
export function assigneeOptions(
  department: DepartmentTeam | undefined,
  agents: readonly Pick<Agent, "id" | "name" | "role" | "enabled">[],
): { value: string; label: string }[] {
  if (!department) return [];
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const ids = [department.lead, ...department.members.filter((id) => id !== department.lead)];
  return [...new Set(ids)]
    .map((id) => byId.get(id))
    .filter((agent): agent is Pick<Agent, "id" | "name" | "role" | "enabled"> => Boolean(agent) && agent!.enabled !== false)
    .map((agent) => {
      const type = agent.id === department.lead ? "lead" : department.memberRoles?.[agent.id] === "reviewer" ? "reviewer" : "executor";
      const suffix = type === "lead" ? tr("руководитель отдела, обычный выбор") : tr(ROLE_TYPE_LABELS[type]).toLowerCase();
      return { value: agent.id, label: `${agent.name} · ${suffix}` };
    });
}

export const AUTO_ASSIGNMENT_PREFIX = "auto:";

/** Adds «let the server pick» choices for role types the department has. */
export function withAutoAssignment(options: { value: string; label: string }[], department: DepartmentTeam | undefined): { value: string; label: string }[] {
  if (!department) return options;
  const roles = department.members.filter((id) => id !== department.lead).map((id) => (department.memberRoles?.[id] === "reviewer" ? "reviewer" : "executor"));
  const auto = [
    ...(roles.includes("executor") ? [{ value: `${AUTO_ASSIGNMENT_PREFIX}executor`, label: tr("Автоматически · исполнитель с наименьшей загрузкой") }] : []),
    ...(roles.includes("reviewer") ? [{ value: `${AUTO_ASSIGNMENT_PREFIX}reviewer`, label: tr("Автоматически · проверяющий с наименьшей загрузкой") }] : []),
  ];
  return [...options, ...auto];
}

export function autoAssignmentOf(value: string): "executor" | "reviewer" | null {
  return value === `${AUTO_ASSIGNMENT_PREFIX}executor` ? "executor" : value === `${AUTO_ASSIGNMENT_PREFIX}reviewer` ? "reviewer" : null;
}

export function AssigneeField({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <Field label="Исполнитель" info={ASSIGNEE_HINT} required>
      {options.length ? (
        <Choice label="Исполнитель" value={value} onChange={onChange} options={options} />
      ) : (
        <p className="text-xs text-muted-foreground">{tr("В отделе нет активных сотрудников. Добавьте их в «Составе» отдела.")}</p>
      )}
    </Field>
  );
}

const CONTRACT_FIELDS = [
  { key: "readFirst", label: "Прочитать сначала", placeholder: "docs/architecture.md\nsrc/cards/card.tsx\nотчёт AG-12", hint: "Что исполнитель читает до начала: файлы, документы, отчёты прошлых задач. Экономит поиск и не даёт додумывать." },
  { key: "interfaces", label: "Интерфейсы и инварианты", placeholder: "openCard(id: string): Promise<Card>\nцены считает только billing\nответ API не меняется", hint: "Сигнатуры, договорённости и правила, которые результат обязан сохранить. Менять их — вопрос руководителю." },
  { key: "mayChange", label: "Можно менять", placeholder: "src/cards/**\nстили карточки", hint: "Файлы, модули или области, в которых исполнитель работает. Одна строка — один пункт." },
  { key: "mustNotTouch", label: "Нельзя трогать", placeholder: "src/billing/**\nпубличный API\nмиграции базы", hint: "Что должно остаться как есть. Выход за границу — вопрос руководителю, а не решение исполнителя." },
  { key: "checks", label: "Проверки перед сдачей", placeholder: "npm test\nnpm run build\nскриншот страницы на 375 px", hint: "Команды и проверки, которые исполнитель проходит до публикации версии и упоминает в итоговом комментарии." },
] as const;

function contractLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Lines to a contract; an empty contract is no contract. */
export function contractFromTexts(texts: Record<(typeof CONTRACT_FIELDS)[number]["key"], string>): JobContract | undefined {
  // An empty optional list is left out, so a contract without them keeps its old shape and hash.
  const contract = Object.fromEntries(
    CONTRACT_FIELDS.map((field) => [field.key, contractLines(texts[field.key])]).filter(([key, lines]) => (lines as string[]).length || key === "mayChange" || key === "mustNotTouch" || key === "checks"),
  ) as JobContract;
  return contractIsEmpty(contract) ? undefined : contract;
}

export const CONTRACT_HINT: ReactNode = (
  <>
    <p><Tr text="Граница работы: что исполнителю можно менять, что трогать нельзя и какие проверки пройти до сдачи."/></p>
    <p><Tr text="Контракт закрепляется в снимке запуска: изменение после подготовки запуска делает его недействительным, сотрудник всегда работает по той версии, что видел."/></p>
  </>
);

/**
 * Optional execution contract: three lists, one item per line. The text is kept
 * as typed and turned into lists on every change, so new lines are not eaten.
 */
export function JobContractFields({ value, onChange, defaultOpen }: { value?: JobContract; onChange: (next: JobContract | undefined) => void; defaultOpen?: boolean }) {
  const [texts, setTexts] = useState(() => Object.fromEntries(CONTRACT_FIELDS.map((field) => [field.key, (value?.[field.key] ?? []).join("\n")])) as Record<ContractPart, string>);
  const count = CONTRACT_FIELDS.reduce((total, field) => total + (value?.[field.key]?.length ?? 0), 0);
  return (
    <details className="rounded-lg border border-border px-3 py-2" open={defaultOpen ?? count > 0}>
      <summary className="cursor-pointer text-sm font-medium">
        {count ? tr("Контракт исполнения · {count}", { count }) : tr("Контракт исполнения · необязательно")}
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-muted-foreground">{tr("Граница работы для исполнителя. Закрепляется при запуске.")}</p>
        {CONTRACT_FIELDS.map((field) => (
          <TextField
            key={field.key}
            label={field.label}
            multiline
            rows={3}
            value={texts[field.key]}
            placeholder={field.placeholder}
            info={<p>{tr(field.hint)}</p>}
            maxLength={8_000}
            onChange={(text) => {
              const next = { ...texts, [field.key]: text };
              setTexts(next);
              onChange(contractFromTexts(next));
            }}
          />
        ))}
      </div>
    </details>
  );
}
