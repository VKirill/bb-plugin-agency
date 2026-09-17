import { hostEnvRootMatches } from "../launch/contract.js";
import type {
  LaunchContract,
  ReconcileOutcome,
  SpawnOutcome,
  SpawnPort,
  ThreadVerifyOutcome,
  ThreadVerifyPort,
} from "../launch/ports.js";
import type { ContextSnapshot } from "../context-snapshot/types.js";
import type { IsolatedThreadListArgs, IsolatedThreadSpawnArgs } from "./sdk-isolation-contract.js";
import { spawnArgsFromContract } from "./spawn-args.js";
import type { ContinuationPresence, IsolatedSendOutcome, IsolatedThreadSendArgs } from "./send-port.js";

export type IsolatedThreadView = {
  id: string;
  status?: string;
  projectId?: string;
  providerId?: string;
  model?: string;
  environmentId?: string | null;
  experimental_callerLaunchId?: string;
  experimental_callerAttemptId?: string;
  experimental_callerJobId?: string;
  host?: { id: string } | null;
  environment?: { id?: string; hostId?: string; path?: string | null } | null;
  /** Epoch ms of the last thread update; a sign of life for the run watch. */
  updatedAt?: number;
  activeBackgroundAgentCount?: number;
};

export type IsolatedThreadsApi = {
  spawn(args: IsolatedThreadSpawnArgs): Promise<{ id: string }>;
  get(args: { threadId: string; include?: string }): Promise<IsolatedThreadView>;
  list(args?: IsolatedThreadListArgs): Promise<readonly IsolatedThreadView[]>;
  send?(args: IsolatedThreadSendArgs): Promise<
    IsolatedSendOutcome
  >;
  hasContinuation?(
    threadId: string,
    token: string,
    queuedMessageId?: string | null,
  ): Promise<ContinuationPresence>;
};

