import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../shared/rpc-contract";
import type { AgencyStatus } from "../../shared/schemas";

export function OverviewPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<AgencyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    rpc.call("status").then(value => { setStatus(value); setError(null); },
      () => setError("Не удалось получить состояние. Повторите попытку."));
  }, [rpc]);
  useEffect(refresh, [refresh]);
  useRealtime("inbox-changed", refresh);
  return <div className="h-full overflow-y-auto p-6">
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold">Агентство</h1>
      <p className="text-muted-foreground">Сотрудники, отделы и поручения. Подготовлен каркас системы.</p>
      {error ? <p role="alert">{error} <button onClick={refresh}>Повторить</button></p> : null}
      <div role="status" className="rounded-lg border border-border p-4">
        {status ? <><p>{status.reason}</p><p className="mt-2">Сохранено уведомлений: {status.inboxCount}</p></> : "Загрузка…"}
      </div>
      <p className="text-sm text-muted-foreground">Создание сотрудников, доски и автоматизации появятся на следующих этапах.</p>
    </div>
  </div>;
}
