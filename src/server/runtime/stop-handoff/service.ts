import { fail, ok, type DomainResult } from "../../../domain";
import { computeHandoffHash } from "../context-snapshot/compile.js";
import type { HandoffPackage, InputArtifactRef } from "../context-snapshot/types.js";
import { uuidV5 } from "../launch/operation-ids.js";
import { assertBindingAccess, nowUtc, type ServiceContext } from "../../services/context.js";
import { emptyEvidence, evaluateEvidence, isSpawnBlockingPhase, occupyingStatusList } from "./evidence.js";
import type {
  StopHandoffReads,
  StopHandoffService,
  StopHandoffStore,
  ThreadGetPort,
  ThreadListRunningPort,
  ThreadStopPort,
  WriterQuiescencePort,
} from "./ports.js";
import type {
  AssertCanSpawnInput,
  CompileHandoffInput,
  ObservedStopClaim,
  ReconcileStopInput,
  RequestStopInput,
  SafeReplacement,
  StopIntentRecord,
  SupportedStopEvidence,
} from "./types.js";

export type StopHandoffDeps = {
  store: StopHandoffStore;
  reads: StopHandoffReads;
  stop: ThreadStopPort;
  get: ThreadGetPort;
  listRunning: ThreadListRunningPort;
  /** Default unsupported: observed stop never authorises replacement. */
  quiescence?: WriterQuiescencePort;
};

function toObservedStopClaim(row: StopIntentRecord): ObservedStopClaim {
  return {
    kind: "observed_stop",
    jobId: row.jobId,
    attemptId: row.attemptId,
    launchId: row.launchId,
    threadId: row.threadId,
    requestId: row.requestId,
  };
}

export function intentIdForRequest(requestId: string): string {
  return uuidV5(requestId, "agency.stopHandoff.intent");
}

function artifactKey(item: Pick<InputArtifactRef, "artifactId" | "version" | "hash" | "jobId" | "hostId">): string {
  return `${item.artifactId}:${item.version}:${item.hash}:${item.jobId}:${item.hostId}`;
}