export function createIsolatedSpawnPort(
  threads: IsolatedThreadsApi,
  loadSnapshot: (contract: LaunchContract) => ContextSnapshot | undefined,
  jobIdFor: (contract: LaunchContract) => string,
  supported: boolean,
): SpawnPort {
  return {
    supported,
    async spawn(request: LaunchContract): Promise<SpawnOutcome> {
      if (!supported) {
        return {
          kind: "rejected",
          code: "sdk_isolated_fields_unsupported",
          message: "runtime handshake is not proven; spawn is not called",
        };
      }
      const snapshot = loadSnapshot(request);
      if (!snapshot) {
        return { kind: "rejected", code: "snapshot_missing", message: "spawn cannot load the reserved snapshot" };
      }
      const args = spawnArgsFromContract(request, snapshot, jobIdFor(request));
      if (!args.ok) {
        return { kind: "rejected", code: args.error.code, message: args.error.message };
      }
      try {
        const thread = await threads.spawn(args.value);
        if (!thread.id) {
          return { kind: "unknown", code: "spawn_id_missing", message: "threads.spawn returned no thread id" };
        }
        return { kind: "confirmed", threadId: thread.id };
      } catch (error) {
        return {
          kind: "unknown",
          code: "spawn_transport",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async reconcileByLaunchId(launchId: string): Promise<ReconcileOutcome> {
      if (!supported) return { kind: "unsupported" };
      try {
        const listed = await threads.list({
          experimental_callerLaunchId: launchId,
          includeHidden: true,
        });
        const items = [...listed];
        if (items.length === 0) return { kind: "unsupported" };
        if (items.length > 1) {
          return { kind: "rejected", code: "caller_launch_ambiguous", message: "list returned more than one thread" };
        }
        const id = items[0]?.id;
        if (!id) return { kind: "unknown", code: "reconcile_id_missing", message: "listed thread has no id" };
        return { kind: "confirmed", threadId: id };
      } catch (error) {
        return {
          kind: "unknown",
          code: "reconcile_transport",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function present(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function identityFromServerThread(
  thread: IsolatedThreadView,
): ThreadVerifyOutcome | { kind: "fields"; fields: Record<string, string> } {
  const hostId = present(thread.host?.id) ? thread.host.id : thread.environment?.hostId;
  const environmentId = present(thread.environment?.id) ? thread.environment.id : thread.environmentId;
  const canonicalRoot = thread.environment?.path;
  const bbProjectId = thread.projectId;
  const providerId = thread.providerId;
  const missing: string[] = [];
  if (!present(hostId)) missing.push("host");
  if (!present(canonicalRoot)) missing.push("path");
  if (!present(bbProjectId)) missing.push("project");
  if (!present(providerId)) missing.push("provider");
  if (!present(environmentId)) missing.push("environment");
  if (
    missing.length > 0 ||
    !present(hostId) ||
    !present(environmentId) ||
    !present(canonicalRoot) ||
    !present(bbProjectId) ||
    !present(providerId)
  ) {
    return {
      kind: "unavailable",
      code: "live_binding_incomplete",
      message: `threads.get omitted ${missing.join(", ") || "identity"}; snapshot fallback is not used`,
    };
  }
  return {
    kind: "fields",
    fields: {
      hostId,
      environmentId,
      canonicalRoot,
      bbProjectId,
      providerId,
    },
  };
}

export function createIsolatedThreadVerifyPort(threads: IsolatedThreadsApi, supported: boolean): ThreadVerifyPort {
  return {
    supported,
    async verifyConfirmedThread(receipt, storedSnapshot): Promise<ThreadVerifyOutcome> {
      if (!supported) {
        return {
          kind: "unavailable",
          code: "sdk_thread_lookup_unsupported",
          message: "runtime handshake is not proven; thread identity is not confirmed",
        };
      }
      if (!receipt.threadId) {
        return {
          kind: "unavailable",
          code: "thread_id_missing",
          message: "receipt has no threadId; list-by-launch is the reconcile path",
        };
      }
      try {
        const thread = await threads.get({ threadId: receipt.threadId, include: "environment,host" });
        if (thread.experimental_callerLaunchId !== receipt.launchId) {
          return { kind: "rejected", code: "caller_launch_mismatch", message: "experimental_callerLaunchId does not match" };
        }
        if (thread.experimental_callerAttemptId !== receipt.attemptId) {
          return { kind: "rejected", code: "caller_attempt_mismatch", message: "experimental_callerAttemptId does not match" };
        }
        if (!present(thread.experimental_callerJobId)) {
          return {
            kind: "rejected",
            code: "caller_job_missing",
            message: "receipt has jobId but threads.get omitted experimental_callerJobId",
          };
        }
        if (thread.experimental_callerJobId !== receipt.jobId) {
          return { kind: "rejected", code: "caller_job_mismatch", message: "experimental_callerJobId does not match the receipt job" };
        }
        const extracted = identityFromServerThread(thread);
        if (extracted.kind !== "fields") return extracted;
        const identity = {
          threadId: thread.id,
          launchId: receipt.launchId,
          attemptId: receipt.attemptId,
          hostId: extracted.fields.hostId,
          environmentId: extracted.fields.environmentId,
          canonicalRoot: extracted.fields.canonicalRoot,
          bbProjectId: extracted.fields.bbProjectId,
          providerId: extracted.fields.providerId,
        };
        if (!hostEnvRootMatches(storedSnapshot, identity)) {
          return { kind: "rejected", code: "live_binding_mismatch", message: "thread host/env/root/project does not match snapshot" };
        }
        if (extracted.fields.providerId !== storedSnapshot.agentVersion.providerId) {
          return { kind: "rejected", code: "live_provider_mismatch", message: "thread providerId does not match snapshot" };
        }
        if (present(thread.model) && thread.model !== storedSnapshot.agentVersion.model) {
          return { kind: "rejected", code: "live_model_mismatch", message: "thread model does not match snapshot" };
        }
        return { kind: "confirmed", identity };
      } catch (error) {
        return {
          kind: "unavailable",
          code: "thread_get_unavailable",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
