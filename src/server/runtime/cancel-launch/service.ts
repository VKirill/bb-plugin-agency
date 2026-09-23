import { assertJobTransition, fail, ok, type DomainResult } from "../../../domain";
import { cancelLaunchCommandSchema, type CancelLaunchRecord } from "../../../shared/rpc-contract";
import { createRepositories } from "../../db/repositories";
import type { SqlDatabase } from "../../db/sql";
import { commitDomainTransaction } from "../../db/domain-txn";
import { assertBindingAccess, nowUtc, type ServiceContext } from "../../services/context";
import { payloadWithoutRequestId, sameActor, sameCanonical } from "../../services/request-identity";
import type { DomainStore } from "../../services";
import type { ThreadGetPort, ThreadListRunningPort, ThreadStopPort } from "../stop-handoff/ports.js";
import { OCCUPYING_THREAD_STATUSES, type OfficialThreadStatus } from "../stop-handoff/types.js";
import { uuidV5 } from "../launch/operation-ids.js";
import type { InternalRunStoreReads, RunStore } from "../run-store/types.js";
import { assertAttemptTransition } from "../run-store/states.js";
import { findReviewerThread, markReviewerThreadDead, resolveReviewLine } from "../reviewer-thread/service.js";

export const CANCEL_LAUNCH_KIND = "agency.cancelLaunch";

export type CancelLaunchDeps = {
  db: SqlDatabase;
  store: DomainStore;
  runs: RunStore;
  reads: InternalRunStoreReads;
  stop: ThreadStopPort;
  get: ThreadGetPort;
  listRunning: ThreadListRunningPort;
};

const QUIET: ReadonlySet<string> = new Set(["idle", "error"]);

function isOfficialStatus(value: string | null): value is OfficialThreadStatus {
  return (
    value === "active" ||
    value === "error" ||
    value === "idle" ||
    value === "pending" ||
    value === "starting" ||
    value === "stopping"
  );
}

async function observeExactThread(
  deps: CancelLaunchDeps,
  threadId: string,
): Promise<DomainResult<{ getStatus: "idle" | "error" }>> {
  if (!deps.stop.supported) return fail("threads_stop_unsupported", "threads.stop is not available");
  if (!deps.get.supported) return fail("threads_get_unsupported", "threads.get is not available");
  if (!deps.listRunning.supported) {
    return fail("threads_list_running_unsupported", "threads.listRunning is not available");
  }
  try {
    const ack = await deps.stop.stop({ threadId });
    if (ack.ok !== true) return fail("thread_stop_rejected", "threads.stop did not acknowledge");
    const got = await deps.get.get({ threadId });
    if (got.threadId !== threadId) return fail("thread_mismatch", "threads.get returned a different thread");
    if (got.status !== "idle" && got.status !== "error") {
      return fail("thread_not_idle", `threads.get status ${got.status ?? "null"} is not idle|error`);
    }
    const quiet = got.status;
    if (!isOfficialStatus(quiet) || !QUIET.has(quiet)) {
      return fail("thread_not_idle", `threads.get status ${got.status ?? "null"} is not idle|error`);
    }
    const running = await deps.listRunning.listRunning();
    if (running.some((row) => row.id === threadId)) {
      return fail("thread_still_listed", "thread is still in threads.listRunning");
    }
    if ((OCCUPYING_THREAD_STATUSES as readonly string[]).includes(quiet)) {
      return fail("thread_still_listed", "thread still occupying capacity");
    }
    return ok({ getStatus: quiet });
  } catch {
    return fail("thread_observe_failed", "thread observe failed");
  }
}

