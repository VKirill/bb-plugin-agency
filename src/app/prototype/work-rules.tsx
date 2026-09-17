import { Tr } from "../i18n/tr";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { experimental_ProviderModelPicker as ProviderModelPicker, useRpc } from "@get-bb/plugin-sdk/app";
import { Switch } from "../../../components/ui/switch";
import type { BudgetStatusView, rpcContract } from "../../shared/rpc-contract";
import { DEFAULT_WORK_RULES, type RuleSource, type StoredWorkRules, type WorkRuleKey, type WorkRulesView } from "../../shared/contracts/work-rules";
import { failureNotice } from "../data/persist";
import { LAUNCH_PROVIDER_ID, REASONING_OPTIONS, type ReasoningLevel } from "../data/role-types";
import { createRpcAgencyApi, type RpcCaller } from "../data/rpc-agency-api";
import { tr } from "../i18n";
import { Button, Choice, InfoHint, Input, Panel } from "./shared";

type FieldKind = "int" | "number" | "bool" | "optionalNumber" | "model";

type FieldSpec = {
  key: WorkRuleKey;
  label: string;
  unit?: string;
  kind: FieldKind;
  min?: number;
  max?: number;
  step?: number;
  /** For a model field: the reasoning key the same picker sets. */
  reasoningKey?: WorkRuleKey;
  hint: ReactNode;
};

export type RuleGroup = { title: string; hint?: ReactNode; fields: FieldSpec[] };

const SOURCE_LABEL: Record<RuleSource, string> = {
  default: "по умолчанию",
  agency: "общее для Агентства",
  department: "задано в отделе",
  agent: "задано у сотрудника",
};

const SANDBOX_FIELD: FieldSpec = {
  key: "runWithoutSandbox",
  label: "Запуск без песочницы",
  kind: "bool",
  hint: (
    <>
      <p><Tr text={"Выключено (по умолчанию) — сотрудник работает в песочнице CLI: пишет только в папку задачи, сеть ограничена."} /></p>
      <p><Tr text={"Включено — полные права без песочницы. Нужно рабочим местам с браузером и программами и машинам, где песочница не пускает команды Агентства (например, Linux-сервер)."} /></p>
      <p><Tr text={"Команды, которые сотрудник всё же выполнил вне песочницы, Агентство отмечает в карточке задачи."} /></p>
    </>
  ),
};

export const AGENCY_RULE_GROUPS: RuleGroup[] = [
  {
    title: "Доработка и проверка",
    fields: [
      { key: "reworkLimit", label: "Кругов доработки под одной задачей", kind: "int", min: 1, max: 10, hint: <><p><Tr text={"Сколько раз руководитель может отправить работу на доработку после проверки. Дальше сервер не даст завести новый круг: решение за владельцем."}/></p><p><Tr text={"Возврат с замечанием из карточки тоже считается кругом."}/></p></> },
      { key: "autoReview", label: "Проверка создаётся автоматически", kind: "bool", hint: <><p><Tr text={"Включено — когда исполнитель сдаёт работу, Агентство само создаёт подзадачу проверки на свободного проверяющего отдела, прикладывает сданную версию и ставит проверку в очередь запуска."}/></p><p><Tr text={"Руководитель не тратит ход на назначение проверки, но решение по заключению остаётся за ним."}/></p></> },
      { key: "minorDefectsWithoutRound", label: "Мелкие дефекты без нового круга", kind: "bool", hint: <><p><Tr text={"Включено — замечания уровня «мелочь» перечисляются в итоговом отчёте, работа принимается без доработки."}/></p><p><Tr text={"Выключено — любой открытый дефект уходит в доработку. Строже, но дороже: в первом прогоне круги по мелочам стоили треть задачи."}/></p></> },
    ],
  },
  {
    title: "Наблюдение за запуском",
    hint: <p><Tr text={"Когда Агентство считает запуск зависшим. Признаки работы: обновление треда, расход токенов, запись в истории задачи. Задача уходит в «Ожидает решения», руководитель получает сообщение."}/></p>,
    fields: [
      { key: "watchQuietMinutes", label: "Предупредить о тишине через", unit: "мин", kind: "int", min: 1, max: 240, hint: <p><Tr text={"Тред активен, но событий нет: в задаче появится системный комментарий."}/></p> },
      { key: "watchStallMinutes", label: "Считать зависшим через", unit: "мин", kind: "int", min: 2, max: 720, hint: <p><Tr text={"Сколько минут без событий до перевода задачи в «Ожидает решения»."}/></p> },
      { key: "watchStartMinutes", label: "Не запустился через", unit: "мин", kind: "int", min: 1, max: 120, hint: <p><Tr text={"Тред так и не начал работу: машина не в сети или CLI не авторизован."}/></p> },
      { key: "watchErrorMinutes", label: "Ошибка провайдера дольше", unit: "мин", kind: "int", min: 1, max: 120, hint: <p><Tr text={"Сколько терпеть ошибку треда: у повторов провайдера и лимитов подписки есть время восстановиться."}/></p> },
      { key: "watchCeilingHours", label: "Потолок одной попытки", unit: "ч", kind: "number", min: 0.5, max: 24, step: 0.5, hint: <p><Tr text={"Непрерывная работа дольше этого срока — задача останавливается на решение: возможно, сотрудник зациклился или работу надо делить."}/></p> },
    ],
  },
  {
    title: "Песочница",
    fields: [SANDBOX_FIELD],
  },
  {
    title: "Сдача и сроки",
    fields: [
      { key: "completionReminders", label: "Напоминаний о несданной работе", kind: "int", min: 0, max: 5, hint: <><p><Tr text={"Сотрудник закончил ход без опубликованной версии — Агентство напоминает, как сдать работу. После этого числа напоминаний задача уходит руководителю."}/></p><p><Tr text={"0 — сразу к руководителю."}/></p></> },
      { key: "dueReminderHours", label: "Напомнить о сроке за", unit: "ч", kind: "int", min: 0, max: 336, hint: <p><Tr text={"За сколько часов до срока задача подсвечивается и получает напоминание. 0 — не напоминать."}/></p> },
      { key: "escalateAfterHours", label: "Эскалировать в вышестоящий отдел через", unit: "ч", kind: "int", min: 0, max: 720, hint: <><p><Tr text="Главная задача отдела ждёт решения дольше этого срока — она эскалируется в отдел, которому подчиняется этот: пометка на доске и комментарий в истории."/></p><p><Tr text="Работает только у подчинённых отделов. 0 — не эскалировать."/></p></> },
    ],
  },
];

