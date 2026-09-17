import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../shared/rpc-contract";
import { DEFAULT_WORK_RULES, type WorkRules } from "../../shared/contracts/work-rules";
import { createRpcAgencyApi, type RpcCaller } from "../data/rpc-agency-api";
import type { ReasoningLevel, RoleType } from "../data/role-types";

export type RoleDefaults = { model: Record<RoleType, string>; reasoning: Record<RoleType, ReasoningLevel> };

export function roleDefaultsFromRules(rules: WorkRules): RoleDefaults {
  return {
    model: { lead: rules.defaultModelLead, executor: rules.defaultModelExecutor, reviewer: rules.defaultModelReviewer },
    reasoning: { lead: rules.defaultReasoningLead, executor: rules.defaultReasoningExecutor, reviewer: rules.defaultReasoningReviewer },
  };
}

export const FALLBACK_ROLE_DEFAULTS = roleDefaultsFromRules(DEFAULT_WORK_RULES);

/** Models and reasoning a new employee starts with, from «Настройки → Правила работы». */
export function useRoleDefaults(enabled: boolean): RoleDefaults {
  const rpc = useRpc<typeof rpcContract>();
  const api = useMemo(() => createRpcAgencyApi(rpc as unknown as RpcCaller), [rpc]);
  const [defaults, setDefaults] = useState<RoleDefaults>(FALLBACK_ROLE_DEFAULTS);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void api.getWorkRules({ scope: "agency" }).then(
      (result) => {
        if (live && result.ok) setDefaults(roleDefaultsFromRules(result.value.effective));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, enabled]);
  return defaults;
}
