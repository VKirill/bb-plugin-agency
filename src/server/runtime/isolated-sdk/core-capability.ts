import { z } from "zod";
import { ok, type DomainResult } from "../../../domain";
import {
  HANDSHAKE_PROTOCOL,
  unavailableHandshake,
  type IsolatedCapabilityHandshake,
  type IsolatedCapabilityHandshakePort,
} from "../prepare-run";
import type { ExperimentalIsolatedCapability } from "../prepare-run";

/** Loaded core contract. Not env JSON. Fingerprint is schema inventory, not OS isolation. */
export const CORE_SPAWN_CONTRACT_PATH = "/api/v1/system/experimental_thread-spawn-contract";
export const CORE_SPAWN_CONTRACT_PROTOCOL = "bb-experimental-thread-spawn-contract-v1" as const;

export const REQUIRED_CREATE_KEYS = [
  "experimental_callerLaunchId",
  "experimental_callerAttemptId",
  "experimental_callerJobId",
  "isolatedSkillDelivery",
  "skillIds",
  "originPluginId",
] as const;

/** Spawn fields that let a launch receive selected plugin tools and instructions. */
export const CONTEXT_ALLOWLIST_KEYS = ["dynamicToolNames", "instructionPluginIds", "allowBridgeToolProxy"] as const;

export const REQUIRED_LIST_KEYS = ["experimental_callerLaunchId", "originPluginId", "includeHidden"] as const;
export const REQUIRED_RESPONSE_KEYS = [
  "experimental_callerLaunchId",
  "experimental_callerAttemptId",
  "experimental_callerJobId",
] as const;

export const experimentalThreadSpawnContractSchema = z
  .object({
    protocol: z.literal(CORE_SPAWN_CONTRACT_PROTOCOL),
    appVersion: z.string().min(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    createThreadRequestKeys: z.array(z.string().min(1)),
    threadListQueryKeys: z.array(z.string().min(1)),
    threadResponseKeys: z.array(z.string().min(1)),
    persist: z.object({
      table: z.literal("thread_caller_launches"),
      unique: z.tuple([z.literal("origin_plugin_id"), z.literal("caller_launch_id")]),
    }),
    policies: z.object({
      forkDoesNotInheritCallerIdentity: z.literal(true),
      hiddenVisibilitySupported: z.literal(true),
    }),
  })
  .strict();

export type ExperimentalThreadSpawnContract = z.infer<typeof experimentalThreadSpawnContractSchema>;

const ALL_FALSE: ExperimentalIsolatedCapability = {
  isolatedSkillDelivery: false,
  skillIds: false,
  originPluginId: false,
  experimental_callerLaunchId: false,
  experimental_callerAttemptId: false,
  experimental_callerJobId: false,
  uniqueLookupFork: false,
  forkDoesNotInheritIdentity: false,
  threadVisibilityHidden: false,
};

function hasAll(keys: readonly string[], required: readonly string[]): boolean {
  const set = new Set(keys);
  return required.every((key) => set.has(key));
}

export function handshakeFromSpawnContract(value: unknown): IsolatedCapabilityHandshake {
  const parsed = experimentalThreadSpawnContractSchema.safeParse(value);
  if (!parsed.success) return unavailableHandshake();
  const contract = parsed.data;
  const createOk = hasAll(contract.createThreadRequestKeys, REQUIRED_CREATE_KEYS);
  const listOk = hasAll(contract.threadListQueryKeys, REQUIRED_LIST_KEYS);
  const responseOk = hasAll(contract.threadResponseKeys, REQUIRED_RESPONSE_KEYS);
  const persistOk =
    contract.persist.table === "thread_caller_launches" &&
    contract.persist.unique[0] === "origin_plugin_id" &&
    contract.persist.unique[1] === "caller_launch_id";
  const policiesOk =
    contract.policies.forkDoesNotInheritCallerIdentity === true &&
    contract.policies.hiddenVisibilitySupported === true;
  if (!createOk || !listOk || !responseOk || !persistOk || !policiesOk) {
    return unavailableHandshake();
  }
  const capabilities: ExperimentalIsolatedCapability = {
    isolatedSkillDelivery: true,
    skillIds: true,
    originPluginId: true,
    experimental_callerLaunchId: true,
    experimental_callerAttemptId: true,
    experimental_callerJobId: true,
    uniqueLookupFork: true,
    forkDoesNotInheritIdentity: true,
    threadVisibilityHidden: true,
  };
  return {
    protocol: HANDSHAKE_PROTOCOL,
    capabilities,
    extensions: {
      contextAllowlists: hasAll(contract.createThreadRequestKeys, CONTEXT_ALLOWLIST_KEYS),
      permissionMode: hasAll(contract.createThreadRequestKeys, ["permissionMode"]),
    },
  };
}

export function createCoreCapabilityHandshakePort(deps: {
  /** Prefer `bb.server.experimental_appUrl`; loopback only if that is null. */
  baseUrl: () => string | null;
  fetchImpl?: typeof fetch;
}): IsolatedCapabilityHandshakePort {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    async probe(): Promise<DomainResult<IsolatedCapabilityHandshake>> {
      let base: string | null;
      try {
        base = deps.baseUrl();
      } catch {
        return ok(unavailableHandshake());
      }
      if (!base || !base.trim()) return ok(unavailableHandshake());
      try {
        const response = await fetchImpl(`${base.replace(/\/+$/u, "")}${CORE_SPAWN_CONTRACT_PATH}`, {
          method: "GET",
          headers: { accept: "application/json" },
        });
        if (!response.ok) return ok(unavailableHandshake());
        return ok(handshakeFromSpawnContract(await response.json()));
      } catch {
        return ok(unavailableHandshake());
      }
    },
  };
}

/** @deprecated path name — use CORE_SPAWN_CONTRACT_PATH */
export const CORE_CAPABILITY_PATH = CORE_SPAWN_CONTRACT_PATH;
