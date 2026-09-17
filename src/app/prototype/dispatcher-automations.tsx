import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Group } from "./data";
import type {
  CatalogRuleRecord,
  DispatcherApi,
  EventDefinitionRecord,
  EventSourceRecord,
  ListedActionIntent,
} from "../data/dispatcher";
import {
  DISPATCHER_INVALID_FIELDS,
  DISPATCHER_NO_BB_PROJECT,
  DISPATCHER_NO_PROJECT,
  DISPATCHER_PAGE_HINT,
  DISPATCHER_SHARED_BB_SCOPE,
  INGEST_DRAFT_SCHEMA,
  INGEST_ACCEPTED,
  INGEST_DUPLICATE,
  INGEST_NEXT_HINT,
  INGEST_SOURCE_GONE,
  INGEST_UNKNOWN,
  INTENT_NO_LIST_RULES,
  INTENT_TICK_HINT,
  emptyIngestDraft,
  ingestDraftAccepted,
  newDraftEventId,
  readIngestDraft,
  writeIngestDraft,
  catalogBbProjectId,
  catalogSharedBbBindingCount,
  dispatcherCommand,
  resolveCatalogBindingId,
  resolveWorkspaceProjectId,
  sourceKindLabel,
} from "../data/dispatcher";
import { STAGE1_UNAVAILABLE } from "../data/runtime-unavailable";
import { failureNotice } from "../data/persist";
import { DispatcherIntentList, TechnicalDetails } from "./dispatcher-intents";
import { Button, Choice, Field, HintedChoice, PageHead, TabBar, TextField } from "./shared";
import { tr, uiLocale } from "../i18n";

