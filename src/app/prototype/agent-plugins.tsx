import { useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Checkbox } from "../../../components/ui/checkbox";
import type { InstalledPluginRecord, rpcContract } from "../../shared/rpc-contract";
import { failureNotice } from "../data/persist";
import { createRpcAgencyApi, type RpcCaller } from "../data/rpc-agency-api";
import { tr } from "../i18n";
import { Button, InfoHint, PageHead } from "./shared";

/** What a plugin gives an employee's launch. A plugin with none of these only changes the BB interface. */
export type PluginContribution = "instructions" | "skill" | "tools";

export function pluginContributions(plugin: InstalledPluginRecord): PluginContribution[] {
  return [
    ...(plugin.hasInstructions ? (["instructions"] as const) : []),
    ...(plugin.hasSkill ? (["skill"] as const) : []),
    ...(plugin.toolNames.length ? (["tools"] as const) : []),
  ];
}

/**
 * Plugins offered to employees: running, not the Agency or a model provider, and giving
 * the launch something. Interface-only plugins (file viewers, themes) are left out; a
 * selected plugin stays visible so it can be taken out.
 */
export function employeePluginCandidates(plugins: readonly InstalledPluginRecord[], selected: readonly string[]): InstalledPluginRecord[] {
  return plugins.filter(
    (plugin) =>
      selected.includes(plugin.id) ||
      (plugin.id !== "agency" && !plugin.id.startsWith("provider-") && plugin.running && pluginContributions(plugin).length > 0),
  );
}

/** Running plugins hidden because they only change the interface. */
export function interfaceOnlyPlugins(plugins: readonly InstalledPluginRecord[]): InstalledPluginRecord[] {
  return plugins.filter((plugin) => plugin.id !== "agency" && !plugin.id.startsWith("provider-") && plugin.running && !pluginContributions(plugin).length);
}

const FILTERS: { value: "all" | PluginContribution; label: string; hint: string }[] = [
  { value: "all", label: "Все", hint: "Все плагины, которые что-то дают запуску сотрудника." },
  { value: "instructions", label: "Инструкции", hint: "Добавляют раздел в системное сообщение сессии: правила, когда и как пользоваться плагином." },
  { value: "skill", label: "Навыки", hint: "Дают навык: подробную инструкцию, которую агент открывает, когда задача её требует." },
  { value: "tools", label: "Инструменты", hint: "Дают инструменты, которые агент вызывает сам. Сейчас BB передаёт их сотруднику только командой bb <плагин>." },
];

const CONTRIBUTION_LABEL: Record<PluginContribution, string> = {
  instructions: "инструкции",
  skill: "навык",
  tools: "инструменты",
};

/** Plugins whose tools reach secrets or change settings get an explicit warning. */
const PLUGIN_WARNINGS: Record<string, string> = {
  "env-catalog": "Сотрудник получит все ключи Env Catalog и сможет их менять и удалять. Конкретный ключ безопаснее выдать через секреты в правах сотрудника.",
};

/**
 * Plugins an employee's launch receives: their tools, instructions and skills.
 * Only installed plugins are listed; one that was removed or turned off stays
 * visible while selected, so the owner can take it out of the profile.
 */
