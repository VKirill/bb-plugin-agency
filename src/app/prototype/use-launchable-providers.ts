import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../shared/rpc-contract";
import { createRpcAgencyApi, type RpcCaller } from "../data/rpc-agency-api";
import { LAUNCH_PROVIDER_ID } from "../data/role-types";
import { tr } from "../i18n";

/**
 * CLIs the Agency can actually launch on this server, read from launch
 * readiness. Any connected provider can be chosen for a profile; only these
 * run a job. Until the server answers, Claude Code is assumed.
 */
export function useLaunchableProviders(): readonly string[] {
  const rpc = useRpc<typeof rpcContract>();
  const api = useMemo(() => createRpcAgencyApi(rpc as unknown as RpcCaller), [rpc]);
  const [providers, setProviders] = useState<readonly string[]>([LAUNCH_PROVIDER_ID]);
  useEffect(() => {
    let live = true;
    void api.getIsolationReadiness({}).then((result) => {
      if (live && result.ok && result.value.provenIsolationProviders.length) setProviders(result.value.provenIsolationProviders);
    }, () => undefined);
    return () => {
      live = false;
    };
  }, [api]);
  return providers;
}

export function providerLaunchNote(providerId: string, launchable: readonly string[]): string | null {
  if (!providerId || launchable.includes(providerId)) return null;
  return tr("CLI «{providerId}» пока не проходит проверку изолированного запуска в BB: сотрудника можно создать и настроить, но задачу на него Агентство не запустит. Запускаются: {launchable}.", { providerId, launchable: launchable.join(", ") });
}
