import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { officialSdkAllowsIsolatedSpawn } from "./sdk-isolation-contract.js";
import type {
  IsolatedThreadListArgs,
  IsolatedThreadSpawnArgs,
  OfficialThreadListArgs,
  OfficialThreadSpawnArgs,
} from "./sdk-isolation-contract.js";
import {
  isDispatchedUserRow,
  listObjects,
  queuedMessageHoldsToken,
  readQueuedMessageId,
} from "./continuation-evidence.js";
import type { IsolatedThreadSendArgs } from "./send-port.js";
import type { IsolatedThreadView, IsolatedThreadsApi } from "./sdk-ports.js";

function readOptionalString(record: object, key: string): string | undefined {
  const value = Reflect.get(record, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readOptionalNumber(record: object, key: string): number | undefined {
  const value = Reflect.get(record, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNested(record: object, key: string): object | null | undefined {
  const value = Reflect.get(record, key);
  if (value === null) return null;
  if (value && typeof value === "object") return value as object;
  return undefined;
}

/** Map a threads.get/list row without asserting SDK result types. */
export function isolatedViewFromRecord(value: object): IsolatedThreadView {
  const host = readNested(value, "host");
  const environment = readNested(value, "environment");
  return {
    id: readOptionalString(value, "id") ?? "",
    status: readOptionalString(value, "status"),
    projectId: readOptionalString(value, "projectId"),
    providerId: readOptionalString(value, "providerId"),
    model: readOptionalString(value, "model"),
    environmentId: readOptionalString(value, "environmentId"),
    experimental_callerLaunchId: readOptionalString(value, "experimental_callerLaunchId"),
    experimental_callerAttemptId: readOptionalString(value, "experimental_callerAttemptId"),
    experimental_callerJobId: readOptionalString(value, "experimental_callerJobId"),
    ...(readOptionalNumber(value, "updatedAt") !== undefined ? { updatedAt: readOptionalNumber(value, "updatedAt") } : {}),
    ...(readOptionalNumber(value, "activeBackgroundAgentCount") !== undefined
      ? { activeBackgroundAgentCount: readOptionalNumber(value, "activeBackgroundAgentCount") }
      : {}),
    host: host ? { id: readOptionalString(host, "id") ?? "" } : null,
    environment: environment
      ? {
          id: readOptionalString(environment, "id"),
          hostId: readOptionalString(environment, "hostId"),
          path: readOptionalString(environment, "path") ?? null,
        }
      : null,
  };
}

/**
 * Compile-true mapping. Pin 0.4.87-agy16.431; public 0.4.87 fails this assignability.
 * Core `resolveProjectExecutionDefaultsForCreate` ignores a spawn field when
 * `executionInputSources` is present and that field's source is omitted — project
 * defaults then win. SDK source enum: `explicit` | `client-preference`.
 */
function officialSpawnArgs(args: IsolatedThreadSpawnArgs): OfficialThreadSpawnArgs {
  return {
    projectId: args.projectId,
    providerId: args.providerId,
    model: args.model,
    prompt: args.prompt,
    environment: args.environment,
    isolatedSkillDelivery: args.isolatedSkillDelivery,
    skillIds: args.skillIds,
    visibility: args.visibility,
    experimental_callerLaunchId: args.experimental_callerLaunchId,
    experimental_callerAttemptId: args.experimental_callerAttemptId,
    ...(args.experimental_callerJobId ? { experimental_callerJobId: args.experimental_callerJobId } : {}),
    executionInputSources: {
      providerId: "explicit" as const,
      model: "explicit" as const,
      ...(args.reasoningLevel ? { reasoningLevel: "explicit" as const } : {}),
      ...(args.permissionMode ? { permissionMode: "explicit" as const } : {}),
    },
    ...(args.reasoningLevel ? { reasoningLevel: args.reasoningLevel } : {}),
    ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
    ...(args.instructionPluginIds?.length ? { instructionPluginIds: args.instructionPluginIds } : {}),
    ...(args.dynamicToolNames?.length ? { dynamicToolNames: args.dynamicToolNames } : {}),
    ...(args.allowBridgeToolProxy ? { allowBridgeToolProxy: true } : {}),
  };
}

function officialListArgs(args?: IsolatedThreadListArgs): OfficialThreadListArgs {
  return {
    ...(args?.experimental_callerLaunchId
      ? { experimental_callerLaunchId: args.experimental_callerLaunchId }
      : {}),
    ...(args?.includeHidden !== undefined ? { includeHidden: args.includeHidden } : {}),
    ...(args?.projectId ? { projectId: args.projectId } : {}),
  };
}

/**
 * Typed spawn/list on compile pin 0.4.87-agy16.431. No casts.
 * Runtime spawn is still gated by GET experimental_thread-spawn-contract
 * (`createIsolatedSpawnPort(..., supported)`). Engines / ordinary 0.4.87 ≠ readiness.
 */
export function bindOfficialThreads(threads: BbPluginApi["sdk"]["threads"]): IsolatedThreadsApi {
  return {
    async spawn(args: IsolatedThreadSpawnArgs): Promise<{ id: string }> {
      if (!officialSdkAllowsIsolatedSpawn()) {
        throw new Error("official SDK types lack experimental_callerLaunchId; compile pin required");
      }
      const result = await threads.spawn(officialSpawnArgs(args));
      const id = readOptionalString(result, "id");
      if (!id) throw new Error("threads.spawn returned no thread id");
      return { id };
    },
    async get(args) {
      const result = await threads.get({
        threadId: args.threadId,
        ...(args.include ? { include: args.include } : {}),
      });
      return isolatedViewFromRecord(result);
    },
    async list(args?: IsolatedThreadListArgs) {
      const listed = await threads.list(officialListArgs(args));
      const rows = Reflect.get(listed, "threads");
      if (!Array.isArray(rows)) return [];
      return rows.filter((row): row is object => Boolean(row) && typeof row === "object").map(isolatedViewFromRecord);
    },
    async send(args: IsolatedThreadSendArgs) {
      const result = await threads.send({
        threadId: args.threadId,
        input: [{ type: "text", text: args.text, mentions: [] }],
        mode: "auto",
      });
      const delivery = Reflect.get(result, "delivery");
      const ok = Reflect.get(result, "ok");
      if (ok === true && delivery === "sent") {
        return { kind: "confirmed" as const, delivery: "sent" as const };
      }
      if (ok === true && delivery === "queued") {
        return {
          kind: "confirmed" as const,
          delivery: "queued" as const,
          queuedMessageId: readQueuedMessageId(result),
        };
      }
      return {
        kind: "unknown" as const,
        code: "send_result_unrecognized",
        message: "threads.send did not return sent or queued delivery",
      };
    },
    async hasContinuation(threadId: string, token: string, queuedMessageId?: string | null) {
      try {
        const queuedArea = Reflect.get(threads, "queuedMessages");
        const listQueued = queuedArea && typeof queuedArea === "object" ? Reflect.get(queuedArea, "list") : undefined;
        if (typeof listQueued === "function") {
          const listed = await listQueued.call(queuedArea, { threadId });
          const queued = listObjects(listed);
          if (queued.some((row) => queuedMessageHoldsToken(row, token, queuedMessageId))) {
            return "queued";
          }
        }
      } catch {
        /* timeline may still prove dispatch */
      }
      if (typeof threads.timeline !== "function") return "unknown";
      try {
        const timeline = await threads.timeline({ threadId });
        const rows = listObjects(timeline);
        if (rows.some((row) => isDispatchedUserRow(row, token))) return "present";
        return "unknown";
      } catch {
        return "unknown";
      }
    },
  };
}
