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
import { mcpOptions, skillOptions } from "./data";
import { CapabilityChecks } from "./capability-checks";
import { CustomMcpEditor } from "./custom-mcp";
import { AgentMark, Button, Empty, Field, PageHead, Panel, Rows, SearchInput, TabBar, TextField } from "./shared";

export function AgentDetail({
  agent,
  update,
  hosts,
  back,
  notice,
  live = false,
  catalog,
  commit,
}: {
  agent: Agent;
  update: (agent: Agent) => void;
  hosts: { id: string; name: string }[];
  back: () => void;
  notice: (message: string) => void;
  live?: boolean;
  catalog?: BbCatalog;
  commit?: (agent: Agent) => void | Promise<boolean>;
}) {
  const [tab, setTab] = useState("Обзор");
  const [q, setQ] = useState("");
  const [baseline, setBaseline] = useState(agent);
  const [draft, setDraft] = useState(agent);
  const [pending, setPending] = useState(false);
  const dirty = persistedAgentDirty(baseline, draft);
  const ownEcho = isOwnProfileEcho(draft, agent, baseline);
  const stale = agentDraftStale(baseline, agent) && !ownEcho;
  const routingHost = hosts.find((host) => /mini/i.test(host.name))?.id || hosts[0]?.id;
  const routing = routingHost ? { kind: "host" as const, hostId: routingHost } : undefined;

  useEffect(() => {
    if (pending) return;
    if (ownEcho || !dirty) {
      setBaseline(agent);
      setDraft(agent);
    }
  }, [agent, dirty, ownEcho, pending]);

  const set = (patch: Partial<Agent>) => setDraft((current) => ({ ...current, ...patch }));

  const save = async () => {
    if (pending) return;
    if (!commit) {
      update(draft);
      notice("Профиль сохранён в текущем прототипе. Настройки исполнения не применяются.");
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
        ← Сотрудники
      </Button>
      <PageHead title={draft.name} description={draft.role}>
        <Button variant="outline" disabled={pending} onClick={() => void togglePause()}>
          {agent.enabled ? "Приостановить" : "Активировать"}
        </Button>
        <Button disabled={pending || (Boolean(commit) && !dirty)} onClick={() => void save()}>
          {pending ? "Сохраняем…" : "Сохранить профиль"}
        </Button>
      </PageHead>
      <p className="text-xs text-muted-foreground">{AGENT_PROFILE_SAVED_HINT}</p>
      {dirty && stale && <p className="text-xs text-amber-700 dark:text-amber-400">{AGENT_PROFILE_STALE_HINT}</p>}
      {dirty && !stale && <p className="text-xs text-muted-foreground">Есть несохранённые изменения профиля.</p>}
      <TabBar
        value={tab}
        onChange={(value) => {
          setTab(value);
          setQ("");
        }}
        tabs={["Обзор", "Инструкции", "Исполнение", "Возможности", "История"]}
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
                    {draft.department || "Отдел не назначен"} · {agent.enabled ? "Профиль включён" : "На паузе"}
                  </p>
                </div>
              </div>
            </section>
            <Panel title="Рабочий профиль">
              <div className="grid gap-4 md:grid-cols-2">
                <TextField label="Имя" value={draft.name} onChange={(name) => set({ name })} />
                <TextField label="Роль" value={draft.role} onChange={(role) => set({ role })} />
                <Field label="Отдел" hint={AGENT_PROFILE_UNSUPPORTED.department}>
                  <p className="text-sm">{draft.department || "Назначается в карточке отдела"}</p>
                </Field>
                <Field label="Статус" hint="Статус пишется отдельной кнопкой «Приостановить», не вместе с черновиком полей.">
                  <p className="text-sm">{agent.enabled ? "Профиль включён" : "Приостановлен"}</p>
                </Field>
              </div>
            </Panel>
          </>
        )}
        {tab === "Инструкции" && (
          <Panel title="Обязанности и порядок работы">
            <TextField label="Инструкции сотрудника" multiline value={draft.instructions} onChange={(instructions) => set({ instructions })} />
          </Panel>
        )}
        {tab === "Исполнение" && (
          <>
            <Panel title="CLI и модель">
              <div className="space-y-5">
                <Field label="Машина" hint={AGENT_PROFILE_UNSUPPORTED.host}>
                  {hosts.length ? (
                    <p className="text-sm">{hosts.find((host) => host.id === routingHost)?.name || "Каталог машин доступен только для просмотра"}</p>
                  ) : (
                    <p className="text-sm">Каталог машин пока недоступен.</p>
                  )}
                </Field>
                <Field
                  label="CLI и модель"
                  hint={`${AGENT_PROFILE_UNSUPPORTED.reasoning} ${AGENT_PROFILE_UNSUPPORTED.serviceTier} Сохраняются только CLI и модель.`}
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
        {tab === "Возможности" && (
          <>
            <PageHead
              level={2}
              title="Навыки в профиле"
              description={`В профиле отмечено: ${draft.skills.length}. Это настройка версии сотрудника, не доставка в запуск.`}
            />
            <SearchInput aria-label="Поиск навыков" placeholder="Найти навык…" value={q} onChange={(event) => setQ(event.target.value)} />
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
                <span className="text-sm">Команды терминала</span>
                <Switch aria-label="Команды терминала" checked={Boolean(draft.shell)} disabled onCheckedChange={() => undefined} />
              </div>
              <p className="text-xs text-muted-foreground">{AGENT_PROFILE_UNSUPPORTED.shell}</p>
              <div className="flex items-center justify-between py-3">
                <span className="text-sm">Передача работы другим сотрудникам</span>
                <Switch aria-label="Делегирование" checked={Boolean(draft.delegate)} disabled onCheckedChange={() => undefined} />
              </div>
              <p className="text-xs text-muted-foreground">{AGENT_PROFILE_UNSUPPORTED.delegate}</p>
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
