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
import { Button, Choice, Field, PageHead, TabBar, TextField } from "./shared";

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
      <p className="text-xs text-muted-foreground">{INTENT_NO_LIST_RULES}</p>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={diagnostics} onChange={(event) => setDiagnostics(event.target.checked)} data-testid="dispatcher-diagnostics" />
        Диагностика
      </label>
      <TabBar idPrefix="dispatcher-tab" value={tab} onChange={setTab} tabs={["Согласование", "Источники", "Правила", "События"]} />
      {tab === "Согласование" && (
        <div className="space-y-3">
          <Button size="sm" onClick={() => void refresh()}>Обновить</Button>
          {loadError && <p role="status" className="text-sm">{loadError}</p>}
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
      {tab === "Источники" && <SourceForms api={api} projects={projects} projectId={projectId} definitions={definitions} notice={notice} diagnostics={diagnostics} onSaved={() => { void refresh(); }} onSourceSaved={setLastSourceId} />}
      {tab === "Правила" && <RuleForms api={api} projects={projects} projectId={projectId} definitions={definitions} rules={rules} departments={departments} notice={notice} diagnostics={diagnostics} onSaved={() => { void refresh(); }} />}
      {tab === "События" && <EventForms api={api} sources={sources} definitions={definitions} lastSourceId={lastSourceId} bbProjectId={currentBbProjectId} catalogReady={Boolean(currentBbProjectId)} notice={notice} diagnostics={diagnostics} onTick={() => { void refresh(); }} />}
      {sharedBbScope && <p className="text-xs text-muted-foreground">{DISPATCHER_SHARED_BB_SCOPE}</p>}
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
    return <p className="text-xs text-muted-foreground">{DISPATCHER_NO_PROJECT}</p>;
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
  notice,
  diagnostics,
  onSaved,
  onSourceSaved,
}: {
  api: DispatcherApi;
  projects: readonly { id: string; name: string; bbProjectId?: string }[];
  projectId: string;
  definitions: readonly EventDefinitionRecord[];
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
      notice(DISPATCHER_INVALID_FIELDS);
      return;
    }
    const result = await api.saveEventDefinition(parsed.data);
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    setLast(result.value.label);
    notice("Тип события сохранён.");
    onSaved();
  };

  const scopeId = catalogBbProjectId(projects, project);
  const saveSource = async () => {
    const projectIdExact = catalogBbProjectId(projects, project);
    if (!projectIdExact) {
      notice(DISPATCHER_NO_BB_PROJECT);
      return;
    }
    const parsed = dispatcherCommand.saveSource.safeParse({
      requestId: crypto.randomUUID(),
      projectId: projectIdExact,
      kind: sourceKind,
      enabled: sourceEnabled,
    });
    if (!parsed.success) {
      notice(DISPATCHER_INVALID_FIELDS);
      return;
    }
    const result = await api.saveEventSource(parsed.data);
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    setLast(result.value.id);
    onSourceSaved(result.value.id);
    notice(sourceKind === "notify"
      ? "Источник сохранён."
      : "Источник сохранён. События по расписанию и с внешнего адреса пока не приходят.");
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
      {!scopeId && <p className="text-xs text-muted-foreground">{DISPATCHER_NO_BB_PROJECT}</p>}
      <Button size="sm" data-testid="dispatcher-save-definition" onClick={() => void saveDefinition()}>Сохранить тип события</Button>
      <Field label="Откуда приходит">
        <select className="rounded-md border border-border bg-background px-2 py-1 text-sm" value={sourceKind} onChange={(event) => setSourceKind(event.target.value as typeof sourceKind)}>
          <option value="notify">Уведомление</option>
          <option value="webhook">Внешний адрес</option>
          <option value="cron">По расписанию</option>
          <option value="bb_lifecycle">Событие BB</option>
        </select>
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={sourceEnabled} onChange={(event) => setSourceEnabled(event.target.checked)} />
        Принимать события
      </label>
      <Button size="sm" data-testid="dispatcher-save-source" disabled={!scopeId} onClick={() => void saveSource()}>Сохранить источник</Button>
      {last && <p className="text-sm" data-testid="dispatcher-last-record">Сохранено: {last}</p>}
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

function RuleForms({
  api,
  projects,
  projectId,
  definitions,
  rules,
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
  departments: Group[];
  notice: (text: string) => void;
  diagnostics: boolean;
  onSaved: () => void;
}) {
  const [project, setProject] = useState(() => resolveCatalogBindingId(projects, projectId));
  const [topic, setTopic] = useState("research.delivered");
  const [ruleId, setRuleId] = useState("research-review");
  const [mode, setMode] = useState<"disabled" | "observe" | "approve" | "auto">("observe");
  const [actionKind, setActionKind] = useState<"observe" | "prepare_job">("observe");
  const [title, setTitle] = useState("Разобрать поставку");
  const [brief, setBrief] = useState("Проверьте поставленный материал.");
  const [acceptance, setAcceptance] = useState("Есть вывод и ссылка на источник.");
  const [last, setLast] = useState("");
  const departmentId = departments.map((item) => item.recordId).find((id) => id && id.includes("_")) ?? "";
  const scopeId = catalogBbProjectId(projects, project);

  useEffect(() => {
    const found = rules.find((item) => item.ruleId === ruleId);
    if (found || !rules[0]) return;
    setRuleId(rules[0].ruleId);
    setTopic(rules[0].topic);
    setMode(rules[0].mode);
  }, [rules, ruleId]);

  const saveRule = async () => {
    const action = actionKind === "observe"
      ? { kind: "observe" as const }
      : { kind: "prepare_job" as const, departmentId, title, brief, acceptance };
    const projectIdExact = catalogBbProjectId(projects, project);
    if (!projectIdExact) {
      notice(DISPATCHER_NO_BB_PROJECT);
      return;
    }
    const parsed = dispatcherCommand.saveRule.safeParse({
      requestId: crypto.randomUUID(),
      ruleId,
      projectId: projectIdExact,
      topic,
      conditions: [{ field: "topic", op: "equals" as const, value: topic }],
      mode,
      action,
      maxDepth: 12,
      maxRetries: 3,
      enabled: mode !== "disabled",
    });
    if (!parsed.success) {
      notice(DISPATCHER_INVALID_FIELDS);
      return;
    }
    const result = await api.saveRuleVersion(parsed.data);
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    setLast(result.value.ruleId);
    notice(mode === "auto"
      ? "Правило сохранено. Задача сама не создаётся."
      : "Правило сохранено. Предыдущие срабатывания не меняются.");
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
            }}
            options={rules.map((item) => ({ value: item.ruleId, label: item.label }))}
          />
        </Field>
      )}
      {definitions.length > 0 && (
        <Field label="Сохранённый тип">
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
      <TextField label="Название правила" value={ruleId} onChange={setRuleId} />
      <TextField label="Тема события" value={topic} onChange={setTopic} />
      <ProjectChoice projects={projects} projectId={projectId} value={project} onChange={setProject} />
      {!scopeId && <p className="text-xs text-muted-foreground">{DISPATCHER_NO_BB_PROJECT}</p>}
      <Field label="Когда срабатывать">
        <select className="rounded-md border border-border bg-background px-2 py-1 text-sm" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
          <option value="observe">Только записать</option>
          <option value="approve">После согласования</option>
          <option value="auto">Сразу в очередь</option>
          <option value="disabled">Выключено</option>
        </select>
      </Field>
      <Field label="Что делать">
        <select className="rounded-md border border-border bg-background px-2 py-1 text-sm" value={actionKind} onChange={(event) => setActionKind(event.target.value as typeof actionKind)}>
          <option value="observe">Ничего не создавать</option>
          <option value="prepare_job">Подготовить задачу</option>
        </select>
      </Field>
      {actionKind === "prepare_job" && (
        <>
          {!departmentId && <p className="text-xs text-muted-foreground">Нужен отдел с сохранённой карточкой.</p>}
          <TextField label="Название задачи" value={title} onChange={setTitle} />
          <TextField label="Бриф" multiline value={brief} onChange={setBrief} />
          <TextField label="Критерии приёмки" multiline value={acceptance} onChange={setAcceptance} />
        </>
      )}
      <Button size="sm" data-testid="dispatcher-save-rule" disabled={!scopeId} onClick={() => void saveRule()}>Сохранить правило</Button>
      {last && <p className="text-sm" data-testid="dispatcher-last-record">Сохранено: {last}</p>}
      {diagnostics && (
        <TechnicalDetails>
          {departmentId && <p>отдел {departmentId}</p>}
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
        notice("Проверьте текст события.");
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
      notice(DISPATCHER_INVALID_FIELDS);
      return;
    }
    setPending(true);
    try {
      const result = await api.ingestInboxEvent(parsed.data);
      if (!result.ok) {
        notice(failureNotice(result.failure));
        return;
      }
      if (ingestDraftAccepted({ ok: true, duplicate: result.value.duplicate })) {
        setAccepted(true);
        notice(INGEST_ACCEPTED);
        return;
      }
      notice(INGEST_DUPLICATE);
    } catch {
      notice(INGEST_UNKNOWN);
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
      notice(DISPATCHER_INVALID_FIELDS);
      return;
    }
    const result = await api.dispatchTick(parsed.data);
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    notice(INTENT_TICK_HINT);
    onTick();
  };

  return (
    <div className="max-w-2xl space-y-4">
      {!catalogReady ? (
        <p className="text-xs text-muted-foreground">{DISPATCHER_NO_BB_PROJECT}</p>
      ) : sources.length > 0 ? (
        <Field label="Источник">
          {sourceGone ? (
            <p className="text-xs text-muted-foreground">{INGEST_SOURCE_GONE}</p>
          ) : (
            <Choice
              label="Источник"
              value={sources.some((item) => item.id === sourceId) ? sourceId : ""}
              onChange={setSourceId}
              options={sources.map((item) => ({ value: item.id, label: `${sourceKindLabel(item.kind)} · ${item.id}` }))}
            />
          )}
        </Field>
      ) : (
        <>
          <TextField label="Код источника" value={sourceId} onChange={setSourceId} />
          <p className="text-xs text-muted-foreground">Код появляется после сохранения источника.</p>
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
        <Button size="sm" data-testid="dispatcher-ingest" disabled={!catalogReady || pending || accepted || sourceGone} onClick={() => void ingest()}>Принять событие</Button>
        {accepted && (
          <Button size="sm" variant="outline" data-testid="dispatcher-next-event" disabled={pending} onClick={startNextEvent}>
            Следующее событие
          </Button>
        )}
        <Button size="sm" variant="outline" data-testid="dispatcher-tick" onClick={() => void tick()}>Проверить новые</Button>
      </div>
      {accepted && <p className="text-xs text-muted-foreground">{INGEST_NEXT_HINT}</p>}
      {diagnostics && (
        <TechnicalDetails>
          <TextField label="Номер события" value={eventId} onChange={setEventId} />
          <TextField label="Тело JSON" multiline value={body} onChange={setBody} />
        </TechnicalDetails>
      )}
    </div>
  );
}
