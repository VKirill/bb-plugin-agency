import { useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginDirectoryView, rpcContract } from "../../shared/rpc-contract";
import { createRpcAgencyApi, type RpcCaller } from "../data/rpc-agency-api";
import { tr } from "../i18n";
import { Icon } from "./shared";

/** Agency features that appear only with a plugin installed. */
const FEATURES: { pluginId: string; flag: keyof PluginDirectoryView["features"]; name: string; opens: string; without: string }[] = [
  {
    pluginId: "project-folders",
    flag: "projectFolders",
    name: "Projects & Sections",
    opens: "Несколько папок одного проекта на разных машинах; подзадача может работать в другой папке проекта.",
    without: "Без него у проекта в Агентстве одна папка.",
  },
  {
    pluginId: "file-gateway",
    flag: "fileGateway",
    name: "File Gateway",
    opens: "Рабочее место сотрудника на своей машине: его подзадачи запускаются там, файлы переносятся между машинами.",
    without: "Без него сотрудник всегда работает на машине папки проекта.",
  },
];

/** «Настройки → Подключения»: which plugins open which Agency features. */
export function PluginIntegrations() {
  const rpc = useRpc<typeof rpcContract>();
  const api = useMemo(() => createRpcAgencyApi(rpc as unknown as RpcCaller), [rpc]);
  const apiRef = useRef(api);
  apiRef.current = api;
  const [view, setView] = useState<PluginDirectoryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void apiRef.current.listPlugins().then((result) => {
      if (!live) return;
      if (result.ok) setView(result.value);
      else setError(tr("Не удалось прочитать список плагинов BB."));
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <section className="space-y-3 border-b border-border pb-4" aria-label={tr("Плагины BB")}>
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Icon name="Puzzle" className="size-4" />
        {tr("Плагины BB")}
      </h2>
      <p className="text-xs text-muted-foreground">
        {tr("Агентство проверяет установленные плагины на сервере BB, без модели и токенов. Возможность без нужного плагина не показывается.")}
      </p>
      {error && <p role="status" className="text-sm">{error}</p>}
      {!view && !error && <p className="text-sm text-muted-foreground">{tr("Читаем установленные плагины…")}</p>}
      {view && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {FEATURES.map((feature) => {
            const plugin = view.plugins.find((item) => item.id === feature.pluginId);
            const on = view.features[feature.flag];
            return (
              <li key={feature.pluginId} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block font-medium">{feature.name}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{tr(on ? feature.opens : feature.without)}</span>
                </span>
                <span className={`shrink-0 text-xs ${on ? "text-foreground" : "text-muted-foreground"}`}>
                  {on ? tr("установлен · {version}", { version: plugin?.version ?? "" }) : plugin ? tr("выключен") : tr("не установлен")}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        {tr("Инструменты и навыки остальных плагинов выдаются сотрудникам по одному: «Сотрудники → профиль → Плагины».")}
      </p>
    </section>
  );
}