/** The one rule an employee may set for their own launches. */
export const AGENT_SANDBOX_RULE_GROUP: RuleGroup = {
  title: "Песочница",
  fields: [SANDBOX_FIELD],
};

export const LIMIT_RULE_GROUP = (scopeLabel: string, withWarn = true): RuleGroup => ({
  title: "Бюджет и параллельность",
  hint: <p>{tr("Лимиты {scope}. Они действуют вместе с лимитами других уровней: сработает самый строгий.", { scope: tr(scopeLabel) })}</p>,
  fields: [
    { key: "budgetMonthlyUsd", label: "Бюджет в месяц", unit: "$", kind: "optionalNumber", min: 0, max: 1_000_000, step: 1, hint: <><p>{tr("Оценка расхода по ценам API за календарный месяц. Пусто — без бюджета.")}</p><p>{tr("При достижении порога предупреждения запуск показывает предупреждение, при 100% новые запуски останавливаются.")}</p></> },
    ...(withWarn ? [{ key: "budgetWarnPercent", label: "Предупреждать с", unit: "%", kind: "int", min: 10, max: 99, hint: <p>{tr("Доля бюджета, после которой Агентство предупреждает о расходе.")}</p> } satisfies FieldSpec] : []),
    { key: "concurrencyLimit", label: "Одновременных запусков", kind: "optionalNumber", min: 1, max: 100, step: 1, hint: <p>{tr("Сколько попыток может работать одновременно. Пусто — без ограничения. Запуск сверх лимита откладывается с объяснением.")}</p> },
  ],
});

export const DEFAULTS_RULE_GROUP: RuleGroup = {
  title: "Новые сотрудники по умолчанию",
  hint: <p><Tr text={"Модель и уровень рассуждения, которые подставляются в форму «Создать сотрудника» для каждого типа роли. В форме всё можно поменять."}/></p>,
  fields: [
    { key: "defaultModelLead", reasoningKey: "defaultReasoningLead", label: "Руководитель", kind: "model", hint: <p><Tr text={"Руководитель планирует, раздаёт работу и принимает решения: сильная модель и высокий уровень рассуждения окупаются."}/></p> },
    { key: "defaultModelExecutor", reasoningKey: "defaultReasoningExecutor", label: "Исполнитель", kind: "model", hint: <p><Tr text={"Для типовой работы хватает более быстрой и дешёвой модели и среднего уровня рассуждения."}/></p> },
    { key: "defaultModelReviewer", reasoningKey: "defaultReasoningReviewer", label: "Проверяющий", kind: "model", hint: <p><Tr text={"Поиск дефектов требует внимательности: сильная модель и высокий уровень рассуждения."}/></p> },
  ],
};

