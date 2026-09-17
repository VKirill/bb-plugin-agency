import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../shared/rpc-contract";
import { DEFAULT_WORK_RULES, type WorkRules } from "../../shared/contracts/work-rules";
import { createRpcAgencyApi, type RpcCaller } from "../data/rpc-agency-api";
import type { RoleType } from "../data/role-types";

/** Provider, model, reasoning and fast mode a new employee of each role type starts with. */
export type RoleDefaults = Record<RoleType, ExperimentalProviderModelPickerValue>;

export function roleDefaultsFromRules(rules: WorkRules): RoleDefaults {
  const pick = (providerId: string, model: string, reasoningLevel: WorkRules["defaultReasoningLead"], serviceTier: WorkRules["defaultServiceTierLead"]): ExperimentalProviderModelPickerValue => ({
    providerId,
    model,
    reasoningLevel,
    ...(serviceTier ? { serviceTier } : {}),
  });
  return {
    lead: pick(rules.defaultProviderLead, rules.defaultModelLead, rules.defaultReasoningLead, rules.defaultServiceTierLead),
    executor: pick(rules.defaultProviderExecutor, rules.defaultModelExecutor, rules.defaultReasoningExecutor, rules.defaultServiceTierExecutor),
    reviewer: pick(rules.defaultProviderReviewer, rules.defaultModelReviewer, rules.defaultReasoningReviewer, rules.defaultServiceTierReviewer),
    assistant: pick(rules.defaultProviderAssistant, rules.defaultModelAssistant, rules.defaultReasoningAssistant, rules.defaultServiceTierAssistant),
  };
}

export const FALLBACK_ROLE_DEFAULTS = roleDefaultsFromRules(DEFAULT_WORK_RULES);

/** What a new employee starts with, from «Настройки → Правила работы». */
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
