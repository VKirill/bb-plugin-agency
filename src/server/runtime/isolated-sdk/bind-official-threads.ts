import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  AGENCY_PLUGIN_ID,
  type IsolatedThreadListArgs,
  type IsolatedThreadSpawnArgs,
  type OfficialThreadListArgs,
  type OfficialThreadSpawnArgs,
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

function parseAgencyPluginMetadata(value: unknown): IsolatedThreadView["pluginMetadata"] {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const source =
    obj.pluginMetadata && typeof obj.pluginMetadata === "object" && typeof obj.agencyLaunchId !== "string"
      ? (obj.pluginMetadata as Record<string, unknown>)
      : obj;
  const agencyLaunchId = typeof source.agencyLaunchId === "string" && source.agencyLaunchId ? source.agencyLaunchId : undefined;
  const agencyAttemptId = typeof source.agencyAttemptId === "string" && source.agencyAttemptId ? source.agencyAttemptId : undefined;
  const agencyJobId = typeof source.agencyJobId === "string" && source.agencyJobId ? source.agencyJobId : undefined;
  if (!agencyLaunchId && !agencyAttemptId && !agencyJobId) return undefined;
  return {
    ...(agencyLaunchId ? { agencyLaunchId } : {}),
    ...(agencyAttemptId ? { agencyAttemptId } : {}),
    ...(agencyJobId ? { agencyJobId } : {}),
  };
}

async function loadPluginMetadata(
  threads: BbPluginApi["sdk"]["threads"],
  threadId: string,
): Promise<IsolatedThreadView["pluginMetadata"]> {
  const fn = Reflect.get(threads, "getPluginMetadata");
  if (typeof fn !== "function") return undefined;
  try {
    return parseAgencyPluginMetadata(await fn.call(threads, { threadId }));
  } catch {
    return undefined;
  }
}

function mergePluginMetadata(
  view: IsolatedThreadView,
  extra: IsolatedThreadView["pluginMetadata"],
): IsolatedThreadView {
  if (!extra) return view;
  return { ...view, pluginMetadata: { ...view.pluginMetadata, ...extra } };
}

/** Map a threads.get/list row without asserting SDK result types. */
export function isolatedViewFromRecord(value: object): IsolatedThreadView {
  const host = readNested(value, "host");
  const environment = readNested(value, "environment");
  const pluginMetadata = parseAgencyPluginMetadata(Reflect.get(value, "pluginMetadata"));
  return {
    id: readOptionalString(value, "id") ?? "",
    status: readOptionalString(value, "status"),
    projectId: readOptionalString(value, "projectId"),
    providerId: readOptionalString(value, "providerId"),
    model: readOptionalString(value, "model"),
    environmentId: readOptionalString(value, "environmentId"),
    ...(pluginMetadata ? { pluginMetadata } : {}),
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
 * Public 0.43 createThread keys only. Extra experimental fields fail `.strict()`
 * on the live server. `executionInputSources` must mark provider/model explicit
 * or project defaults win.
 */
function officialSpawnArgs(args: IsolatedThreadSpawnArgs): OfficialThreadSpawnArgs {
  return {
    projectId: args.projectId,
    providerId: args.providerId,
    model: args.model,
    prompt: args.prompt,
    environment: args.environment,
    origin: args.origin,
    originPluginId: args.originPluginId ?? AGENCY_PLUGIN_ID,
    visibility: args.visibility,
    pluginMetadata: args.pluginMetadata,
    executionInputSources: {
      providerId: "explicit" as const,
      model: "explicit" as const,
      ...(args.reasoningLevel ? { reasoningLevel: "explicit" as const } : {}),
      ...(args.serviceTier ? { serviceTier: "explicit" as const } : {}),
      ...(args.permissionMode ? { permissionMode: "explicit" as const } : {}),
    },
    ...(args.reasoningLevel ? { reasoningLevel: args.reasoningLevel } : {}),
    ...(args.serviceTier ? { serviceTier: args.serviceTier } : {}),
    ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
  };
}

function officialListArgs(args?: IsolatedThreadListArgs): OfficialThreadListArgs {
  return {
    ...(args?.includeHidden !== undefined ? { includeHidden: args.includeHidden } : {}),
    ...(args?.projectId ? { projectId: args.projectId } : {}),
    originPluginId: args?.originPluginId ?? AGENCY_PLUGIN_ID,
  };
}

/**
 * Typed spawn/get/list on the public `threads` SDK.
 */
export function bindOfficialThreads(threads: BbPluginApi["sdk"]["threads"]): IsolatedThreadsApi {
  return {
    async spawn(args: IsolatedThreadSpawnArgs): Promise<{ id: string }> {
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
      return mergePluginMetadata(isolatedViewFromRecord(result), await loadPluginMetadata(threads, args.threadId));
    },
    async list(args?: IsolatedThreadListArgs) {
      const listed = await threads.list(officialListArgs(args));
      const rows = Reflect.get(listed, "threads");
      if (!Array.isArray(rows)) return [];
      const views = rows.filter((row): row is object => Boolean(row) && typeof row === "object").map(isolatedViewFromRecord);
      return Promise.all(
        views.map(async (view) => mergePluginMetadata(view, view.id ? await loadPluginMetadata(threads, view.id) : undefined)),
      );
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
      let queueChecked = false;
      try {
        const queuedArea = Reflect.get(threads, "queuedMessages");
        const listQueued = queuedArea && typeof queuedArea === "object" ? Reflect.get(queuedArea, "list") : undefined;
        if (typeof listQueued === "function") {
          const listed = await listQueued.call(queuedArea, { threadId });
          const queued = listObjects(listed);
          if (queued.some((row) => queuedMessageHoldsToken(row, token, queuedMessageId))) {
            return "queued";
          }
          queueChecked = true;
        }
      } catch {
        /* timeline may still prove dispatch */
      }
      if (typeof threads.timeline !== "function") return queueChecked ? "absent" : "unknown";
      try {
        const timeline = await threads.timeline({ threadId });
        const rows = listObjects(timeline);
        if (rows.some((row) => isDispatchedUserRow(row, token))) return "present";
        return queueChecked ? "absent" : "unknown";
      } catch {
        return "unknown";
      }
    },
  };
}
