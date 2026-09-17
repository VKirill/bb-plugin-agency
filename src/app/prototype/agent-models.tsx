import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { AgentModelsView, rpcContract } from "../../shared/rpc-contract";
import { Button, Panel } from "./shared";
import { tr } from "../i18n";

/**
 * The same Agency on another BB has other CLIs connected. This says which employees stand on a
 * model this machine cannot run, and moves them to the closest one that it can.
 */

type Result = { ok: true; value: AgentModelsView } | { ok: false };

const STATUS_LABEL: Record<AgentModelsView["rows"][number]["status"], string> = {
  exact: "Модель подключена",
  substituted: "Есть замена",
  missing: "Нет модели",
  unchanged: "Без изменений",
  repaired: "Переведён",
  blocked: "Не удалось",
};

export function AgentModelsPanel({ notice }: { notice: (text: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<AgentModelsView | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);

  const load = (result: unknown) => {
    const value = result as Result;
    if (value && value.ok) setView(value.value);
    else setFailed(true);
  };

  useEffect(() => {
    let live = true;
    void Promise.resolve(rpc.call("agentModels", null)).then(
      (result) => { if (live) load(result); },
      () => { if (live) setFailed(true); },
    );
    return () => { live = false; };
  }, [rpc]);

  const repair = async () => {
    if (pending) return;
    setPending(true);
    try {
      const result = (await rpc.call("repairAgentModels", {})) as Result;
      if (!result.ok) {
        notice(tr("Не удалось перевести сотрудников на доступные модели."));
        return;
      }
      setView(result.value);
      const moved = result.value.rows.filter((row) => row.status === "repaired").length;
      notice(moved ? tr("Переведено сотрудников: {count}. У каждого новая версия профиля.", { count: moved }) : tr("Переводить некого."));
    } catch {
      notice(tr("Не удалось перевести сотрудников на доступные модели."));
    } finally {
      setPending(false);
    }
  };

  if (failed) return <Panel title="Модели сотрудников"><p className="text-sm text-muted-foreground">{tr("Не удалось прочитать модели сотрудников.")}</p></Panel>;
  if (!view) return <Panel title="Модели сотрудников"><p className="text-sm text-muted-foreground">{tr("Проверяем модели сотрудников…")}</p></Panel>;

  const problems = view.rows.filter((row) => row.status !== "exact" && row.status !== "repaired");
  const repairable = view.rows.some((row) => row.status === "substituted");

  return (
    <Panel title="Модели сотрудников">
      <div className="space-y-3" data-testid="agent-models">
        <p className="text-sm text-muted-foreground">
          {tr("Сверка профилей с тем, что подключено в этом BB. Модель, которой здесь нет, запуск не начинает: сотрудника видно тут, а причина — в готовности задачи.")}
        </p>
        {view.catalogUnavailable ? (
          <p className="text-sm">{tr("BB не отдал список моделей: сверять не с чем, запуски ничем не ограничены.")}</p>
        ) : problems.length === 0 ? (
          <p className="text-sm">{tr("Все сотрудники стоят на подключённых моделях.")}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{tr("Сотрудник")}</th>
                  <th className="px-3 py-2 font-medium">{tr("Сейчас")}</th>
                  <th className="px-3 py-2 font-medium">{tr("Замена")}</th>
                  <th className="px-3 py-2 font-medium">{tr("Состояние")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {problems.map((row) => (
                  <tr key={row.agentId}>
                    <td className="px-3 py-2">{row.name}</td>
                    <td className="px-3 py-2 font-mono text-xs">{row.model} · {row.providerId}</td>
                    <td className="px-3 py-2 font-mono text-xs">{row.suggestedModel ? `${row.suggestedModel} · ${row.suggestedProviderId}` : "—"}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{tr(STATUS_LABEL[row.status])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {repairable && (
          <Button size="sm" onClick={() => void repair()} disabled={pending}>{tr("Перевести на доступные модели")}</Button>
        )}
      </div>
    </Panel>
  );
}
