import type { DispatcherLaunchPort } from "../dispatcher/ports.js";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { rpcContract } from "../../shared/rpc-contract";
import type { SqlDatabase } from "../db/sql";
import { resolveRpcAccess, type RpcAccess } from "./auth";
import {
  approveActionIntent,
  claimActionIntent,
  completeActionIntent,
  dispatchTick,
  ingestInboxEvent,
  listActionIntents,
  listEventDefinitions,
  listEventSources,
  listRuleVersions,
  saveEventDefinition,
  saveEventSource,
  saveRuleVersion,
} from "../dispatcher/engine.js";

type DispatcherMethod =
  | "saveEventDefinition"
  | "saveEventSource"
  | "saveRuleVersion"
  | "listEventDefinitions"
  | "listEventSources"
  | "listRuleVersions"
  | "ingestInboxEvent"
  | "dispatchTick"
  | "listActionIntents"
  | "claimActionIntent"
  | "approveActionIntent"
  | "completeActionIntent";

type DispatcherHandlers = Pick<PluginRpcHandlers<typeof rpcContract>, DispatcherMethod>;

export function createDispatcherRpc(deps: { db: SqlDatabase; launch?: DispatcherLaunchPort }): DispatcherHandlers {
  const { db } = deps;
  const engine = { db, launch: deps.launch };
  const withAccess = <T>(run: (access: RpcAccess) => T) => {
    const access = resolveRpcAccess(db);
    if (!access.ok) return access;
    return run(access.value);
  };
  return {
    saveEventDefinition: (input) => withAccess((access) => saveEventDefinition(engine, access.ctx, input)),
    saveEventSource: (input) => withAccess((access) => saveEventSource(engine, access.ctx, input)),
    saveRuleVersion: (input) => withAccess((access) => saveRuleVersion(engine, access.ctx, input)),
    listEventDefinitions: (input) => listEventDefinitions(engine, input),
    listEventSources: (input) => listEventSources(engine, input),
    listRuleVersions: (input) => listRuleVersions(engine, input),
    ingestInboxEvent: (input) => withAccess((access) => ingestInboxEvent(engine, access.ctx, input)),
    dispatchTick: (input) => withAccess((access) => dispatchTick(engine, access.ctx, input)),
    listActionIntents: (input) => listActionIntents(engine, input),
    claimActionIntent: (input) => withAccess((access) => claimActionIntent(engine, access.ctx, input)),
    approveActionIntent: (input) => withAccess((access) => approveActionIntent(engine, access.ctx, input)),
    completeActionIntent: (input) => withAccess((access) => completeActionIntent(engine, access.ctx, input)),
  };
}
