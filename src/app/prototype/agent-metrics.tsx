import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { AgentMetricsView, rpcContract } from "../../shared/rpc-contract";
import { failureNotice } from "../data/persist";
import { relativeAge } from "../data/job-attention";
import { createRpcAgencyApi, type RpcCaller } from "../data/rpc-agency-api";
import { tr } from "../i18n";
import { InfoHint, Panel } from "./shared";

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2.5">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        {tr(label)}
        <InfoHint title={label}>
          <p>{tr(hint)}</p>
        </InfoHint>
      </div>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/** What the employee holds and how its work went: numbers from the Agency data. */
export function AgentMetricsPanel({ agentId, notice }: { agentId: string; notice: (text: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const api = useMemo(() => createRpcAgencyApi(rpc as unknown as RpcCaller), [rpc]);
  const [metrics, setMetrics] = useState<AgentMetricsView | null>(null);
  useEffect(() => {
    let live = true;
    void api.agentMetrics({ agentId }).then((result) => {
      if (!live) return;
      if (result.ok) setMetrics(result.value);
      else notice(failureNotice(result.failure));
    });
    return () => {
      live = false;
    };
  }, [api, agentId, notice]);
  if (!metrics) return <p className="text-sm text-muted-foreground">{tr("Считаем показатели…")}</p>;
  const dash = "—";
  return (
    <div className="space-y-4">
      <Panel title="Сейчас">
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Открытые задачи" value={String(metrics.open)} hint="Назначенные сотруднику задачи, которые ещё не готовы и не отменены." />
          <Metric label="Ждут решения или ответа" value={String(metrics.blocked)} hint="Из открытых: в «Ожидает решения» или «Ждёт ответа»." />
          <Metric label="На проверке" value={String(metrics.inReview)} hint="Сданные версии, которые ждут проверки или приёмки." />
        </div>
      </Panel>
      <Panel title="Результаты">
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Готово за 30 дней" value={String(metrics.done30d)} hint="Задачи сотрудника, закрытые как готовые за последние 30 дней." />
          <Metric label="Без доработок" value={metrics.firstPassPercent === null ? dash : `${metrics.firstPassPercent}%`} hint="Доля готовых за 90 дней задач, которые ни разу не возвращались на доработку." />
          <Metric label="Медианный срок" value={metrics.medianLeadHours === null ? dash : tr("{hours} ч", { hours: metrics.medianLeadHours })} hint="Половина готовых за 90 дней задач закрыта быстрее этого срока — от создания до готовности." />
          <Metric label="Возвратов на доработку" value={String(metrics.reworkReturns90d)} hint="Сколько раз версии сотрудника возвращали с замечаниями за 90 дней." />
          <Metric label="Отменено за 30 дней" value={String(metrics.canceled30d)} hint="Задачи сотрудника, отменённые за последние 30 дней." />
          <Metric label="Расход за 30 дней" value={metrics.spendUsdCents30d === null ? dash : `$${(metrics.spendUsdCents30d / 100).toFixed(2)}`} hint="Оценка стоимости попыток за 30 дней по ценам API. Для CLI без подтверждённого расхода — прочерк." />
        </div>
      </Panel>
      <Panel title="Запуски">
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Попыток за 30 дней" value={String(metrics.attempts30d)} hint="Сколько раз задачи сотрудника запускались." />
          <Metric label="Сбоев" value={String(metrics.failedAttempts30d)} hint="Попытки, завершённые сбоем: ошибка CLI, машины или провайдера." />
          <Metric label="Последняя активность" value={metrics.lastActivityAt && relativeAge(metrics.lastActivityAt, Date.now()) ? tr("{age} назад", { age: relativeAge(metrics.lastActivityAt, Date.now()) }) : dash} hint="Когда сотрудник последний раз писал в историю задач." />
        </div>
      </Panel>
    </div>
  );
}
