import { fail, type DomainResult } from "../../domain";
import {
  JOB_COMMENT_KIND,
  createJobCommentRpcSchema,
  type Activity,
} from "../../shared/contracts";
import type { ContextSnapshot } from "../runtime/context-snapshot/types";
import type { InternalRunStoreReads } from "../runtime/run-store";
import { actorToActivity, type ServiceContext } from "../services/context";
import type { DomainStore } from "../services/domain-store";
import { resolveJobCommentActor, selectCurrentAttempt } from "./actor-proof";

export type JobCommentProof = {
  threadId: string | null;
};

export type JobCommentDeps = {
  store: Pick<DomainStore, "createActivity" | "scopedJob">;
  reads: Pick<InternalRunStoreReads, "listAttempts" | "getLaunchReceiptByAttempt" | "getSnapshot">;
};

function snapshotAssignedAgentId(snapshot: ContextSnapshot | null): string | null {
  if (!snapshot) return null;
  const assigned = snapshot.job.assignedAgentId?.trim() ?? "";
  const versionAgent = snapshot.agentVersion.agentId?.trim() ?? "";
  if (!assigned || !versionAgent || assigned !== versionAgent) return null;
  return versionAgent;
}

export function createJobComment(
  ctx: ServiceContext,
  input: unknown,
  proof: JobCommentProof,
  deps: JobCommentDeps,
): DomainResult<Activity> {
  const parsed = createJobCommentRpcSchema.safeParse(input);
  if (!parsed.success) return fail("invalid_command", parsed.error.message);
  const scoped = deps.store.scopedJob(ctx, parsed.data.jobId, parsed.data.claimedBbProjectId);
  if (!scoped.ok) return scoped;

  const listed = deps.reads.listAttempts(ctx, parsed.data.jobId);
  if (!listed.ok) return listed;
  const currentAttempt = selectCurrentAttempt(listed.value);

  let receipt: { threadId: string | null } | null = null;
  let snapshot: ContextSnapshot | null = null;
  if (currentAttempt) {
    const loadedReceipt = deps.reads.getLaunchReceiptByAttempt(ctx, currentAttempt.attemptId);
    if (loadedReceipt.ok) {
      receipt = loadedReceipt.value;
    } else if (loadedReceipt.error.code !== "not_found") {
      return loadedReceipt;
    }
    const loadedSnapshot = deps.reads.getSnapshot(ctx, currentAttempt.snapshotId);
    if (loadedSnapshot.ok) {
      snapshot = loadedSnapshot.value.snapshot;
    } else if (loadedSnapshot.error.code !== "not_found") {
      return loadedSnapshot;
    }
  }

  const actor = resolveJobCommentActor(
    {
      trustedCliThreadId: proof.threadId,
      currentAttempt,
      receipt,
      snapshotAgentId: snapshotAssignedAgentId(snapshot),
    },
    ctx.actor,
  );

  return deps.store.createActivity(
    { ...ctx, actor },
    {
      requestId: parsed.data.requestId,
      jobId: parsed.data.jobId,
      actor: actorToActivity(actor),
      kind: JOB_COMMENT_KIND,
      causationId: null,
      references: parsed.data.references,
      comment: parsed.data.comment,
    },
  );
}