async function collectLiveEvidence(
  deps: StopHandoffDeps,
  threadId: string,
  previous: SupportedStopEvidence,
): Promise<DomainResult<SupportedStopEvidence>> {
  if (!deps.stop.supported) {
    return fail("threads_stop_unsupported", "threads.stop is not available on this port");
  }
  if (!deps.get.supported) {
    return fail("threads_get_unsupported", "threads.get is not available on this port");
  }
  if (!deps.listRunning.supported) {
    return fail("threads_list_running_unsupported", "threads.listRunning is not available on this port");
  }
  try {
    const got = await deps.get.get({ threadId });
    const running = await deps.listRunning.listRunning();
    return ok({
      kind: "threads.stop+get+listRunning",
      stopAck: previous.stopAck,
      get: { threadId: got.threadId, status: got.status },
      listRunning: {
        occupyingStatuses: occupyingStatusList(),
        threadPresent: running.some((row) => row.id === threadId),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "thread observe failed";
    return fail("thread_observe_failed", message);
  }
}

function applyEvaluation(record: StopIntentRecord, now: string): StopIntentRecord {
  const evaluated = evaluateEvidence(record.evidence);
  return {
    ...record,
    phase: evaluated.phase,
    failureCode: null,
    updatedAt: now,
  };
}

export function createStopHandoffService(deps: StopHandoffDeps): StopHandoffService {
  async function persistAndObserve(
    ctx: ServiceContext,
    record: StopIntentRecord,
    callStop: boolean,
  ): Promise<DomainResult<StopIntentRecord>> {
    const now = nowUtc(ctx);
    if (callStop) {
      if (!deps.stop.supported) {
        const failed: StopIntentRecord = {
          ...record,
          phase: "failed",
          failureCode: "threads_stop_unsupported",
          updatedAt: now,
        };
        deps.store.update(failed);
        return fail("threads_stop_unsupported", "threads.stop is not available on this port");
      }
      try {
        const ack = await deps.stop.stop({ threadId: record.threadId });
        if (ack.ok !== true) {
          const failed: StopIntentRecord = {
            ...record,
            phase: "failed",
            failureCode: "threads_stop_not_ok",
            updatedAt: now,
          };
          deps.store.update(failed);
          return fail("threads_stop_not_ok", "threads.stop did not return { ok: true }");
        }
        record = {
          ...record,
          evidence: { ...record.evidence, stopAck: { ok: true } },
          phase: "ack_recorded",
          updatedAt: now,
        };
        deps.store.update(record);
      } catch (error) {
        const message = error instanceof Error ? error.message : "threads.stop failed";
        const failed: StopIntentRecord = {
          ...record,
          phase: "failed",
          failureCode: "threads_stop_failed",
          updatedAt: now,
        };
        deps.store.update(failed);
        return fail("threads_stop_failed", message);
      }
    }

    const live = await collectLiveEvidence(deps, record.threadId, record.evidence);
    if (!live.ok) {
      const failed: StopIntentRecord = {
        ...record,
        phase: "failed",
        failureCode: live.error.code,
        updatedAt: nowUtc(ctx),
      };
      deps.store.update(failed);
      return live;
    }
    const next = applyEvaluation({ ...record, evidence: live.value }, nowUtc(ctx));
    deps.store.update(next);
    return ok(next);
  }

  return {
    async requestStop(ctx, input: RequestStopInput): Promise<DomainResult<StopIntentRecord>> {
      const remembered = deps.store.getByRequestId(input.requestId);
      if (remembered) {
        const existingReq = remembered;
        if (
          existingReq.jobId === input.jobId &&
          existingReq.attemptId === input.attemptId &&
          existingReq.launchId === input.launchId &&
          existingReq.threadId === input.threadId
        ) {
          if (existingReq.phase === "confirmed" || existingReq.phase === "failed") {
            return ok(existingReq);
          }
          return persistAndObserve(ctx, existingReq, existingReq.evidence.stopAck === null);
        }
        return fail("request_conflict", `request ${input.requestId} already recorded with a different stop payload`);
      }

      const attempt = deps.reads.getAttempt(ctx, input.attemptId);
      if (!attempt.ok) return attempt;
      if (attempt.value.jobId !== input.jobId) {
        return fail("attempt_job_mismatch", "attempt does not belong to job");
      }
      if (attempt.value.revision !== input.expectedAttemptRevision) {
        return fail("revision_conflict", "attempt revision does not match expectedAttemptRevision");
      }
      if (attempt.value.threadId !== input.threadId) {
        return fail("thread_mismatch", "attempt threadId does not match stop target");
      }
      if (attempt.value.launchId !== input.launchId) {
        return fail("launch_mismatch", "attempt launchId does not match stop target");
      }

      const receipt = deps.reads.getLaunchReceipt(ctx, input.launchId);
      if (!receipt.ok) return receipt;
      if (receipt.value.threadId !== input.threadId || receipt.value.attemptId !== input.attemptId) {
        return fail("receipt_identity_mismatch", "launch receipt thread/attempt does not match stop target");
      }

      const snapshotRow = deps.reads.getSnapshot(ctx, attempt.value.snapshotId);
      if (!snapshotRow.ok) return snapshotRow;
      const access = assertBindingAccess(ctx, snapshotRow.value.snapshot.binding.id);
      if (!access.ok) return access;

      for (const open of deps.store.listByAttempt(input.attemptId)) {
        if (open.requestId !== input.requestId && isSpawnBlockingPhase(open.phase) && open.phase !== "failed") {
          return fail("open_stop_intent_exists", `attempt ${input.attemptId} already has an open stop intent`);
        }
      }

      const now = nowUtc(ctx);
      const record: StopIntentRecord = {
        intentId: intentIdForRequest(input.requestId),
        requestId: input.requestId,
        jobId: input.jobId,
        attemptId: input.attemptId,
        launchId: input.launchId,
        threadId: input.threadId,
        phase: "intent",
        reason: input.reason ?? null,
        evidence: emptyEvidence(),
        handoff: null,
        failureCode: null,
        createdAt: now,
        updatedAt: now,
      };
      deps.store.insert(record, ctx.actor, ctx.allowedBindingIds);
      return persistAndObserve(ctx, record, true);
    },

    async reconcileStop(ctx, input: ReconcileStopInput): Promise<DomainResult<StopIntentRecord>> {
      const existing = deps.store.getByRequestId(input.requestId);
      if (!existing) return fail("stop_intent_not_found", `no stop intent for ${input.requestId}`);
      if (existing.phase === "confirmed" || existing.phase === "failed") return ok(existing);
      return persistAndObserve(ctx, existing, existing.evidence.stopAck === null);
    },

    compileHandoff(ctx, input: CompileHandoffInput): DomainResult<HandoffPackage> {
      const existing = deps.store.getByRequestId(input.requestId);
      if (!existing) return fail("stop_intent_not_found", `no stop intent for ${input.requestId}`);
      if (existing.phase !== "confirmed") {
        return fail("stop_not_confirmed", "handoff pins require observed stop (phase confirmed); idle is not enough");
      }
      if (existing.handoff) {
        const samePins =
          existing.handoff.openQuestions.length === input.openQuestions.length &&
          existing.handoff.openQuestions.every((item, index) => item === input.openQuestions[index]) &&
          existing.handoff.returnReason === input.returnReason &&
          existing.handoff.acceptedArtifacts.length === input.acceptedArtifacts.length &&
          existing.handoff.acceptedArtifacts.every((item, index) => {
            const next = input.acceptedArtifacts[index];
            return next !== undefined && artifactKey(item) === artifactKey(next) && item.relativePath === next.relativePath;
          });
        if (samePins) return ok(existing.handoff);
        return fail("handoff_already_compiled", "handoff pins are immutable after first compile");
      }

      const attempt = deps.reads.getAttempt(ctx, existing.attemptId);
      if (!attempt.ok) return attempt;
      const snapshotRow = deps.reads.getSnapshot(ctx, attempt.value.snapshotId);
      if (!snapshotRow.ok) return snapshotRow;
      const access = assertBindingAccess(ctx, snapshotRow.value.snapshot.binding.id);
      if (!access.ok) return access;

      const allowed = new Map(
        snapshotRow.value.snapshot.inputArtifacts.map((item) => [artifactKey(item), item]),
      );
      const accepted: InputArtifactRef[] = [];
      for (const item of input.acceptedArtifacts) {
        const match = allowed.get(artifactKey(item));
        if (!match || match.relativePath !== item.relativePath) {
          return fail(
            "handoff_artifact_unauthorized",
            `accepted artifact ${item.artifactId}@${item.version} must match snapshot input pin`,
          );
        }
        accepted.push({
          artifactId: match.artifactId,
          version: match.version,
          hash: match.hash,
          jobId: match.jobId,
          hostId: match.hostId,
          relativePath: match.relativePath,
        });
      }
      accepted.sort((a, b) => a.artifactId.localeCompare(b.artifactId) || a.version - b.version);
      const body = {
        priorRunAttemptId: existing.attemptId,
        fromSnapshotDigest: snapshotRow.value.digest,
        acceptedArtifacts: accepted,
        openQuestions: [...input.openQuestions],
        returnReason: input.returnReason,
      };
      const compiled: HandoffPackage = { ...body, hash: computeHandoffHash(body) };
      const now = nowUtc(ctx);
      deps.store.update({ ...existing, handoff: compiled, updatedAt: now });
      return ok(compiled);
    },

    async assertCanSpawn(_ctx, input: AssertCanSpawnInput): Promise<DomainResult<SafeReplacement>> {
      const rows = deps.store.listByJob(input.jobId);
      if (rows.length === 0) {
        return fail(
          "spawn_not_authorized_by_stop_module",
          "stop-handoff is not a launch gate; absence of a stop record does not authorise a new writer",
        );
      }
      for (const row of rows) {
        if (isSpawnBlockingPhase(row.phase)) {
          return fail(
            "spawn_blocked_stop_in_flight",
            `job ${input.jobId} has stop phase ${row.phase}; replacement is forbidden while stop is not observed`,
          );
        }
      }
      const observed = rows.filter((row) => row.phase === "confirmed");
      if (observed.length === 0) {
        return fail(
          "spawn_not_authorized_by_stop_module",
          `job ${input.jobId} has no observed stop (phase confirmed)`,
        );
      }
      const quiescence = deps.quiescence ?? { supported: false };
      if (!quiescence.supported) {
        return fail(
          "spawn_blocked_until_writer_quiescence",
          "observed stop is not writer-dead proof; quiescence port is unavailable",
        );
      }
      let granted: SafeReplacement | undefined;
      for (const row of observed) {
        const claim = toObservedStopClaim(row);
        const verdict = await quiescence.verify(claim);
        if (verdict !== "confirmed") {
          return fail(
            "spawn_blocked_until_writer_quiescence",
            `observed stop ${row.requestId} + quiescence ${verdict} => replacement blocked`,
          );
        }
        granted = { kind: "safe_replacement", observedStop: claim, quiescence: "confirmed" };
      }
      if (!granted) {
        return fail("spawn_blocked_until_writer_quiescence", "observed stop without quiescence confirmed");
      }
      return ok(granted);
    },
  };
}
