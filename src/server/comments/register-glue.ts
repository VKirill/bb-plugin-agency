import type { DomainResult } from "../../domain";
import type { Activity } from "../../shared/contracts";
import type { InternalRunStoreReads } from "../runtime/run-store";
import type { ServiceContext } from "../services/context";
import type { DomainStore } from "../services/domain-store";
import { createJobComment } from "./service";
import type { JobCommentProof } from "./service";

/**
 * Production bind (register.ts, 2026-09-14): run(argv, ctx) passes
 * cliThreadId: readCliThreadId(ctx) and
 * jobComment: bindJobCommentHandler({ store, reads: runReads, resolveAccess: () => resolveRpcAccess(db) }).
 * createJobComment stays off rpcContract. Do not dispatch it through handlers[operation].
 */
export const JOB_COMMENT_REGISTER_GLUE = {
  wiredInRegister: true,
  rpcMethod: false,
  cliOperation: "createJobComment",
  alias: "job comment",
  proofField: "cliThreadId",
  portField: "jobComment",
  activityKind: "comment",
  inputActorAccepted: false,
  registerRun: "run(argv, ctx)",
} as const;

export function readCliThreadId(ctx: unknown): string | null {
  if (!ctx || typeof ctx !== "object") return null;
  const threadId = (ctx as { threadId?: unknown }).threadId;
  return typeof threadId === "string" && threadId.trim() ? threadId.trim() : null;
}

export function bindJobCommentHandler(deps: {
  store: Pick<DomainStore, "createActivity" | "scopedJob">;
  reads: Pick<InternalRunStoreReads, "listAttempts" | "getLaunchReceiptByAttempt" | "getSnapshot">;
  resolveAccess: () => DomainResult<{ ctx: ServiceContext }>;
}): (input: unknown, proof: JobCommentProof) => DomainResult<Activity> {
  return (input, proof) => {
    const access = deps.resolveAccess();
    if (!access.ok) return access;
    return createJobComment(access.value.ctx, input, proof, { store: deps.store, reads: deps.reads });
  };
}