export function DispatcherAutomationsPage({
  api,
  projects,
  projectId,
  departments,
  notice,
}: {
  api: DispatcherApi;
  projects: readonly { id: string; name: string; bbProjectId?: string }[];
  projectId: string;
  departments: Group[];
  notice: (text: string) => void;
}) {
  const [tab, setTab] = useState("Согласование");
  const [diagnostics, setDiagnostics] = useState(false);
  const [intents, setIntents] = useState<ListedActionIntent[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [definitions, setDefinitions] = useState<EventDefinitionRecord[]>([]);
  const [sources, setSources] = useState<EventSourceRecord[]>([]);
  const [rules, setRules] = useState<CatalogRuleRecord[]>([]);
  const [lastSourceId, setLastSourceId] = useState("");
  const currentBbProjectId = catalogBbProjectId(projects, projectId);
  const sharedBbScope = catalogSharedBbBindingCount(projects, currentBbProjectId) > 1;

  const refresh = useCallback(async () => {
    const empty = { ok: true as const, value: [] };
    const [listed, defined, sourced, ruled] = await Promise.all([
      api.listActionIntents({}),
      api.listEventDefinitions({}),
      currentBbProjectId ? api.listEventSources({ projectId: currentBbProjectId }) : Promise.resolve(empty),
      currentBbProjectId ? api.listRuleVersions({ projectId: currentBbProjectId }) : Promise.resolve(empty),
    ]);
    if (!listed.ok) {
      setIntents([]);
      setLoadError(listed.failure.kind === "unavailable" ? STAGE1_UNAVAILABLE.dispatcher : failureNotice(listed.failure));
    } else {
      setLoadError(null);
      setIntents(listed.value);
    }
    if (defined.ok) setDefinitions(defined.value);
    if (sourced.ok) setSources(sourced.value);
    if (ruled.ok) setRules(ruled.value);
  }, [api, currentBbProjectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-4" data-testid="dispatcher-automations">
      <PageHead title="Автоматизации" description={DISPATCHER_PAGE_HINT} />
      <p className="text-xs text-muted-foreground">{tr(INTENT_NO_LIST_RULES)}</p>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={diagnostics} onChange={(event) => setDiagnostics(event.target.checked)} data-testid="dispatcher-diagnostics" />
        {tr("Диагностика")}
      </label>
      <TabBar idPrefix="dispatcher-tab" value={tab} onChange={setTab} tabs={["Согласование", "Источники", "Правила", "События"]} />
      {tab === "Согласование" && (
        <div className="space-y-3">
          <Button size="sm" onClick={() => void refresh()}>{tr("Обновить")}</Button>
          {loadError && <p role="status" className="text-sm">{tr(loadError)}</p>}
          {intents && (
            <DispatcherIntentList
              intents={intents}
              api={api}
              notice={notice}
              onChanged={() => { void refresh(); }}
              allowClaim
            />
          )}
        </div>
      )}
      {tab === "Источники" && <SourceForms api={api} projects={projects} projectId={projectId} definitions={definitions} sources={sources} notice={notice} diagnostics={diagnostics} onSaved={() => { void refresh(); }} onSourceSaved={setLastSourceId} />}
      {tab === "Правила" && <RuleForms api={api} projects={projects} projectId={projectId} definitions={definitions} rules={rules} sources={sources} departments={departments} notice={notice} diagnostics={diagnostics} onSaved={() => { void refresh(); }} />}
      {tab === "События" && <EventForms api={api} sources={sources} definitions={definitions} lastSourceId={lastSourceId} bbProjectId={currentBbProjectId} catalogReady={Boolean(currentBbProjectId)} notice={notice} diagnostics={diagnostics} onTick={() => { void refresh(); }} />}
      {sharedBbScope && <p className="text-xs text-muted-foreground">{tr(DISPATCHER_SHARED_BB_SCOPE)}</p>}
    </div>
  );
}

function ProjectChoice({
  projects,
  projectId,
  value,
  onChange,
}: {
  projects: readonly { id: string; name: string; bbProjectId?: string }[];
  projectId: string;
  value: string;
  onChange: (id: string) => void;
}) {
  const options = useMemo(
    () => projects.map((item) => ({ value: item.id, label: item.name })),
    [projects],
  );
  if (!options.length) {
    return <p className="text-xs text-muted-foreground">{tr(DISPATCHER_NO_PROJECT)}</p>;
  }
  const selected = resolveCatalogBindingId(projects, value || projectId);
  return (
    <Field label="Проект">
      <Choice label="Проект" value={selected} onChange={onChange} options={options} />
    </Field>
  );
}

function SourceForms({
  api,
  projects,
  projectId,
  definitions,
  sources,
  notice,
  diagnostics,
  onSaved,
  onSourceSaved,
}: {
  api: DispatcherApi;
  projects: readonly { id: string; name: string; bbProjectId?: string }[];
  projectId: string;
  definitions: readonly EventDefinitionRecord[];
  sources: readonly EventSourceRecord[];
  notice: (text: string) => void;
  diagnostics: boolean;
  onSaved: () => void;
  onSourceSaved: (id: string) => void;
}) {
  const [project, setProject] = useState(() => resolveCatalogBindingId(projects, projectId));
  const [topic, setTopic] = useState("research.delivered");
  const [label, setLabel] = useState("Исследование доставлено");
  const [namespace, setNamespace] = useState<"bb" | "agency" | "integration">("agency");
  const [sourceKind, setSourceKind] = useState<"notify" | "webhook" | "cron" | "bb_lifecycle">("notify");
  const [sourceEnabled, setSourceEnabled] = useState(true);
  const [last, setLast] = useState("");

  useEffect(() => {
    const found = definitions.find((item) => item.topic === topic);
    if (found || !definitions[0]) return;
    setTopic(definitions[0].topic);
    setLabel(definitions[0].label);
  }, [definitions, topic]);

  const saveDefinition = async () => {
    const parsed = dispatcherCommand.saveDefinition.safeParse({
      requestId: crypto.randomUUID(),
      topic,
      schemaVersion: 1,
      namespace,
      label,
      payloadSchema: { type: "object" },
    });
    if (!parsed.success) {
      notice(tr(DISPATCHER_INVALID_FIELDS));
      return;
    }
    const result = await api.saveEventDefinition(parsed.data);
    if (!result.ok) {
      notice(tr(failureNotice(result.failure)));
      return;
    }
    setLast(result.value.label);
    notice(tr("Тип события сохранён."));
    onSaved();
  };

  const scopeId = catalogBbProjectId(projects, project);
  const saveSource = async () => {
    const projectIdExact = catalogBbProjectId(projects, project);
    if (!projectIdExact) {
      notice(tr(DISPATCHER_NO_BB_PROJECT));
      return;
    }
    const parsed = dispatcherCommand.saveSource.safeParse({
      requestId: crypto.randomUUID(),
      projectId: projectIdExact,
      kind: sourceKind,
      enabled: sourceEnabled,
    });
    if (!parsed.success) {
      notice(tr(DISPATCHER_INVALID_FIELDS));
      return;
    }
    const result = await api.saveEventSource(parsed.data);
    if (!result.ok) {
      notice(tr(failureNotice(result.failure)));
      return;
    }
    setLast(result.value.id);
    onSourceSaved(result.value.id);
    notice(
      tr(
        sourceKind === "cron"
          ? "Источник сохранён. Расписание задаётся в правиле с этим источником."
          : sourceKind === "webhook"
            ? "Источник сохранён. Выпустите секрет и перечислите разрешённые темы ниже."
            : "Источник сохранён.",
      ),
    );
    onSaved();
  };

  return (
    <div className="max-w-2xl space-y-4">
      {definitions.length > 0 && (
        <Field label="Сохранённый тип">
          <Choice
            label="Сохранённый тип"
            value={definitions.some((item) => item.topic === topic) ? topic : definitions[0]!.topic}
            onChange={(next) => {
              const found = definitions.find((item) => item.topic === next);
              if (!found) return;
              setTopic(found.topic);
              setLabel(found.label);
            }}
            options={definitions.map((item) => ({ value: item.topic, label: item.label }))}
          />
        </Field>
      )}
      <TextField label="Название события" value={label} onChange={setLabel} />
      <TextField label="Тема" value={topic} onChange={setTopic} />
      <ProjectChoice projects={projects} projectId={projectId} value={project} onChange={setProject} />
      {!scopeId && <p className="text-xs text-muted-foreground">{tr(DISPATCHER_NO_BB_PROJECT)}</p>}
      <Button size="sm" data-testid="dispatcher-save-definition" onClick={() => void saveDefinition()}>{tr("Сохранить тип события")}</Button>
      <Field label="Откуда приходит">
        <select className="rounded-md border border-border bg-background px-2 py-1 text-sm" value={sourceKind} onChange={(event) => setSourceKind(event.target.value as typeof sourceKind)}>
          <option value="notify">{tr("Уведомление")}</option>
          <option value="webhook">{tr("Внешний адрес")}</option>
          <option value="cron">{tr("По расписанию")}</option>
          <option value="bb_lifecycle">{tr("Событие BB")}</option>
        </select>
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={sourceEnabled} onChange={(event) => setSourceEnabled(event.target.checked)} />
        {tr("Принимать события")}
      </label>
      <Button size="sm" data-testid="dispatcher-save-source" disabled={!scopeId} onClick={() => void saveSource()}>{tr("Сохранить источник")}</Button>
      {last && <p className="text-sm" data-testid="dispatcher-last-record">{tr("Сохранено: {value}", { value: last })}</p>}
      {sources.filter((item) => item.kind === "webhook").map((item) => (
        <WebhookSourcePanel key={item.id} api={api} sourceId={item.id} notice={notice} />
      ))}
      {diagnostics && (
        <TechnicalDetails>
          <Field label="Пространство">
            <select className="rounded-md border border-border bg-background px-2 py-1 text-sm" value={namespace} onChange={(event) => setNamespace(event.target.value as typeof namespace)}>
              <option value="agency">agency</option>
              <option value="bb">bb</option>
              <option value="integration">integration</option>
            </select>
          </Field>
        </TechnicalDetails>
      )}
    </div>
  );
}

const RULE_MODE_OPTIONS = [
  { value: "observe" as const, label: "Только записать", description: "Событие и совпадение сохраняются, задача не создаётся.", hint: ["Начните с этого режима: посмотрите во «Входящих» и «Согласовании», что правило поймало бы."] },
  { value: "approve" as const, label: "После согласования", description: "Подготовленная задача ждёт вашего решения во «Входящих».", hint: ["Одобрили — задача создаётся и встаёт в очередь запуска. Отклонили — ничего не происходит."] },
  { value: "auto" as const, label: "Сразу в работу", description: "Задача создаётся сама и встаёт в очередь запуска.", hint: ["Запуск всё равно проходит проверки: машина, CLI, правила проекта, лимиты и бюджет.", "Одно событие — одна задача: повтор события вторую не создаёт."] },
  { value: "disabled" as const, label: "Выключено", description: "Правило не срабатывает.", hint: ["Уже созданные задачи остаются."] },
];

const MISFIRE_OPTIONS = [
  { value: "skip" as const, label: "Пропустить", description: "Пропущенные запуски (сервер был выключен) не догоняются.", hint: ["Подходит для регулярной работы, где важна свежесть, а не каждый запуск."] },
  { value: "last" as const, label: "Один последний", description: "После перерыва выполняется один самый поздний пропущенный запуск.", hint: ["Например, отчёт за неделю: достаточно одного после простоя."] },
  { value: "catch_up" as const, label: "Догнать все", description: "Выполняются пропущенные запуски, не больше 8.", hint: ["Только если каждый запуск важен сам по себе."] },
];

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function RuleForms({
  api,
  projects,
  projectId,
  definitions,
  rules,
  sources,
  departments,
  notice,
  diagnostics,
  onSaved,
}: {
  api: DispatcherApi;
  projects: readonly { id: string; name: string; bbProjectId?: string }[];
  projectId: string;
  definitions: readonly EventDefinitionRecord[];
  rules: readonly CatalogRuleRecord[];
  sources: readonly EventSourceRecord[];
  departments: Group[];
  notice: (text: string) => void;
  diagnostics: boolean;
  onSaved: () => void;
}) {
  const [project, setProject] = useState(() => resolveCatalogBindingId(projects, projectId));
  const [topic, setTopic] = useState("research.delivered");
  const [ruleId, setRuleId] = useState("research-review");
  const [sourceId, setSourceId] = useState("");
  const [mode, setMode] = useState<"disabled" | "observe" | "approve" | "auto">("observe");
  const [actionKind, setActionKind] = useState<"observe" | "prepare_job">("observe");
  const [departmentId, setDepartmentId] = useState("");
  const [title, setTitle] = useState("Разобрать поставку");
  const [brief, setBrief] = useState("Проверьте поставленный материал.");
  const [acceptance, setAcceptance] = useState("Есть вывод и ссылка на источник.");
  const [expression, setExpression] = useState("0 9 * * 1");
  const [timezone, setTimezone] = useState(localTimezone);
  const [misfire, setMisfire] = useState<"skip" | "last" | "catch_up">("skip");
  const [preview, setPreview] = useState<{ runs: string[]; error: string | null }>({ runs: [], error: null });
  const [last, setLast] = useState("");
  const liveDepartments = departments.filter((item) => item.recordId && item.recordId.includes("_"));
  const selectedDepartment = liveDepartments.some((item) => item.recordId === departmentId) ? departmentId : (liveDepartments[0]?.recordId ?? "");
  const selectedSource = sources.find((item) => item.id === sourceId) ?? sources[0];
  const scheduled = selectedSource?.kind === "cron";
  const scopeId = catalogBbProjectId(projects, project);

  useEffect(() => {
    const found = rules.find((item) => item.ruleId === ruleId);
    if (found || !rules[0]) return;
    setRuleId(rules[0].ruleId);
    setTopic(rules[0].topic);
    setMode(rules[0].mode);
  }, [rules, ruleId]);

  useEffect(() => {
    if (!scheduled || !api.previewSchedule) return;
    let live = true;
    const timer = setTimeout(() => {
      void api.previewSchedule!({ expression, timezone }).then((result) => {
        if (!live) return;
        setPreview(result.ok ? { runs: result.value, error: null } : { runs: [], error: failureNotice(result.failure) });
      });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, scheduled, expression, timezone]);

  const saveRule = async () => {
    if (actionKind === "prepare_job" && !selectedDepartment) {
      notice(tr("Выберите отдел, которому правило поручает задачу."));
      return;
    }
    const action = actionKind === "observe"
      ? { kind: "observe" as const }
      : { kind: "prepare_job" as const, departmentId: selectedDepartment, title, brief, acceptance };
    const projectIdExact = catalogBbProjectId(projects, project);
    if (!projectIdExact) {
      notice(tr(DISPATCHER_NO_BB_PROJECT));
      return;
    }
    const parsed = dispatcherCommand.saveRule.safeParse({
      requestId: crypto.randomUUID(),
      ruleId,
      projectId: projectIdExact,
      ...(selectedSource ? { sourceId: selectedSource.id } : {}),
      topic,
      conditions: scheduled ? [] : [{ field: "topic", op: "equals" as const, value: topic }],
      mode,
      action,
      maxDepth: 12,
      maxRetries: 3,
      enabled: mode !== "disabled",
    });
    if (!parsed.success) {
      notice(tr(DISPATCHER_INVALID_FIELDS));
      return;
    }
    if (scheduled && api.saveRuleSchedule) {
      const schedule = await api.saveRuleSchedule({ ruleId, expression, timezone, misfire });
      if (!schedule.ok) {
        notice(tr(failureNotice(schedule.failure)));
        return;
      }
    }
    const result = await api.saveRuleVersion(parsed.data);
    if (!result.ok) {
      notice(tr(failureNotice(result.failure)));
      return;
    }
    setLast(result.value.ruleId);
    notice(
      tr(
        actionKind === "prepare_job" && mode === "auto"
          ? "Правило сохранено: подходящее событие создаст задачу отделу и поставит её в очередь запуска."
          : actionKind === "prepare_job" && mode === "approve"
            ? "Правило сохранено: подготовленная задача будет ждать вашего согласования."
            : "Правило сохранено. Предыдущие срабатывания не меняются.",
      ),
    );
    onSaved();
  };

  return (
    <div className="max-w-2xl space-y-4">
      {rules.length > 0 && (
        <Field label="Сохранённое правило">
          <Choice
            label="Сохранённое правило"
            value={rules.some((item) => item.ruleId === ruleId) ? ruleId : rules[0]!.ruleId}
            onChange={(next) => {
              const found = rules.find((item) => item.ruleId === next);
              if (!found) return;
              setRuleId(found.ruleId);
              setTopic(found.topic);
              setMode(found.mode);
              if (found.sourceId) setSourceId(found.sourceId);
            }}
            options={rules.map((item) => ({ value: item.ruleId, label: item.label }))}
          />
        </Field>
      )}
      <TextField label="Название правила" value={ruleId} onChange={setRuleId} maxLength={80} info={<p>{tr("Латиница, цифры и дефис, от 8 символов. Сохранение с тем же названием создаёт новую версию правила; прежние срабатывания не меняются.")}</p>} />
      <ProjectChoice projects={projects} projectId={projectId} value={project} onChange={setProject} />
      {!scopeId && <p className="text-xs text-muted-foreground">{tr(DISPATCHER_NO_BB_PROJECT)}</p>}
      {sources.length > 0 ? (
        <Field label="Источник" info={<p>{tr("Откуда приходят события для правила. Источник создаётся на вкладке «Источники».")}</p>}>
          <Choice label="Источник правила" value={selectedSource?.id ?? ""} onChange={setSourceId} options={sources.map((item) => ({ value: item.id, label: `${tr(sourceKindLabel(item.kind))} · ${item.id}` }))} />
        </Field>
      ) : (
        <p className="text-xs text-muted-foreground">{tr("Источников ещё нет: создайте его на вкладке «Источники».")}</p>
      )}
      {definitions.length > 0 && (
        <Field label="Тип события">
          <Choice
            label="Тип для правила"
            value={definitions.some((item) => item.topic === topic) ? topic : definitions[0]!.topic}
            onChange={(next) => {
              const found = definitions.find((item) => item.topic === next);
              if (found) setTopic(found.topic);
            }}
            options={definitions.map((item) => ({ value: item.topic, label: item.label }))}
          />
        </Field>
      )}
      <TextField label="Тема события" value={topic} onChange={setTopic} />
      {scheduled && (
        <div className="space-y-3 rounded-lg border border-border p-3" data-testid="dispatcher-schedule">
          <p className="text-sm font-medium">{tr("Расписание")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Когда (cron)" value={expression} onChange={setExpression} maxLength={120} info={<><p>{tr("Пять полей: минута, час, день месяца, месяц, день недели.")}</p><p>{tr("«0 9 * * 1» — по понедельникам в 9:00; «30 18 * * 1-5» — по будням в 18:30; «0 */4 * * *» — каждые 4 часа.")}</p></>} />
            <TextField label="Часовой пояс" value={timezone} onChange={setTimezone} maxLength={64} info={<p>{tr("Название вида Europe/Madrid. Переход на летнее время учитывается.")}</p>} />
          </div>
          <HintedChoice label="Если запуск пропущен" value={misfire} onChange={setMisfire} options={MISFIRE_OPTIONS} />
          <p className="text-xs text-muted-foreground">
            {preview.error ?? (preview.runs.length ? tr("Ближайшие запуски: {list}", { list: preview.runs.map((run) => new Date(run).toLocaleString(uiLocale(), { timeZone: timezone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })).join(" · ") }) : tr("Считаем ближайшие запуски…"))}
          </p>
        </div>
      )}
      <HintedChoice label="Когда срабатывать" value={mode} onChange={setMode} options={RULE_MODE_OPTIONS} />
      <HintedChoice
        label="Что делать"
        value={actionKind}
        onChange={setActionKind}
        options={[
          { value: "observe", label: "Ничего не создавать", description: "Только запись события и совпадения." },
          { value: "prepare_job", label: "Поручить задачу отделу", description: "Задача руководителю отдела с вашим брифом; данные события прикладываются отдельно, как данные.", hint: ["Текст события никогда не становится инструкцией: сотрудник видит его в блоке «Данные события»."] },
        ]}
      />
      {actionKind === "prepare_job" && (
        <>
          {liveDepartments.length ? (
            <Field label="Отдел" required>
              <Choice label="Отдел для задачи" value={selectedDepartment} onChange={setDepartmentId} options={liveDepartments.map((item) => ({ value: item.recordId!, label: item.name }))} />
            </Field>
          ) : (
            <p className="text-xs text-muted-foreground">{tr("Нужен отдел с сохранённой карточкой.")}</p>
          )}
          <TextField label="Название задачи" value={title} onChange={setTitle} maxLength={180} required />
          <TextField label="Бриф" multiline value={brief} onChange={setBrief} maxLength={8_000} required />
          <TextField label="Критерии приёмки" multiline value={acceptance} onChange={setAcceptance} maxLength={8_000} required />
        </>
      )}
      <Button size="sm" data-testid="dispatcher-save-rule" disabled={!scopeId} onClick={() => void saveRule()}>{tr("Сохранить правило")}</Button>
      {last && <p className="text-sm" data-testid="dispatcher-last-record">{tr("Сохранено: {value}", { value: last })}</p>}
      {diagnostics && (
        <TechnicalDetails>
          {selectedDepartment && <p>{tr("отдел {id}", { id: selectedDepartment })}</p>}
          {selectedSource && <p>{tr("источник {id}", { id: selectedSource.id })}</p>}
        </TechnicalDetails>
      )}
    </div>
  );
}

function EventForms({
  api,
  sources,
  definitions,
  lastSourceId,
  bbProjectId,
  catalogReady,
  notice,
  diagnostics,
  onTick,
}: {
  api: DispatcherApi;
  sources: readonly EventSourceRecord[];
  definitions: readonly EventDefinitionRecord[];
  lastSourceId: string;
  bbProjectId: string;
  catalogReady: boolean;
  notice: (text: string) => void;
  diagnostics: boolean;
  onTick: () => void;
}) {
  const restored = useRef(Boolean(bbProjectId && readIngestDraft(sessionStorage, bbProjectId)));
  const [draft] = useState(() => readIngestDraft(sessionStorage, bbProjectId) ?? emptyIngestDraft(lastSourceId));
  const [sourceId, setSourceId] = useState(draft.sourceId);
  const [eventId, setEventId] = useState(draft.eventId);
  const [accepted, setAccepted] = useState(draft.accepted);
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const [topic, setTopic] = useState(draft.topic);
  const [reference, setReference] = useState(draft.reference);
  const [status, setStatus] = useState("ready");
  const [body, setBody] = useState(draft.body);
  const sourceGone = sources.length > 0 && Boolean(sourceId) && !sources.some((item) => item.id === sourceId);
  useEffect(() => {
    if (!bbProjectId) return;
    writeIngestDraft(sessionStorage, bbProjectId, {
      schema: INGEST_DRAFT_SCHEMA,
      eventId,
      sourceId,
      topic,
      reference,
      body,
      accepted,
    });
  }, [bbProjectId, eventId, sourceId, topic, reference, body, accepted]);
  useEffect(() => {
    if (restored.current && sourceId) return;
    if (lastSourceId && !sourceId) setSourceId(lastSourceId);
  }, [lastSourceId, sourceId]);
  useEffect(() => {
    if (restored.current) return;
    if (sources.length && !sources.some((item) => item.id === sourceId)) {
      setSourceId(sources[0]!.id);
    }
  }, [sources, sourceId]);
  useEffect(() => {
    if (restored.current) return;
    if (definitions.length && !definitions.some((item) => item.topic === topic)) {
      setTopic(definitions[0]!.topic);
    }
  }, [definitions, topic]);

  const ingest = async () => {
    if (sending.current || pending || accepted || !catalogReady || sourceGone) return;
    sending.current = true;
    let parsedBody: Record<string, unknown> = { data: { status } };
    if (diagnostics) {
      try {
        parsedBody = JSON.parse(body) as Record<string, unknown>;
      } catch {
        sending.current = false;
        notice(tr("Проверьте текст события."));
        return;
      }
    }
    const parsed = dispatcherCommand.ingest.safeParse({
      requestId: crypto.randomUUID(),
      sourceId,
      eventId,
      topic,
      reference,
      body: parsedBody,
      depth: 0,
    });
    if (!parsed.success) {
      sending.current = false;
      notice(tr(DISPATCHER_INVALID_FIELDS));
      return;
    }
    setPending(true);
    try {
      const result = await api.ingestInboxEvent(parsed.data);
      if (!result.ok) {
        notice(tr(failureNotice(result.failure)));
        return;
      }
      if (ingestDraftAccepted({ ok: true, duplicate: result.value.duplicate })) {
        setAccepted(true);
        notice(tr(INGEST_ACCEPTED));
        return;
      }
      notice(tr(INGEST_DUPLICATE));
    } catch {
      notice(tr(INGEST_UNKNOWN));
    } finally {
      sending.current = false;
      setPending(false);
    }
  };

  const startNextEvent = () => {
    if (pending) return;
    setEventId(newDraftEventId());
    setAccepted(false);
  };

  const tick = async () => {
    const parsed = dispatcherCommand.tick.safeParse({
      requestId: crypto.randomUUID(),
      live: false,
      limit: 20,
    });
    if (!parsed.success) {
      notice(tr(DISPATCHER_INVALID_FIELDS));
      return;
    }
    const result = await api.dispatchTick(parsed.data);
    if (!result.ok) {
      notice(tr(failureNotice(result.failure)));
      return;
    }
    notice(tr(INTENT_TICK_HINT));
    onTick();
  };

  return (
    <div className="max-w-2xl space-y-4">
      {!catalogReady ? (
        <p className="text-xs text-muted-foreground">{tr(DISPATCHER_NO_BB_PROJECT)}</p>
      ) : sources.length > 0 ? (
        <Field label="Источник">
          {sourceGone ? (
            <p className="text-xs text-muted-foreground">{tr(INGEST_SOURCE_GONE)}</p>
          ) : (
            <Choice
              label="Источник"
              value={sources.some((item) => item.id === sourceId) ? sourceId : ""}
              onChange={setSourceId}
              options={sources.map((item) => ({ value: item.id, label: `${tr(sourceKindLabel(item.kind))} · ${item.id}` }))}
            />
          )}
        </Field>
      ) : (
        <>
          <TextField label="Код источника" value={sourceId} onChange={setSourceId} />
          <p className="text-xs text-muted-foreground">{tr("Код появляется после сохранения источника.")}</p>
        </>
      )}
      {definitions.length > 0 && (
        <Field label="Сохранённый тип">
          <Choice
            label="Тип события"
            value={definitions.some((item) => item.topic === topic) ? topic : definitions[0]!.topic}
            onChange={(next) => {
              const found = definitions.find((item) => item.topic === next);
              if (found) setTopic(found.topic);
            }}
            options={definitions.map((item) => ({ value: item.topic, label: item.label }))}
          />
        </Field>
      )}
      <TextField label="Тема" value={topic} onChange={setTopic} />
      <TextField label="Ссылка на материал" value={reference} onChange={setReference} />
      <TextField label="Статус" value={status} onChange={setStatus} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" data-testid="dispatcher-ingest" disabled={!catalogReady || pending || accepted || sourceGone} onClick={() => void ingest()}>{tr("Принять событие")}</Button>
        {accepted && (
          <Button size="sm" variant="outline" data-testid="dispatcher-next-event" disabled={pending} onClick={startNextEvent}>
            {tr("Следующее событие")}
          </Button>
        )}
        <Button size="sm" variant="outline" data-testid="dispatcher-tick" onClick={() => void tick()}>{tr("Проверить новые")}</Button>
      </div>
      {accepted && <p className="text-xs text-muted-foreground">{tr(INGEST_NEXT_HINT)}</p>}
      {diagnostics && (
        <TechnicalDetails>
          <TextField label="Номер события" value={eventId} onChange={setEventId} />
          <TextField label="Тело JSON" multiline value={body} onChange={setBody} />
        </TechnicalDetails>
      )}
    </div>
  );
}

/**
 * Webhook source: where to send, which topics are allowed and the signing
 * secret. A new secret is shown once; afterwards only when it was issued.
 */
function WebhookSourcePanel({ api, sourceId, notice }: { api: DispatcherApi; sourceId: string; notice: (text: string) => void }) {
  const [view, setView] = useState<{ url: string; issuedAt: string | null; topics: string[] } | null>(null);
  const [topics, setTopics] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!api.getWebhookSource) return;
    let live = true;
    void api.getWebhookSource({ sourceId }).then((result) => {
      if (!live || !result.ok) return;
      setView(result.value);
      setTopics(result.value.topics.join("\n"));
    });
    return () => {
      live = false;
    };
  }, [api, sourceId]);
  if (!api.getWebhookSource || !view) return null;
  const rotate = async () => {
    if (!api.rotateWebhookSecret) return;
    setPending(true);
    const result = await api.rotateWebhookSecret({ sourceId });
    setPending(false);
    if (!result.ok) {
      notice(tr(failureNotice(result.failure)));
      return;
    }
    setView(result.value);
    setSecret(result.value.secret);
  };
  const saveTopics = async () => {
    if (!api.saveSourceTopics) return;
    setPending(true);
    const result = await api.saveSourceTopics({ sourceId, topics: topics.split(/[\s,]+/).filter(Boolean) });
    setPending(false);
    if (!result.ok) {
      notice(tr(failureNotice(result.failure)));
      return;
    }
    setView(result.value);
    notice(tr("Темы источника сохранены."));
  };
  return (
    <section className="space-y-3 rounded-lg border border-border p-3" aria-label={tr("Внешний адрес {id}", { id: sourceId })}>
      <p className="text-sm font-medium">{tr("Внешний адрес · {id}", { id: sourceId })}</p>
      <div className="space-y-1 text-xs">
        <p className="text-muted-foreground">{tr("POST на адрес")}</p>
        <code className="block break-all rounded bg-muted px-2 py-1">{view.url}</code>
        {/^https?:\/\/(127\.0\.0\.1|localhost)/.test(view.url) && <p className="text-amber-700 dark:text-amber-400">{tr("Адрес локальный: внешний сервис до него не достучится. Откройте сервер BB наружу (публикация порта BB Connect или обратный прокси) и отправляйте на тот же путь.")}</p>}
        <p className="text-muted-foreground">{tr("Заголовки:")} <code>x-agency-source-id: {sourceId}</code>, <code>x-agency-timestamp</code> {tr("(секунды),")} <code>{tr("x-agency-signature: v1=HMAC-SHA256(секрет, timestamp + \".\" + тело)")}</code>. {tr("Тело — JSON до 64 КБ.")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">{view.issuedAt ? tr("Секрет выпущен {date}", { date: new Date(view.issuedAt).toLocaleString(uiLocale()) }) : tr("Секрета нет: адрес не принимает события")}</span>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => void rotate()}>{tr(view.issuedAt ? "Сменить секрет" : "Выпустить секрет")}</Button>
      </div>
      {secret && (
        <div role="status" className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          <p className="font-medium">{tr("Скопируйте секрет сейчас — больше он показан не будет. Прежний секрет перестал действовать.")}</p>
          <code className="block break-all">{secret}</code>
          <Button size="sm" variant="ghost" onClick={() => setSecret(null)}>{tr("Скопировал, скрыть")}</Button>
        </div>
      )}
      <TextField label="Разрешённые темы" multiline rows={3} value={topics} onChange={setTopics} placeholder={"order.paid\norder.refunded"} info={<p>{tr("Событие с другой темой адрес отклонит (403). По одной теме на строку.")}</p>} />
      <Button size="sm" disabled={pending} onClick={() => void saveTopics()}>{tr("Сохранить темы")}</Button>
    </section>
  );
}