function formatValue(value: unknown, spec: FieldSpec, reasoning?: unknown): string {
  if (value === null || value === undefined) return tr("не задано");
  if (typeof value === "boolean") return value ? tr("да") : tr("нет");
  if (spec.kind === "model") {
    const level = REASONING_OPTIONS.find((option) => option.value === reasoning)?.label;
    return level ? `${value} · ${tr("рассуждение")} ${tr(level).toLowerCase()}` : String(value);
  }
  return `${value}${spec.unit ? ` ${tr(spec.unit)}` : ""}`;
}

/**
 * Editor of one rules scope. At the agency level every field is its own value;
 * in a department or employee a field either follows the inherited value or
 * holds its own, and the person sees which.
 */
export function WorkRulesEditor({ scope, groups, inheritable, notice, routingHostId, saveLabel = "Сохранить правила", inheritLabel = "Как в Агентстве ({value})" }: { scope: string; groups: RuleGroup[]; inheritable: boolean; notice: (text: string) => void; saveLabel?: string; /** Label of the inherited choice of a yes/no rule; {value} is the inherited value. */ inheritLabel?: string; /** Machine whose model catalog the model fields read. */ routingHostId?: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const api = useMemo(() => createRpcAgencyApi(rpc as unknown as RpcCaller), [rpc]);
  const [view, setView] = useState<WorkRulesView | null>(null);
  const [draft, setDraft] = useState<StoredWorkRules>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [budget, setBudget] = useState<BudgetStatusView | null>(null);
  const hasBudget = groups.some((group) => group.fields.some((field) => field.key === "budgetMonthlyUsd"));

  useEffect(() => {
    let live = true;
    void api.getWorkRules({ scope }).then((result) => {
      if (!live) return;
      if (!result.ok) {
        setError(failureNotice(result.failure));
        return;
      }
      setView(result.value);
      setDraft(result.value.stored);
    });
    return () => {
      live = false;
    };
  }, [api, scope]);

  // Spend this month next to the budget: the person sees how close the limit is.
  useEffect(() => {
    if (!hasBudget || !view) return;
    let live = true;
    void api.listBudgets().then((result) => {
      if (live && result.ok) setBudget(result.value.find((row) => row.scope === scope) ?? null);
    });
    return () => {
      live = false;
    };
  }, [api, scope, hasBudget, view]);

  const dirty = view ? JSON.stringify(sortKeys(view.stored)) !== JSON.stringify(sortKeys(draft)) : false;
  const set = (key: WorkRuleKey, value: unknown) => setDraft((current) => ({ ...current, [key]: value }));
  const unset = (...keys: (WorkRuleKey | undefined)[]) =>
    setDraft((current) => {
      const next = { ...current } as Record<string, unknown>;
      for (const key of keys) if (key) delete next[key];
      return next as StoredWorkRules;
    });

  const save = async () => {
    if (!view || pending) return;
    setPending(true);
    const result = await api.saveWorkRules({ requestId: crypto.randomUUID(), scope, expectedRevision: view.revision, rules: draft });
    setPending(false);
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    setView(result.value);
    setDraft(result.value.stored);
    notice(tr("Правила сохранены. Новые запуски и проверки работают по ним."));
  };

  if (error) return <p className="text-sm text-muted-foreground">{error}</p>;
  if (!view) return <p className="text-sm text-muted-foreground">{tr("Загружаем правила…")}</p>;

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <Panel key={group.title} title={group.title} info={group.hint}>
          <div className="divide-y divide-border rounded-lg border border-border">
            {group.fields.map((spec) => {
              const stored = draft as Record<string, unknown>;
              const own = stored[spec.key] !== undefined || (spec.reasoningKey !== undefined && stored[spec.reasoningKey] !== undefined);
              const pick = (key: WorkRuleKey) => (stored[key] !== undefined ? stored[key] : view.effective[key]);
              const value = pick(spec.key);
              const reasoning = spec.reasoningKey ? pick(spec.reasoningKey) : undefined;
              // Limits belong to the scope itself: empty means no limit here, nothing is inherited.
              const limit = spec.kind === "optionalNumber";
              const inherited = inheritable && !limit && !own;
              // An inherited yes/no reads as one choice, not two switches in a row.
              const tristate = inheritable && spec.kind === "bool";
              return (
                <div key={spec.key} className="grid gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)] sm:items-center">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1 text-sm font-medium">{tr(spec.label)}<InfoHint title={spec.label}>{spec.hint}</InfoHint></div>
                    <p className="text-xs text-muted-foreground">
                      {spec.key === "budgetMonthlyUsd" && budget && own ? tr("в этом месяце: ${amount} ({percent}%)", { amount: (budget.spendUsdCents / 100).toFixed(2), percent: budget.percent }) : limit ? (own ? tr("лимит этого уровня") : tr("без лимита на этом уровне")) : inherited ? `${tr(SOURCE_LABEL[view.sources[spec.key] ?? "default"])}: ${formatValue(view.effective[spec.key], spec, spec.reasoningKey && view.effective[spec.reasoningKey])}` : own ? tr("своё значение") : `${tr(SOURCE_LABEL.default)}: ${formatValue(DEFAULT_WORK_RULES[spec.key], spec, spec.reasoningKey && DEFAULT_WORK_RULES[spec.reasoningKey])}`}
                    </p>
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    {tristate && (
                      <div className="w-52">
                        <Choice
                          label={spec.label}
                          value={own ? String(value) : "inherit"}
                          onChange={(next) => (next === "inherit" ? unset(spec.key) : set(spec.key, next === "true"))}
                          options={[
                            { value: "inherit", label: tr(inheritLabel, { value: formatValue(view.effective[spec.key], spec) }) },
                            { value: "true", label: "Да" },
                            { value: "false", label: "Нет" },
                          ]}
                        />
                      </div>
                    )}
                    {inheritable && !limit && !tristate && (
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Switch checked={own} onCheckedChange={(next) => (next ? set(spec.key, view.effective[spec.key] ?? DEFAULT_WORK_RULES[spec.key]) : unset(spec.key, spec.reasoningKey))} aria-label={tr("{label}: своё значение", { label: tr(spec.label) })} />
                        {tr("своё")}
                      </label>
                    )}
                    {!tristate && <FieldInput
                      spec={spec}
                      value={value}
                      reasoning={reasoning}
                      disabled={inherited}
                      routingHostId={routingHostId}
                      onChange={(next) => (limit && next === null ? unset(spec.key) : set(spec.key, next))}
                      onReasoning={(next) => spec.reasoningKey && set(spec.reasoningKey, next)}
                    />}
                    {!inheritable && !limit && own && spec.kind !== "bool" && (
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => unset(spec.key, spec.reasoningKey)}>{tr("Сбросить")}</Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      ))}
      <div className="flex items-center gap-3">
        <Button disabled={!dirty || pending} onClick={() => void save()}>{pending ? tr("Сохраняем…") : tr(saveLabel)}</Button>
        {dirty && <span className="text-xs text-amber-700 dark:text-amber-400">{tr("Есть несохранённые изменения.")}</span>}
      </div>
    </div>
  );
}

function FieldInput({ spec, value, reasoning, disabled, onChange, onReasoning, routingHostId }: { spec: FieldSpec; value: unknown; reasoning?: unknown; disabled: boolean; onChange: (value: unknown) => void; onReasoning: (value: string) => void; routingHostId?: string }) {
  if (spec.kind === "bool") {
    return <Switch checked={Boolean(value)} disabled={disabled} onCheckedChange={(next) => onChange(next)} aria-label={tr(spec.label)} />;
  }
  if (spec.kind === "model") {
    return (
      <div className="flex w-56 justify-end" aria-label={tr(spec.label)}>
        <ProviderModelPicker
          value={{ providerId: LAUNCH_PROVIDER_ID, model: String(value ?? ""), reasoningLevel: (reasoning as ReasoningLevel | undefined) ?? "medium" }}
          onChange={(next) => {
            onChange(next.model);
            if (REASONING_OPTIONS.some((option) => option.value === next.reasoningLevel)) onReasoning(next.reasoningLevel as ReasoningLevel);
          }}
          routing={routingHostId ? { kind: "host", hostId: routingHostId } : undefined}
          disabled={disabled}
          align="end"
        />
      </div>
    );
  }
  const optional = spec.kind === "optionalNumber";
  return (
    <div className="flex items-center gap-1.5">
      <Input
        aria-label={tr(spec.label)}
        type="number"
        className="w-24"
        min={spec.min}
        max={spec.max}
        step={spec.step ?? (spec.kind === "int" ? 1 : 0.5)}
        placeholder={optional ? tr("не задано") : undefined}
        value={value === null || value === undefined ? "" : String(value)}
        disabled={disabled}
        onChange={(event) => {
          const raw = event.target.value.trim();
          if (!raw) {
            onChange(optional ? null : spec.min ?? 0);
            return;
          }
          const parsed = Number(raw);
          if (!Number.isFinite(parsed)) return;
          const clamped = Math.min(spec.max ?? parsed, Math.max(spec.min ?? parsed, spec.kind === "int" ? Math.round(parsed) : parsed));
          onChange(clamped);
        }}
      />
      <span className="w-6 text-xs text-muted-foreground">{spec.unit && tr(spec.unit)}</span>
    </div>
  );
}

function sortKeys(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