export function AgentPluginsPanel({ selected, onChange, notice }: { selected: string[]; onChange: (ids: string[]) => void; notice: (text: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const api = useMemo(() => createRpcAgencyApi(rpc as unknown as RpcCaller), [rpc]);
  const apiRef = useRef(api);
  apiRef.current = api;
  const noticeRef = useRef(notice);
  noticeRef.current = notice;
  const [plugins, setPlugins] = useState<InstalledPluginRecord[] | null>(null);
  const [filter, setFilter] = useState<"all" | PluginContribution>("all");
  useEffect(() => {
    let live = true;
    void apiRef.current.listPlugins().then((result) => {
      if (!live) return;
      if (result.ok) setPlugins(result.value.plugins);
      else {
        setPlugins([]);
        noticeRef.current(failureNotice(result.failure));
      }
    });
    return () => {
      live = false;
    };
  }, []);

  const candidates = employeePluginCandidates(plugins ?? [], selected);
  const rows = filter === "all" ? candidates : candidates.filter((plugin) => pluginContributions(plugin).includes(filter));
  const hidden = interfaceOnlyPlugins(plugins ?? []).filter((plugin) => !selected.includes(plugin.id));
  const missing = selected.filter((id) => plugins && !plugins.some((plugin) => plugin.id === id));
  return (
    <>
      <PageHead
        level={2}
        title="Плагины сотрудника"
        description={tr("Отмечено: {count}. Эти плагины включаются в пакет задания. Чтобы ограничить загрузку остальных плагинов в сессию, настройте служебный контекст на вкладке «Навыки».", { count: selected.length })}
      />
      {plugins === null ? (
        <p className="text-sm text-muted-foreground">{tr("Читаем установленные плагины…")}</p>
      ) : (
        <>
        <div className="flex flex-wrap items-center gap-1 pb-2 text-xs" role="group" aria-label={tr("Показать плагины")}>
          {FILTERS.map((item) => {
            const count = item.value === "all" ? candidates.length : candidates.filter((plugin) => pluginContributions(plugin).includes(item.value as PluginContribution)).length;
            return (
              <Button key={item.value} size="sm" variant={filter === item.value ? "secondary" : "ghost"} className="h-7 px-2 text-xs" aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>
                {tr("{label} · {count}", { label: tr(item.label), count })}
              </Button>
            );
          })}
          <InfoHint title="Что дают плагины">
            {FILTERS.slice(1).map((item) => (
              <p key={item.value}>
                <b>{tr(item.label)}</b> — {tr(item.hint)}
              </p>
            ))}
          </InfoHint>
        </div>
        <div className="divide-y divide-border rounded-lg border border-border" data-testid="agent-plugins">
          {rows.map((plugin) => {
            const checked = selected.includes(plugin.id);
            const warning = PLUGIN_WARNINGS[plugin.id];
            return (
              <label key={plugin.id} className="flex cursor-pointer items-start gap-2 px-3 py-2 text-sm hover:bg-muted/50">
                <Checkbox
                  className="mt-0.5"
                  aria-label={plugin.name}
                  checked={checked}
                  onCheckedChange={(value) => onChange(value ? [...selected, plugin.id] : selected.filter((id) => id !== plugin.id))}
                />
                <span className="min-w-0">
                  <span className="block font-medium">{plugin.name}</span>
                  {plugin.description && <span className="mt-0.5 block text-xs text-muted-foreground">{plugin.description}</span>}
                  <span className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground" data-testid={`plugin-tags-${plugin.id}`}>
                    {pluginContributions(plugin).map((kind) => (
                      <span key={kind} className="rounded border border-border px-1.5 py-px text-[11px] leading-4 text-foreground">
                        {tr(CONTRIBUTION_LABEL[kind])}
                      </span>
                    ))}
                    {plugin.toolNames.length > 0 && <span className="font-mono text-[11px]">{plugin.toolNames.join(", ")}</span>}
                    {plugin.cliCommand && <span className="font-mono text-[11px]">{`bb ${plugin.cliCommand}`}</span>}
                  </span>
                  {!plugin.running && <span className="mt-1 block text-xs text-amber-700 dark:text-amber-400">{tr("Плагин выключен в BB: запуск сотрудника не пройдёт, пока он отмечен.")}</span>}
                  {warning && checked && <span className="mt-1 block text-xs text-amber-700 dark:text-amber-400">{tr(warning)}</span>}
                </span>
              </label>
            );
          })}
          {missing.map((id) => (
            <label key={id} className="flex cursor-pointer items-start gap-2 px-3 py-2 text-sm hover:bg-muted/50">
              <Checkbox className="mt-0.5" aria-label={id} checked onCheckedChange={() => onChange(selected.filter((item) => item !== id))} />
              <span className="min-w-0">
                <span className="block font-medium">{id}</span>
                <span className="mt-1 block text-xs text-amber-700 dark:text-amber-400">{tr("Плагин не установлен в BB: снимите галочку, иначе запуск сотрудника не пройдёт.")}</span>
              </span>
            </label>
          ))}
          {!rows.length && !missing.length && <p className="px-3 py-4 text-sm text-muted-foreground">{tr(filter === "all" ? "В BB нет плагинов с инструкциями, навыками или инструментами для сотрудников." : "Под этот фильтр плагинов нет.")}</p>}
        </div>
        {hidden.length > 0 && (
          <p className="pt-2 text-xs text-muted-foreground" title={hidden.map((plugin) => plugin.name).join(", ")}>
            {tr("Не показаны плагины, которые меняют только интерфейс BB, — сотруднику они ничего не дают: {names}.", { names: hidden.map((plugin) => plugin.name).join(", ") })}
          </p>
        )}
        </>
      )}
    </>
  );
}
