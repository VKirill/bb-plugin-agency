import { fail, ok, type DomainResult } from "../../../domain";
import type { SqlDatabase } from "../../db/sql";
import { createRepositories } from "../../db/repositories";
import type { ServiceContext } from "../../services/context.js";
import type { InternalRunStoreReads, LaunchReceipt, RunStore } from "../run-store/types.js";
import { verifyLiveLaunchIdentity } from "../run-store/verify-live.js";
import type {
  AttemptStorePort,
  ConfirmedJobBind,
  JobRunningPort,
  LaunchReceiptDraft,
  LiveIdentityMatch,
  LiveIdentityPort,
} from "./ports.js";

export function attemptStoreFromRunStore(writes: RunStore, reads: InternalRunStoreReads): AttemptStorePort {
  return {
    getSnapshot: (ctx, snapshotId) => reads.getSnapshot(ctx, snapshotId),
    getAttempt: (ctx, attemptId) => reads.getAttempt(ctx, attemptId),
    transition: (ctx, input) => writes.transitionAttempt(ctx, input),
    putReceipt: (ctx, receipt: LaunchReceiptDraft) =>
      writes.recordLaunchReceipt(ctx, { requestId: receipt.parentRequestId, receipt }),
    getReceipt: (ctx, launchId) => reads.getLaunchReceipt(ctx, launchId),
    getReceiptByAttempt: (ctx, attemptId) => reads.getLaunchReceiptByAttempt(ctx, attemptId),
  };
}

export function liveIdentityFromVerify(verify: LiveIdentityPort["verify"]): LiveIdentityPort {
  return { verify };
}

export function deferredJobRunningPort(): JobRunningPort {
  return {
    async onConfirmedBind(_ctx: ServiceContext, _bind: ConfirmedJobBind): Promise<DomainResult<true>> {
      return fail("job_running_deferred", "Job.state is a separate service; coordinator does not set running itself");
    },
  };
}

export function recordingJobRunningPort(applied: ConfirmedJobBind[]): JobRunningPort {
  return {
    async onConfirmedBind(_ctx: ServiceContext, bind: ConfirmedJobBind): Promise<DomainResult<true>> {
      applied.push(bind);
      return ok(true);
    },
  };
}

export function liveIdentityFromDatabase(db: SqlDatabase): LiveIdentityPort {
  const repos = createRepositories(db);
  return {
    verify(ctx, snapshot, claimedBbProjectId, attestation) {
      const live = verifyLiveLaunchIdentity(ctx, repos, snapshot, claimedBbProjectId, attestation);
      if (!live.ok) return live;
      return ok({
        hostId: live.value.binding.hostId,
        environmentId: live.value.binding.environmentId,
        canonicalRoot: live.value.binding.canonicalRoot,
        bbProjectId: live.value.binding.bbProjectId,
      });
    },
  };
}

export function matchingLiveIdentity(match: LiveIdentityMatch): LiveIdentityPort {
  return {
    verify() {
      return ok(match);
    },
  };
}

export type { LaunchReceipt };
