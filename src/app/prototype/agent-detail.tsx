import { WorkerContextPanel } from "./worker-context";
import { AgentMetricsPanel } from "./agent-metrics";
import { RecordLifecyclePanel } from "./organization-kit";
import { AgentPluginsPanel } from "./agent-plugins";
import { usePluginFeatures } from "./use-plugin-features";
import { useTemplates } from "./use-templates";
import { useEffect, useState } from "react";
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_PermissionModePicker as PermissionModePicker,
} from "@get-bb/plugin-sdk/app";
import { Switch } from "../../../components/ui/switch";
import type { Agent } from "./data";
import type { BbCatalog } from "../data/store-commands";
import { AGENT_PROFILE_SAVED_HINT, AGENT_PROFILE_STALE_HINT, AGENT_PROFILE_UNSUPPORTED, agentDraftStale, isOwnProfileEcho, persistedAgentDirty } from "../data/agent-profile-fields";
import { demoCapabilityRows, mergeCapabilityChoices } from "../data/capability-catalog";
import { ROLE_TYPE_LABELS, mcpOptions, skillOptions } from "./data";
import { CapabilityChecks } from "./capability-checks";
import { CustomMcpEditor } from "./custom-mcp";
import { AgentMark, Button, Choice, Empty, Field, PageHead, Panel, Rows, SearchInput, TabBar, TextField } from "./shared";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { JOB_DESCRIPTION_LABEL, jobDescriptionKind, jobDescriptionTemplate } from "../data/instruction-templates";
import { AGENT_PASSPORT_RULE_GROUP, AGENT_REVIEW_RULE_GROUP, AGENT_SANDBOX_RULE_GROUP, LIMIT_RULE_GROUP, WorkRulesEditor } from "./work-rules";
import { tr } from "../i18n";
import { AGENT_FALLBACK_LIMIT, addFallback, canAddFallback, fallbackProblems, moveFallback, removeFallback, replaceFallback } from "../data/agent-fallbacks";
import { fallbackProblemText } from "../data/persist";