export function createCancelLaunchService(deps: CancelLaunchDeps) {
  return {
    async cancelLaunch(ctx: ServiceContext, raw: unknown): Promise<DomainResult<CancelLaunchRecord>> {
      const parsed = cancelLaunchCommandSchema.safeParse(raw);
      if (!parsed.success) return fail("invalid_command", parsed.error.message);
      const input = parsed.data;
      const repos = createRepositories(deps.db);
      const payload = payloadWithoutRequestId(input);
      const existing = repos.request.get(input.requestId);
      if (existing) {
        if (
          existing.kind !== CANCEL_LAUNCH_KIND ||
          !sameCanonical(existing.payload, payload) ||
          !sameActor(existing.actor, ctx.actor)
        ) {
          return fail("request_conflict", `request ${input.requestId} already used with a different cancelLaunch payload`);
        }
        const remembered = existing.result as DomainResult<CancelLaunchRecord>;
        if (remembered.ok) return ok({ ...remembered.value, replay: true });
        return remembered;
      }

      const attempt = deps.reads.getAttempt(ctx, input.attemptId);
      if (!attempt.ok) return attempt;
      if (attempt.value.jobId !== input.jobId) return fail("attempt_job_mismatch", "attempt does not belong to job");
      if (attempt.value.revision !== input.expectedAttemptRevision) {
        return fail("revision_conflict", "attempt revision does not match expectedAttemptRevision");
      }
      const jobBeforeStop = deps.store.getJob(input.jobId);
      if (!jobBeforeStop) return fail("not_found", `job ${input.jobId} not found`);
      if (jobBeforeStop.revision !== input.expectedJobRevision) {
        return fail("revision_conflict", "job revision does not match expectedJobRevision");
      }
      if (attempt.value.threadId !== input.threadId) {
        return fail("thread_mismatch", "attempt threadId does not match cancel target");
      }
      if (attempt.value.launchId !== input.launchId) {
        return fail("launch_mismatch", "attempt launchId does not match cancel target");
      }
      const receipt = deps.reads.getLaunchReceipt(ctx, input.launchId);
      if (!receipt.ok) return receipt;
      if (receipt.value.threadId !== input.threadId || receipt.value.attemptId !== input.attemptId) {
        return fail("receipt_identity_mismatch", "launch receipt thread/attempt does not match cancel target");
      }
      const snapshot = deps.reads.getSnapshot(ctx, attempt.value.snapshotId);
      if (!snapshot.ok) return snapshot;
      const access = assertBindingAccess(ctx, snapshot.value.snapshot.binding.id);
      if (!access.ok) return access;

      // Reject known-invalid transitions before the external stop, not after it.
      // The transactional transitions below still enforce revisions after that I/O.
      const canCancel = assertAttemptTransition(attempt.value.state, "canceled");
      if (!canCancel.ok) return canCancel;
      if (jobBeforeStop.state !== "blocked") {
        const canBlock = assertJobTransition(jobBeforeStop.state, "blocked");
        if (!canBlock.ok) return canBlock;
      }
      const observed = await observeExactThread(deps, input.threadId);
      if (!observed.ok) return observed;

      return commitDomainTransaction(deps.db, () => {
        const again = repos.request.get(input.requestId);
        if (again) return again.result as DomainResult<CancelLaunchRecord>;
        // A watchdog may already have blocked the job while its worker kept running.
        // Stopping it must retain that state, with the same CAS protection after I/O.
        const currentJob = deps.store.getJob(input.jobId);
        if (!currentJob || currentJob.revision !== input.expectedJobRevision) {
          return fail("revision_conflict", "job revision changed while stopping the thread");
        }
        const canceled = deps.runs.transitionAttempt(ctx, {
          requestId: uuidV5(input.requestId, "agency.cancelLaunch.attempt"),
          attemptId: input.attemptId,
          expectedRevision: input.expectedAttemptRevision,
          to: "canceled",
        });
        if (!canceled.ok) return canceled;
        const job = currentJob.state === "blocked" ? ok(currentJob) : deps.store.transitionJob(ctx, {
          requestId: uuidV5(input.requestId, "agency.cancelLaunch.job"),
          jobId: input.jobId,
          expectedRevision: input.expectedJobRevision,
          to: "blocked",
        });
        if (!job.ok) return job;
        const result = ok({
          jobId: job.value.id,
          jobState: "blocked" as const,
          jobRevision: job.value.revision,
          attemptId: canceled.value.attemptId,
          attemptState: "canceled" as const,
          attemptRevision: canceled.value.revision,
          launchId: input.launchId,
          threadId: input.threadId,
          reason: input.reason,
          observedStop: {
            stopAck: true as const,
            getStatus: observed.value.getStatus,
            listRunningPresent: false as const,
          },
          writerDeadClaimed: false as const,
          replay: false as const,
        });
        repos.request.insert(
          input.requestId,
          CANCEL_LAUNCH_KIND,
          result,
          payload,
          ctx.actor,
          [snapshot.value.snapshot.binding.id],
          nowUtc(ctx),
        );
        const lineJobId = resolveReviewLine(deps.db, input.jobId);
        if (lineJobId) {
          const row = findReviewerThread(deps.db, snapshot.value.snapshot.agentVersion.agentId, lineJobId);
          if (row && row.threadId === input.threadId) {
            markReviewerThreadDead(deps.db, snapshot.value.snapshot.agentVersion.agentId, lineJobId, "cancel_launch", nowUtc(ctx));
          }
        }
        return result;
      });
    },
  };
}
