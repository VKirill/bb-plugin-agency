import { useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Checkbox } from "../../../components/ui/checkbox";
import type { InstalledPluginRecord, rpcContract } from "../../shared/rpc-contract";
import { failureNotice } from "../data/persist";
import { createRpcAgencyApi, type RpcCaller } from "../data/rpc-agency-api";
import { tr } from "../i18n";
import { PageHead } from "./shared";

/** Plugins that are not offered to employees: the Agency itself and model providers. */
export function employeePluginCandidates(plugins: readonly InstalledPluginRecord[], selected: readonly string[]): InstalledPluginRecord[] {
  return plugins.filter(
    (plugin) =>
      selected.includes(plugin.id) ||
      (plugin.id !== "agency" && !plugin.id.startsWith("provider-") && plugin.running && (plugin.toolNames.length > 0 || plugin.hasSkill)),
  );
}

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

  const rows = employeePluginCandidates(plugins ?? [], selected);
  const missing = selected.filter((id) => plugins && !plugins.some((plugin) => plugin.id === id));
  return (
    <>
      <PageHead
        level={2}
        title="Плагины сотрудника"
        description={tr("Отмечено: {count}. Запуск сотрудника получает навыки и инструкции отмеченных плагинов и разрешение на их инструменты; команда bb <плагин> работает всегда. Остальные плагины BB в его запуск не попадают.", { count: selected.length })}
      />
      {plugins === null ? (
        <p className="text-sm text-muted-foreground">{tr("Читаем установленные плагины…")}</p>
      ) : (
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
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {[
                      plugin.toolNames.length ? tr("инструменты: {names}", { names: plugin.toolNames.join(", ") }) : tr("без инструментов"),
                      plugin.hasSkill ? tr("навык") : null,
                      plugin.cliCommand ? `bb ${plugin.cliCommand}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
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
          {!rows.length && !missing.length && <p className="px-3 py-4 text-sm text-muted-foreground">{tr("В BB нет плагинов с инструментами или навыками для сотрудников.")}</p>}
        </div>
      )}
    </>
  );
}