export function AgentDetail({
  agent,
  update,
  hosts,
  back,
  notice,
  live = false,
  catalog,
  commit,
  policies = [],
  primaryHostId = null,
  folders = [],
}: {
  /** Connected project folders an employee's workplace can be. */
  folders?: { id: string; label: string }[];
  /** The machine BB runs on: the model picker reads its catalog. */
  primaryHostId?: string | null;
  agent: Agent;
  update: (agent: Agent) => void;
  hosts: { id: string; name: string }[];
  back: () => void;
  notice: (message: string) => void;
  live?: boolean;
  catalog?: BbCatalog;
  commit?: (agent: Agent) => void | Promise<boolean>;
  /** Policies the profile may use, described in plain words. */
  policies?: { id: string; summary: string }[];
}) {
  const [tab, setTab] = useState("Обзор");
  const [q, setQ] = useState("");
  const [baseline, setBaseline] = useState(agent);
  const [draft, setDraft] = useState(agent);
  const [pending, setPending] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const features = usePluginFeatures(live);
  const templates = useTemplates();
  const dirty = persistedAgentDirty(baseline, draft);
  const ownEcho = isOwnProfileEcho(draft, agent, baseline);
  const stale = agentDraftStale(baseline, agent) && !ownEcho;
  const routingHost = primaryHostId || hosts[0]?.id;
  const routing = routingHost ? { kind: "host" as const, hostId: routingHost } : undefined;

  useEffect(() => {
    if (pending) return;
    if (ownEcho || !dirty) {
      setBaseline(agent);
      setDraft(agent);
    }
  }, [agent, dirty, ownEcho, pending]);

  const set = (patch: Partial<Agent>) => setDraft((current) => ({ ...current, ...patch }));
  const fallbacks = draft.fallbackSelections ?? [];
  const problems = fallbackProblems(draft.selection, fallbacks);

  const save = async () => {
    if (pending) return;
    if (!commit) {
      update(draft);
      notice(tr("Профиль сохранён в текущем прототипе. Настройки исполнения не применяются."));
      return;
    }
    setPending(true);
    const ok = await Promise.resolve(commit({ ...draft, revision: baseline.revision, recordId: baseline.recordId }));
    setPending(false);
    if (ok === false) return;
  };

  const togglePause = async () => {
    if (pending) return;
    const next = { ...agent, enabled: !agent.enabled };
    if (!commit) {
      update(next);
      return;
    }
    setPending(true);
    await Promise.resolve(commit(next));
    setPending(false);
  };

  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" onClick={back}>
        ← {tr("Сотрудники")}
      </Button>
      <PageHead title={draft.name} description={draft.role}>
        <Button variant="outline" disabled={pending} onClick={() => { if (agent.enabled && live) setConfirmPause(true); else void togglePause(); }}>
          {agent.enabled ? tr("Приостановить") : tr("Активировать")}
        </Button>
        <Button disabled={pending || (Boolean(commit) && !dirty)} onClick={() => void save()}>
          {pending ? tr("Сохраняем…") : tr("Сохранить профиль")}
        </Button>
      </PageHead>
      <p className="text-xs text-muted-foreground">{tr(AGENT_PROFILE_SAVED_HINT)}</p>
      <Dialog open={confirmPause} onOpenChange={(open) => { if (!pending) setConfirmPause(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tr("Приостановить сотрудника")}</DialogTitle>
            <DialogDescription>{tr("Приостановленному нельзя назначить новую задачу и нельзя запустить его. Уже идущие запуски продолжатся, их останавливают в карточке задачи. Открытые задачи переназначьте в их карточках.")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setConfirmPause(false)}>{tr("Отмена")}</Button>
            <Button disabled={pending} onClick={() => { setConfirmPause(false); void togglePause(); }}>{tr("Приостановить")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {dirty && stale && <p className="text-xs text-amber-700 dark:text-amber-400">{tr(AGENT_PROFILE_STALE_HINT)}</p>}
      {dirty && !stale && <p className="text-xs text-muted-foreground">{tr("Есть несохранённые изменения профиля.")}</p>}
      {dirty && live && (agent.liveJobs ?? 0) > 0 && <p className="text-xs text-amber-700 dark:text-amber-400">{tr("У сотрудника задач в работе: {count}. Они доработают на прежней версии профиля, изменения получат только новые запуски.", { count: agent.liveJobs })}</p>}
      <TabBar
        value={tab}
        onChange={(value) => {
          setTab(value);
          setQ("");
        }}
        tabs={live ? ["Обзор", "Инструкции", "Исполнение", "Навыки", "Плагины", "Показатели"] : ["Обзор", "Инструкции", "Исполнение", "Возможности", "История"]}
      />
      <div className="max-w-4xl space-y-4">
        {tab === "Обзор" && (
          <>
            <section className="rounded-xl border border-border bg-muted/30 p-5">
              <div className="flex items-center gap-3">
                <AgentMark id={draft.selection.providerId} className="size-8" />
                <div>
                  <h2 className="text-base font-semibold">{draft.role}</h2>
                  <p className="text-sm text-muted-foreground">
                    {agent.memberships?.length ? agent.memberships.map((row) => `${row.departmentName} · ${tr(ROLE_TYPE_LABELS[row.roleType]).toLowerCase()}`).join("; ") : draft.department || tr("Отдел не назначен")} · {agent.enabled ? tr("Профиль включён") : tr("На паузе")}
                  </p>
                </div>
              </div>
            </section>
            <Panel title="Рабочий профиль">
              <div className="grid gap-4 md:grid-cols-2">
                <TextField label="Имя" value={draft.name} onChange={(name) => set({ name })} />
                <TextField label="Должность" value={draft.role} onChange={(role) => set({ role })} maxLength={80} info={<><p>{tr("Свободный текст на языке команды. Показывается в карточках и в инструкциях руководителю.")}</p><p>{tr("На поведение системы влияет тип роли в отделе, а не должность.")}</p></>} />
                <Field label="Отделы и тип роли" info={<><p>{tr("Тип роли — руководитель, исполнитель или проверяющий — задаётся в «Составе» отдела. Один сотрудник может работать в нескольких отделах с разными типами.")}</p></>}>
                  {agent.memberships?.length ? (
                    <ul className="space-y-1 text-sm">{agent.memberships.map((row) => <li key={row.departmentId}>{row.departmentName} · <span className="text-muted-foreground">{tr(ROLE_TYPE_LABELS[row.roleType]).toLowerCase()}</span></li>)}</ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">{tr("Не состоит в отделе: задачу ему не поручить. Добавьте его в «Составе» отдела.")}</p>
                  )}
                </Field>
                <Field label="Статус" info={<><p>{tr("Статус меняется кнопкой «Приостановить» / «Активировать» вверху.")}</p><p>{tr("Приостановленному нельзя назначить задачу и нельзя запустить его.")}</p></>}>
                  <p className="text-sm">{agent.archived ? tr("В архиве") : agent.enabled ? tr("Профиль включён") : tr("Приостановлен")}</p>
                </Field>
              </div>
            </Panel>
            {live && agent.recordId && (
              <RecordLifecyclePanel
                kind="agent"
                id={agent.recordId}
                name={agent.name}
                archived={Boolean(agent.archived)}
                notice={notice}
                onArchive={async () => (commit ? (await Promise.resolve(commit({ ...agent, archived: true, enabled: false }))) !== false : false)}
                onRestore={async () => (commit ? (await Promise.resolve(commit({ ...agent, archived: false, enabled: true }))) !== false : false)}
                onDeleted={back}
              />
            )}
          </>
        )}
        {tab === "Показатели" && live && <AgentMetricsPanel agentId={agent.id} notice={notice} />}
        {tab === "Плагины" && live && <AgentPluginsPanel selected={draft.plugins ?? []} onChange={(plugins) => set({ plugins })} notice={notice} />}
        {tab === "Инструкции" && (
          <Panel title="Должностная инструкция">
            <TextField
              label="Инструкции сотрудника"
              multiline
              value={draft.instructions}
              onChange={(instructions) => set({ instructions })}
              hint="Пул работ, что не входит в него и кому вернуть, входы, результат и самопроверка. Регламент отдела сюда не копируется: сотрудник получает его отдельно."
            />
            <Button size="sm" variant="outline" className="mt-3" onClick={() => set({ instructions: jobDescriptionTemplate(agent.roleType ?? jobDescriptionKind(draft.role), templates) })}>
              {draft.instructions.trim() ? tr("Заменить шаблоном {kind}", { kind: JOB_DESCRIPTION_LABEL[agent.roleType ?? jobDescriptionKind(draft.role)] }) : tr("Вставить шаблон {kind}", { kind: JOB_DESCRIPTION_LABEL[agent.roleType ?? jobDescriptionKind(draft.role)] })}
            </Button>
          </Panel>
        )}
        {tab === "Исполнение" && live && (
          <>
            <Panel title="Модель">
              <div className="space-y-5">
                <Field label="Основная CLI и модель" info={<><p>{tr("Любой провайдер, подключённый в BB: Claude Code, Codex, Cursor и другие. Уровень рассуждения и быстрый режим выбираются здесь же; набор уровней у каждого CLI свой.")}</p><p>{tr("Смена модели создаёт новую версию профиля. Идущий запуск доработает на прежней.")}</p></>}>
                  <ProviderModelPicker
                    value={draft.selection}
                    onChange={(selection) => set({ selection, reasoningEffort: selection.reasoningLevel })}
                    routing={routing}
                    allowProviderChange
                    align="start"
                  />
                </Field>
                <Field
                  label="Запасные модели"
                  info={
                    <>
                      <p>{tr("Если основная модель не запускается на машине задачи — нет CLI, модели нет в каталоге, провайдер недоступен или закончился лимит, — Агентство берёт первую запасную по порядку, которая запускается. Профиль сотрудника не меняется.")}</p>
                      <p>{tr("Порядок строк — приоритет. Пока список пуст, задача ждёт основную, как раньше. Идущий запуск на другую модель не переключается.")}</p>
                    </>
                  }
                >
                  <div className="space-y-3">
                    {fallbacks.length === 0 && <p className="text-xs text-muted-foreground">{tr("Запасных моделей нет: запуск идёт только на основной.")}</p>}
                    {fallbacks.map((pick, index) => {
                      const problem = problems.find((item) => item.index === index);
                      return (
                        <div key={index} className="space-y-1" data-fallback-row={index}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="w-5 text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                            <ProviderModelPicker
                              value={pick}
                              onChange={(next) => set({ fallbackSelections: replaceFallback(fallbacks, index, next) })}
                              routing={routing}
                              allowProviderChange
                              align="start"
                            />
                            <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => set({ fallbackSelections: moveFallback(fallbacks, index, -1) })}>{tr("Выше")}</Button>
                            <Button size="sm" variant="ghost" disabled={index === fallbacks.length - 1} onClick={() => set({ fallbackSelections: moveFallback(fallbacks, index, 1) })}>{tr("Ниже")}</Button>
                            <Button size="sm" variant="ghost" onClick={() => set({ fallbackSelections: removeFallback(fallbacks, index) })}>{tr("Убрать")}</Button>
                          </div>
                          {problem && <p className="pl-7 text-xs text-destructive">{fallbackProblemText(problem)}</p>}
                        </div>
                      );
                    })}
                    {canAddFallback(fallbacks) ? (
                      <Button size="sm" variant="outline" onClick={() => set({ fallbackSelections: addFallback(fallbacks, draft.selection) })}>{tr("Добавить запасную модель")}</Button>
                    ) : (
                      <p className="text-xs text-muted-foreground">{tr("Не больше {limit} запасных моделей.", { limit: String(AGENT_FALLBACK_LIMIT) })}</p>
                    )}
                  </div>
                </Field>
              </div>
            </Panel>
            <Panel title="Права">
              {policies.length > 1 ? (
                <Field label="Политика прав" info={<><p>{tr("Что сотруднику разрешено: файлы, CLI и машины.")}</p><p>{tr("При запуске права пересекаются с правами проекта: сотрудник не получит больше, чем разрешено проекту. Новая политика создаётся через CLI: bb agency policy create.")}</p></>}>
                  <Choice label="Политика прав" value={draft.policyVersionId ?? ""} onChange={(policyVersionId) => set({ policyVersionId })} options={policies.map((policy) => ({ value: policy.id, label: policy.summary }))} />
                </Field>
              ) : (
                <Rows rows={[["Разрешено", agent.policySummary ?? "Политика не найдена"]]} />
              )}
              <p className="mt-2 text-xs text-muted-foreground">{tr("Права при запуске — пересечение прав сотрудника и проекта: сотрудник не получит больше, чем разрешено проекту.")}</p>
            </Panel>
            {(features.fileGateway || draft.workplaceBindingId) && (
              <Panel title="Рабочее место">
                <Field
                  label="Где работает сотрудник"
                  info={<><p>{tr("По умолчанию сотрудник запускается на машине папки задачи.")}</p><p>{tr("Рабочее место закрепляет его за одной папкой, например на Mac mini с браузером: подзадачи ему ставятся туда, файлы главной задачи он берёт через File Gateway.")}</p></>}
                >
                  <Choice
                    label="Рабочее место сотрудника"
                    value={draft.workplaceBindingId ?? "none"}
                    onChange={(value) => set({ workplaceBindingId: value === "none" ? undefined : value })}
                    options={[
                      { value: "none", label: "Папка задачи" },
                      ...folders.map((folder) => ({ value: folder.id, label: folder.label })),
                      ...(draft.workplaceBindingId && !folders.some((folder) => folder.id === draft.workplaceBindingId)
                        ? [{ value: draft.workplaceBindingId, label: tr("Папка отключена: {id}", { id: draft.workplaceBindingId }) }]
                        : []),
                    ]}
                  />
                </Field>
                {!features.fileGateway && draft.workplaceBindingId && (
                  <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{tr("File Gateway не установлен: рабочее место не действует. Его можно только убрать.")}</p>
                )}
              </Panel>
            )}
            <p className="pt-2 text-xs text-muted-foreground">{tr("Правила сотрудника — лимиты и песочница — сохраняются своей кнопкой и не меняют версию профиля.")}</p>
            {agent.recordId && <details className="rounded-lg border border-border p-4"><summary className="cursor-pointer text-sm font-medium">{tr("Дополнительные настройки контекста")}</summary><div className="mt-4"><WorkerContextPanel scope="agent" scopeId={agent.recordId} notice={notice} /></div></details>}
            <WorkRulesEditor key={agent.id} scope={`agent:${agent.id}`} inheritable notice={notice} groups={[LIMIT_RULE_GROUP("сотрудника", false), AGENT_REVIEW_RULE_GROUP, AGENT_PASSPORT_RULE_GROUP, AGENT_SANDBOX_RULE_GROUP]} saveLabel="Сохранить правила сотрудника" inheritLabel="Как в отделе" />
          </>
        )}
        {tab === "Исполнение" && !live && (
          <>
            <Panel title="CLI и модель">
              <div className="space-y-5">
                <Field label="Машина" hint={AGENT_PROFILE_UNSUPPORTED.host}>
                  {hosts.length ? (
                    <p className="text-sm">{hosts.find((host) => host.id === routingHost)?.name || tr("Каталог машин доступен только для просмотра")}</p>
                  ) : (
                    <p className="text-sm">{tr("Каталог машин пока недоступен.")}</p>
                  )}
                </Field>
                <Field
                  label="CLI и модель"
                  hint={`${AGENT_PROFILE_UNSUPPORTED.reasoning} Сохраняются только CLI и модель.`}
                >
                  <ProviderModelPicker
                    value={draft.selection}
                    onChange={(selection) =>
                      set({
                        selection: {
                          providerId: selection.providerId,
                          model: selection.model,
                          reasoningLevel: draft.selection.reasoningLevel,
                        },
                      })
                    }
                    routing={routing}
                    allowProviderChange
                    align="start"
                  />
                </Field>
                <Field label="Режим разрешений" hint={AGENT_PROFILE_UNSUPPORTED.permission}>
                  <PermissionModePicker providerId={draft.selection.providerId} value={draft.permission} onChange={() => undefined} routing={routing} align="start" disabled />
                </Field>
                <TextField label="Одновременных задач" type="number" value={String(draft.concurrency)} onChange={() => undefined} disabled hint={AGENT_PROFILE_UNSUPPORTED.concurrency} />
              </div>
            </Panel>
            <Panel title="Что получит сотрудник">
              <Rows
                rows={[
                  ["Навыки", draft.skills.join(", ") || "Не выбраны"],
                  ["MCP", draft.mcps.join(", ") || "Не выбраны"],
                  ["CLI", draft.selection.providerId],
                  ["Модель", draft.selection.model || "Выбирается в каталоге BB"],
                  ["Изоляция", "Не проверена — реальный запуск закрыт"],
                ]}
              />
            </Panel>
            <Empty title="Тестовое поручение пока недоступно" description="Здесь появится пробный запуск с просмотром фактически переданных навыков и инструментов." />
          </>
        )}
        {tab === "Навыки" && live && (
          <>
            <PageHead
              level={2}
              title="Навыки сотрудника"
              description={tr("Отмечено: {count}. На VK-сборке этот список ограничивает навыки новой сессии; добавляются служебные навыки Агентства и навыки, выданные под задачу. Исключения отдела и сотрудника задаются в дополнительных настройках контекста.", { count: draft.skills.length })}
            />
            <SearchInput aria-label={tr("Поиск навыков")} placeholder={tr("Найти навык…")} value={q} onChange={(event) => setQ(event.target.value)} />
            <CapabilityChecks
              options={mergeCapabilityChoices(catalog?.skills || [], draft.skills, q)}
              selected={draft.skills}
              onChange={(skills) => set({ skills })}
            />
            {draft.mcps.length > 0 && (
              <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
                <p>{tr("В профиле отмечены MCP ({count}). Запуск Агентства пока не передаёт MCP сотрудникам, и с ними запуск отклоняется.", { count: draft.mcps.length })}</p>
                <Button size="sm" variant="outline" className="mt-2" onClick={() => set({ mcps: [] })}>{tr("Убрать MCP из профиля")}</Button>
              </div>
            )}
          </>
        )}
        {tab === "Возможности" && !live && (
          <>
            <PageHead
              level={2}
              title="Навыки в профиле"
              description={tr("В профиле отмечено: {count}. Это настройка версии сотрудника, не доставка в запуск.", { count: draft.skills.length })}
            />
            <SearchInput aria-label={tr("Поиск навыков")} placeholder={tr("Найти навык…")} value={q} onChange={(event) => setQ(event.target.value)} />
            <CapabilityChecks
              options={mergeCapabilityChoices(live ? catalog?.skills || [] : demoCapabilityRows(skillOptions), draft.skills, q)}
              selected={draft.skills}
              onChange={(skills) => set({ skills })}
            />
            <PageHead
              level={2}
              title="Подключения MCP в профиле"
              description="Отмеченные идентификаторы сохраняются в версии. Строки, которых нет в каталоге, остаются. Это настройка профиля, не ограничение запуска."
            />
            <CapabilityChecks
              options={mergeCapabilityChoices(live ? catalog?.mcps || [] : demoCapabilityRows(mcpOptions), draft.mcps, q)}
              selected={draft.mcps}
              onChange={(mcps) => set({ mcps })}
            />
            <CustomMcpEditor items={draft.customMcps || []} reservedNames={mcpOptions} onChange={() => undefined} disabled />
            <Panel title="Дополнительные возможности">
              <div className="flex items-center justify-between py-3">
                <span className="text-sm">{tr("Команды терминала")}</span>
                <Switch aria-label={tr("Команды терминала")} checked={Boolean(draft.shell)} disabled onCheckedChange={() => undefined} />
              </div>
              <p className="text-xs text-muted-foreground">{tr(AGENT_PROFILE_UNSUPPORTED.shell)}</p>
              <div className="flex items-center justify-between py-3">
                <span className="text-sm">{tr("Передача работы другим сотрудникам")}</span>
                <Switch aria-label={tr("Делегирование")} checked={Boolean(draft.delegate)} disabled onCheckedChange={() => undefined} />
              </div>
              <p className="text-xs text-muted-foreground">{tr(AGENT_PROFILE_UNSUPPORTED.delegate)}</p>
            </Panel>
          </>
        )}
        {tab === "История" && (
          <Panel title="Версии профиля">
            <Rows
              rows={[
                ["Черновик", dirty ? "Несохранённые правки в этой карточке" : "Совпадает с последней записью"],
                ["Сохранение", "Создаёт следующую версию только из поддерживаемых полей"],
              ]}
            />
          </Panel>
        )}
      </div>
    </div>
  );
}
