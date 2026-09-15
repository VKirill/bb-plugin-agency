import type { DomainResult } from "../../../domain";
import type { HandoffPackage } from "../context-snapshot/types.js";
import type { InternalRunStoreReads } from "../run-store/types.js";
import type { ServiceContext } from "../../services/context.js";
import type {
  AssertCanSpawnInput,
  CompileHandoffInput,
  ObservedStopClaim,
  OfficialThreadStatus,
  ReconcileStopInput,
  RequestStopInput,
  SafeReplacement,
  StopIntentRecord,
  WriterQuiescenceVerdict,
} from "./types.js";

/** Official `threads.stop` → `ThreadStopResult`. */
export type OfficialThreadStopPort = {
  readonly supported: true;
  stop(args: { threadId: string; signal?: AbortSignal }): Promise<{ ok: true }>;
};

/** Official `threads.get` — status is optional on the SDK row. */
export type OfficialThreadGetPort = {
  readonly supported: true;
  get(args: { threadId: string; signal?: AbortSignal }): Promise<{
    threadId: string;
    status: OfficialThreadStatus | null;
  }>;
};

/** Official `threads.listRunning` — occupying = starting | active. */
export type OfficialThreadListRunningPort = {
  readonly supported: true;
  listRunning(args?: { signal?: AbortSignal }): Promise<readonly { id: string; hostId: string | null }[]>;
};

export type UnsupportedThreadPort = {
  readonly supported: false;
};

export type ThreadStopPort = OfficialThreadStopPort | UnsupportedThreadPort;
export type ThreadGetPort = OfficialThreadGetPort | UnsupportedThreadPort;
export type ThreadListRunningPort = OfficialThreadListRunningPort | UnsupportedThreadPort;

/**
 * Writer-dead proof. Local port — does not import resource-lease.
 * `unavailable` / unsupported / `still_active` after observed stop => replacement blocked.
 */
export type OfficialWriterQuiescencePort = {
  readonly supported: true;
  verify(claim: ObservedStopClaim): Promise<WriterQuiescenceVerdict>;
};

export type WriterQuiescencePort = OfficialWriterQuiescencePort | UnsupportedThreadPort;

export type StopHandoffStore = {
  getByRequestId(requestId: string): StopIntentRecord | undefined;
  listByJob(jobId: string): readonly StopIntentRecord[];
  listByAttempt(attemptId: string): readonly StopIntentRecord[];
  insert(record: StopIntentRecord, actor: unknown, scopeBindingIds: readonly string[]): void;
  update(record: StopIntentRecord): void;
};

export type StopHandoffReads = Pick<InternalRunStoreReads, "getAttempt" | "getLaunchReceipt" | "getSnapshot">;

export type StopHandoffService = {
  requestStop(ctx: ServiceContext, input: RequestStopInput): Promise<DomainResult<StopIntentRecord>>;
  reconcileStop(ctx: ServiceContext, input: ReconcileStopInput): Promise<DomainResult<StopIntentRecord>>;
  compileHandoff(ctx: ServiceContext, input: CompileHandoffInput): DomainResult<HandoffPackage>;
  /**
   * Not a general launch gate. `ok` only for `safe_replacement`.
   * Phase `confirmed` (observed stop) without quiescence `confirmed` is fail.
   */
  assertCanSpawn(ctx: ServiceContext, input: AssertCanSpawnInput): Promise<DomainResult<SafeReplacement>>;
};
