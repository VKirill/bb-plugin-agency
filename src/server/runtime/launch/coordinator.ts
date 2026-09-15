import { randomUUID } from "node:crypto";
import { fail, ok, type DomainResult } from "../../../domain";
import { requestIdSchema } from "../../../shared/contracts";
import type { ServiceContext } from "../../services/context.js";
import type { ContextSnapshot } from "../context-snapshot/types.js";
import type { LaunchReceipt, ReserveAttestation, RunAttempt } from "../run-store/types.js";
import { hostEnvRootMatches, launchContractFromSnapshot } from "./contract.js";
import { launchOpRequestId, type LaunchOp } from "./operation-ids.js";
import type { LaunchContract, LaunchPorts, LaunchReceiptDraft, SpawnOutcome } from "./ports.js";
import { isReadyToSpawn } from "./readiness.js";

export type LaunchPreparedInput = {
  requestId: string;
  snapshotId: string;
  digest: string;
  attemptId: string;
  attestation: ReserveAttestation;
  claimedBbProjectId?: string;
};

export type LaunchReceiptView = {
  launchId: string;
  attemptId: string;
  jobId: string;
  snapshotId: string;
  digest: string;
  threadId: string | null;
  spawnKind: LaunchReceipt["spawnKind"];
  persistError: { code: string; message: string } | null;
  jobBindState: LaunchReceipt["jobBindState"];
  needsReconciliation: boolean;
  persisted: boolean;
};

export type ReconcileLaunchInput = {
  requestId: string;
  attemptId: string;
  launchId: string;
  /** Exact typed receipt from a prior result. Required when SQLite never stored the row. */
  knownReceipt?: LaunchReceiptView;
};

export type LaunchCoordinatorResult =
  | {
      kind: "running";
      attempt: RunAttempt;
      contract: LaunchContract;
      jobStateApplied: boolean;
      receipt: LaunchReceiptView;
    }
  | { kind: "failed"; attempt: RunAttempt; code: string; message: string; receipt: LaunchReceiptView }
  | { kind: "canceled"; attempt: RunAttempt; code: string; message: string; receipt: LaunchReceiptView }
  | { kind: "unknown"; attempt: RunAttempt; code: string; message: string; receipt: LaunchReceiptView }
  | { kind: "needs_reconciliation"; attempt: RunAttempt; code: string; message: string; receipt: LaunchReceiptView };

const inflightAttempts = new Set<string>();

export const LAUNCH_COORDINATOR_STATUS = {
  executionAvailable: false,
  liveAgent: false,
  automaticSpawnRetry: false,
} as const;

export const LAUNCH_DURABILITY_LIMIT =
  "Full SQLite outage cannot persist the receipt; the typed result still returns the exact receipt (persisted=false). That in-memory receipt is not reopen-durable. Recovery must be explicit with that receipt and the same launchId. Never respawn.";

export function createLaunchCoordinator(ports: LaunchPorts) {
  function opId(parent: string, op: LaunchOp): string {
    return launchOpRequestId(parent, op);
  }

  function viewFromDraft(draft: LaunchReceiptDraft, persisted: boolean): LaunchReceiptView {
    return {
      launchId: draft.launchId,
      attemptId: draft.attemptId,
      jobId: draft.jobId,
      snapshotId: draft.snapshotId,
      digest: draft.digest,
      threadId: draft.threadId,
      spawnKind: draft.spawnKind,
      persistError:
        draft.persistErrorCode && draft.persistErrorMessage
          ? { code: draft.persistErrorCode, message: draft.persistErrorMessage }
          : null,
      jobBindState: draft.jobBindState,
      needsReconciliation: draft.needsReconciliation,
      persisted,
    };
  }

  function viewFromRow(row: LaunchReceipt, persisted: boolean): LaunchReceiptView {
    return viewFromDraft(row, persisted);
  }

  function saveReceipt(
    ctx: ServiceContext,
    draft: LaunchReceiptDraft,
  ): { view: LaunchReceiptView; row?: LaunchReceipt } {
    const saved = ports.store.putReceipt(ctx, draft);
    if (!saved.ok) {
      return {
        view: viewFromDraft(
          {
            ...draft,
            persistErrorCode: saved.error.code,
            persistErrorMessage: saved.error.message,
            needsReconciliation: true,
          },
          false,
        ),
      };
    }
    return { view: viewFromRow(saved.value, true), row: saved.value };
  }

  async function applyJobBind(
    ctx: ServiceContext,
    parentRequestId: string,
    attempt: RunAttempt,
    threadId: string,
    launchId: string,
    base: LaunchReceiptDraft,
  ): Promise<{ applied: boolean; receipt: LaunchReceiptView }> {
    try {
      const job = await ports.jobRunning.onConfirmedBind(ctx, {
        jobId: attempt.jobId,
        attemptId: attempt.attemptId,
        threadId,
        launchId,
      });
      if (!job.ok) {
        const saved = saveReceipt(ctx, {
          ...base,
          parentRequestId: opId(parentRequestId, "repair-job"),
          threadId,
          spawnKind: "confirmed",
          jobBindState: "needs_repair",
          persistErrorCode: job.error.code,
          persistErrorMessage: job.error.message,
          needsReconciliation: true,
        });
        return { applied: false, receipt: saved.view };
      }
      const saved = saveReceipt(ctx, {
        ...base,
        parentRequestId: opId(parentRequestId, "repair-job"),
        threadId,
        spawnKind: "confirmed",
        jobBindState: "applied",
        persistErrorCode: null,
        persistErrorMessage: null,
        needsReconciliation: false,
      });
      return { applied: true, receipt: saved.view };
    } catch {
      const saved = saveReceipt(ctx, {
        ...base,
        parentRequestId: opId(parentRequestId, "repair-job"),
        threadId,
        spawnKind: "confirmed",
        jobBindState: "needs_repair",
        persistErrorCode: "job_callback_thrown",
        persistErrorMessage: "onConfirmedBind threw; attempt stays running — repair without spawn",
        needsReconciliation: true,
      });
      return { applied: false, receipt: saved.view };
    }
  }

  function draftFrom(
    attempt: RunAttempt,
    launchId: string,
    parentRequestId: string,
    extra: Partial<LaunchReceiptDraft>,
  ): LaunchReceiptDraft {
    return {
      launchId,
      attemptId: attempt.attemptId,
      jobId: attempt.jobId,
      snapshotId: attempt.snapshotId,
      digest: attempt.digest,
      threadId: extra.threadId ?? attempt.threadId,
      spawnKind: extra.spawnKind ?? "unknown",
      persistErrorCode: extra.persistErrorCode ?? null,
      persistErrorMessage: extra.persistErrorMessage ?? null,
      jobBindState: extra.jobBindState ?? "pending",
      needsReconciliation: extra.needsReconciliation ?? false,
      parentRequestId,
    };
  }

  async function launchPreparedRun(
    ctx: ServiceContext,
    input: LaunchPreparedInput,
  ): Promise<DomainResult<LaunchCoordinatorResult>> {
    const requestId = requestIdSchema.safeParse(input.requestId);
    if (!requestId.success) return fail("invalid_command", "requestId must be a UUID");
    if (inflightAttempts.has(input.attemptId)) {
      return fail("launch_in_progress", `attempt ${input.attemptId} already has a launch in progress`);
    }
    inflightAttempts.add(input.attemptId);
    try {
      return await runLaunch(ctx, input);
    } finally {
      inflightAttempts.delete(input.attemptId);
    }
  }

  async function runLaunch(
    ctx: ServiceContext,
    input: LaunchPreparedInput,
  ): Promise<DomainResult<LaunchCoordinatorResult>> {
    const existingReceipt = ports.store.getReceiptByAttempt(ctx, input.attemptId);
    if (existingReceipt.ok) {
      return recoverFromReceipt(ctx, input.requestId, existingReceipt.value, input.attestation, input.claimedBbProjectId);
    }

    const loaded = loadPrepared(ctx, input);
    if (!loaded.ok) return loaded;
    const { snapshot, attempt } = loaded.value;
    const live = ports.liveIdentity.verify(ctx, snapshot, input.claimedBbProjectId, input.attestation);
    if (!live.ok) return live;
    if (!hostEnvRootMatches(snapshot, live.value)) {
      return fail("live_binding_mismatch", "host/env/root/project no longer match the live binding");
    }
    const readiness = ports.readiness.assess(snapshot);
    if (!isReadyToSpawn(readiness) || !ports.spawn.supported) {
      return fail("capability_unavailable", readiness.reason);
    }
    const launchId = randomUUID();
    const contract = launchContractFromSnapshot(snapshot, {
      snapshotId: input.snapshotId,
      attemptId: attempt.attemptId,
      launchId,
    });
    if (!contract.ok) return contract;

    const launching = ports.store.transition(ctx, {
      requestId: opId(input.requestId, "cas-launching"),
      attemptId: attempt.attemptId,
      expectedRevision: attempt.revision,
      to: "launching",
      launchId,
    });
    if (!launching.ok) return launching;

    const claimed = saveReceipt(
      ctx,
      draftFrom(launching.value, launchId, opId(input.requestId, "receipt"), {
        spawnKind: "unknown",
        jobBindState: "pending",
        needsReconciliation: true,
      }),
    );
    if (!claimed.view.persisted) {
      return ok({
        kind: "unknown",
        attempt: launching.value,
        code: "receipt_not_durable",
        message: LAUNCH_DURABILITY_LIMIT,
        receipt: claimed.view,
      });
    }

    const preSpawn = ports.liveIdentity.verify(ctx, snapshot, input.claimedBbProjectId, input.attestation);
    const preSpawnStale = !preSpawn.ok || !hostEnvRootMatches(snapshot, preSpawn.ok ? preSpawn.value : live.value);
    if (preSpawnStale) {
      const blocked = ports.store.transition(ctx, {
        requestId: opId(input.requestId, "stale-block"),
        attemptId: attempt.attemptId,
        expectedRevision: launching.value.revision,
        to: "failed",
      });
      const failedAttempt = blocked.ok ? blocked.value : launching.value;
      const receipt = saveReceipt(
        ctx,
        draftFrom(failedAttempt, launchId, opId(input.requestId, "receipt"), {
          spawnKind: "rejected",
          persistErrorCode: !preSpawn.ok ? preSpawn.error.code : "live_binding_mismatch",
          persistErrorMessage: "stale live identity blocked spawn; no SDK call",
          needsReconciliation: false,
        }),
      );
      return ok({
        kind: "failed",
        attempt: failedAttempt,
        code: !preSpawn.ok ? preSpawn.error.code : "live_binding_mismatch",
        message: "stale live identity blocked spawn; no SDK call",
        receipt: receipt.view,
      });
    }

    let outcome: SpawnOutcome;
    try {
      outcome = await ports.spawn.spawn(contract.value);
    } catch {
      return markUnknown(ctx, input.requestId, launching.value, launchId, "spawn_transport_unknown");
    }
    return settleSpawn(ctx, input, snapshot, launching.value, launchId, contract.value, outcome);
  }

  async function settleSpawn(
    ctx: ServiceContext,
    input: LaunchPreparedInput,
    snapshot: ContextSnapshot,
    launching: RunAttempt,
    launchId: string,
    contract: LaunchContract,
    outcome: SpawnOutcome,
  ): Promise<DomainResult<LaunchCoordinatorResult>> {
    const latest = ports.store.getAttempt(ctx, launching.attemptId);
    if (!latest.ok) return latest;
    const threadFromOutcome =
      outcome.kind === "confirmed" ? outcome.threadId : "threadId" in outcome ? outcome.threadId ?? null : null;

    if (latest.value.state !== "launching" || latest.value.revision !== launching.revision) {
      const receipt = saveReceipt(
        ctx,
        draftFrom(latest.value, launchId, opId(input.requestId, "receipt"), {
          threadId: threadFromOutcome ?? latest.value.threadId,
          spawnKind: threadFromOutcome ? "confirmed" : outcome.kind === "canceled" ? "canceled" : "unknown",
          persistErrorCode: "launch_race",
          persistErrorMessage: "attempt changed during spawn; confirmed identity is on the receipt",
          needsReconciliation: Boolean(threadFromOutcome) || latest.value.state === "canceled",
        }),
      );
      if (threadFromOutcome) {
        return ok({
          kind: "needs_reconciliation",
          attempt: latest.value,
          code: "orphan_thread",
          message: "spawn produced a thread after the attempt left launching; not success canceled",
          receipt: receipt.view,
        });
      }
      return ok({
        kind: "needs_reconciliation",
        attempt: latest.value,
        code: "launch_race",
        message: "attempt changed during spawn; reconcile by launchId, do not respawn",
        receipt: receipt.view,
      });
    }

    if (outcome.kind === "rejected") {
      const failed = ports.store.transition(ctx, {
        requestId: opId(input.requestId, "rejected"),
        attemptId: launching.attemptId,
        expectedRevision: latest.value.revision,
        to: "failed",
      });
      const attempt = failed.ok ? failed.value : latest.value;
      const receipt = saveReceipt(
        ctx,
        draftFrom(attempt, launchId, opId(input.requestId, "receipt"), {
          spawnKind: "rejected",
          persistErrorCode: failed.ok ? null : failed.error.code,
          persistErrorMessage: failed.ok ? outcome.message : failed.error.message,
          needsReconciliation: !failed.ok,
        }),
      );
      return ok({ kind: "failed", attempt, code: outcome.code, message: outcome.message, receipt: receipt.view });
    }

    if (outcome.kind === "canceled") {
      if (outcome.threadId) {
        const receipt = saveReceipt(
          ctx,
          draftFrom(latest.value, launchId, opId(input.requestId, "receipt"), {
            threadId: outcome.threadId,
            spawnKind: "confirmed",
            jobBindState: "pending",
            needsReconciliation: true,
            persistErrorCode: "cancel_with_thread",
            persistErrorMessage: "cancel reported a live thread; not success canceled",
          }),
        );
        return ok({
          kind: "needs_reconciliation",
          attempt: latest.value,
          code: "orphan_thread",
          message: "cancellation left a live thread; cancel only via supported port",
          receipt: receipt.view,
        });
      }
      const canceled = ports.store.transition(ctx, {
        requestId: opId(input.requestId, "canceled"),
        attemptId: launching.attemptId,
        expectedRevision: latest.value.revision,
        to: "canceled",
      });
      const attempt = canceled.ok ? canceled.value : latest.value;
      const receipt = saveReceipt(
        ctx,
        draftFrom(attempt, launchId, opId(input.requestId, "receipt"), {
          spawnKind: "canceled",
          persistErrorCode: canceled.ok ? null : canceled.error.code,
          persistErrorMessage: canceled.ok ? outcome.message : canceled.error.message,
          needsReconciliation: !canceled.ok,
        }),
      );
      return ok({
        kind: "canceled",
        attempt,
        code: outcome.code,
        message: outcome.message,
        receipt: receipt.view,
      });
    }

    if (outcome.kind === "unknown") {
      return markUnknown(ctx, input.requestId, latest.value, launchId, outcome.code, outcome.threadId ?? null);
    }

    const bound = ports.store.transition(ctx, {
      requestId: opId(input.requestId, "bind-running"),
      attemptId: launching.attemptId,
      expectedRevision: latest.value.revision,
      to: "running",
      threadId: outcome.threadId,
      launchId,
    });
    if (!bound.ok) {
      const receipt = saveReceipt(
        ctx,
        draftFrom(latest.value, launchId, opId(input.requestId, "receipt"), {
          threadId: outcome.threadId,
          spawnKind: "confirmed",
          persistErrorCode: bound.error.code,
          persistErrorMessage: bound.error.message,
          needsReconciliation: true,
          jobBindState: "pending",
        }),
      );
      return ok({
        kind: "unknown",
        attempt: latest.value,
        code: "persist_after_spawn",
        message: `${bound.error.code}: confirmed thread kept on receipt. ${LAUNCH_DURABILITY_LIMIT}`,
        receipt: receipt.view,
      });
    }

    const job = await applyJobBind(
      ctx,
      input.requestId,
      bound.value,
      outcome.threadId,
      launchId,
      draftFrom(bound.value, launchId, opId(input.requestId, "receipt"), { spawnKind: "confirmed" }),
    );
    return ok({
      kind: "running",
      attempt: bound.value,
      contract,
      jobStateApplied: job.applied,
      receipt: job.receipt,
    });
  }

  async function recoverFromReceipt(
    ctx: ServiceContext,
    parentRequestId: string,
    receipt: LaunchReceipt,
    attestation: ReserveAttestation,
    claimedBbProjectId: string | undefined,
  ): Promise<DomainResult<LaunchCoordinatorResult>> {
    void attestation;
    void claimedBbProjectId;
    return reconcileLaunch(ctx, {
      requestId: parentRequestId,
      attemptId: receipt.attemptId,
      launchId: receipt.launchId,
    });
  }

  function draftFromView(view: LaunchReceiptView, parentRequestId: string): LaunchReceiptDraft {
    return {
      launchId: view.launchId,
      attemptId: view.attemptId,
      jobId: view.jobId,
      snapshotId: view.snapshotId,
      digest: view.digest,
      threadId: view.threadId,
      spawnKind: view.spawnKind,
      persistErrorCode: view.persistError?.code ?? null,
      persistErrorMessage: view.persistError?.message ?? null,
      jobBindState: view.jobBindState,
      needsReconciliation: view.needsReconciliation,
      parentRequestId,
    };
  }

  function mergeKnownReceipt(
    attempt: RunAttempt,
    input: ReconcileLaunchInput,
    stored: LaunchReceipt | undefined,
  ): DomainResult<LaunchReceipt | LaunchReceiptDraft | undefined> {
    const known = input.knownReceipt;
    if (!known) return ok(stored);
    if (known.launchId !== input.launchId || known.attemptId !== input.attemptId) {
      return fail("bind_id_immutable", "known receipt identity does not match the reconcile launch");
    }
    if (known.jobId !== attempt.jobId || known.snapshotId !== attempt.snapshotId) {
      return fail("binding_mismatch", "known receipt does not match the live attempt");
    }
    if (attempt.launchId && attempt.launchId !== known.launchId) {
      return fail("bind_id_immutable", "known receipt launchId does not match the stored launchId");
    }
    if (attempt.threadId && known.threadId && attempt.threadId !== known.threadId) {
      return fail("bind_id_immutable", "known receipt threadId cannot replace the bound thread");
    }
    if (stored?.threadId && known.threadId && stored.threadId !== known.threadId) {
      return fail("bind_id_immutable", "known receipt threadId cannot replace the stored thread");
    }
    if (stored?.spawnKind === "confirmed" && known.spawnKind !== "confirmed") {
      return fail("bind_id_immutable", "confirmed spawn receipt cannot be downgraded");
    }
    const offered = draftFromView(known, input.requestId);
    if (!stored) return ok(offered);
    return ok({
      ...stored,
      threadId: stored.threadId ?? offered.threadId,
      spawnKind: stored.spawnKind === "confirmed" ? "confirmed" : offered.spawnKind,
      persistErrorCode: offered.persistErrorCode,
      persistErrorMessage: offered.persistErrorMessage,
      jobBindState: offered.jobBindState,
      needsReconciliation: offered.needsReconciliation,
      parentRequestId: offered.parentRequestId,
    });
  }

  async function bindVerifiedThread(
    ctx: ServiceContext,
    input: ReconcileLaunchInput,
    attempt: RunAttempt,
    receipt: LaunchReceipt | LaunchReceiptDraft,
    stored: LaunchReceipt | undefined,
    hintThreadId: string,
  ): Promise<DomainResult<LaunchCoordinatorResult>> {
    const snapshot = ports.store.getSnapshot(ctx, attempt.snapshotId);
    if (!snapshot.ok) return snapshot;
    const contract = launchContractFromSnapshot(snapshot.value.snapshot, {
      snapshotId: snapshot.value.snapshotId,
      attemptId: attempt.attemptId,
      launchId: input.launchId,
    });
    if (!contract.ok) return contract;

    const hint = {
      ...receipt,
      threadId: stored?.threadId ?? null,
      persistErrorCode: receipt.persistErrorCode ?? null,
      persistErrorMessage: receipt.persistErrorMessage ?? null,
      needsReconciliation: true,
      parentRequestId: opId(input.requestId, "receipt"),
    };
    saveReceipt(ctx, hint);

    if (!ports.threadVerify.supported) {
      const saved = saveReceipt(ctx, {
        ...hint,
        persistErrorCode: "thread_verify_unavailable",
        persistErrorMessage:
          "thread lookup is not supported; knownReceipt is a hint only. Recovery stays pending — no running, no Job callback",
      });
      return ok({
        kind: "needs_reconciliation",
        attempt,
        code: "thread_verify_unavailable",
        message: saved.view.persistError?.message ?? "thread lookup is not supported",
        receipt: saved.view,
      });
    }

    const verified = await ports.threadVerify.verifyConfirmedThread(
      {
        launchId: input.launchId,
        attemptId: attempt.attemptId,
        threadId: hintThreadId,
        jobId: attempt.jobId,
        snapshotId: attempt.snapshotId,
        digest: attempt.digest,
      },
      snapshot.value.snapshot,
    );
    if (verified.kind === "unavailable") {
      const saved = saveReceipt(ctx, {
        ...hint,
        persistErrorCode: verified.code,
        persistErrorMessage: verified.message,
      });
      return ok({
        kind: "needs_reconciliation",
        attempt,
        code: verified.code,
        message: verified.message,
        receipt: saved.view,
      });
    }
    if (verified.kind === "rejected") {
      const saved = saveReceipt(ctx, {
        ...hint,
        persistErrorCode: verified.code,
        persistErrorMessage: verified.message,
      });
      return ok({
        kind: "needs_reconciliation",
        attempt,
        code: verified.code,
        message: verified.message,
        receipt: saved.view,
      });
    }

    const identity = verified.identity;
    if (identity.launchId !== input.launchId || identity.attemptId !== attempt.attemptId) {
      const saved = saveReceipt(ctx, {
        ...hint,
        persistErrorCode: "bind_id_immutable",
        persistErrorMessage: "verified launch/attempt does not match the stored attempt",
      });
      return ok({
        kind: "needs_reconciliation",
        attempt,
        code: "bind_id_immutable",
        message: "verified launch/attempt does not match the stored attempt",
        receipt: saved.view,
      });
    }
    if (identity.threadId !== hintThreadId) {
      const saved = saveReceipt(ctx, {
        ...hint,
        persistErrorCode: "thread_mismatch",
        persistErrorMessage: "hint thread is not the provider-confirmed thread",
      });
      return ok({
        kind: "needs_reconciliation",
        attempt,
        code: "thread_mismatch",
        message: "hint thread is not the provider-confirmed thread",
        receipt: saved.view,
      });
    }
    if (!hostEnvRootMatches(snapshot.value.snapshot, identity)) {
      const saved = saveReceipt(ctx, {
        ...hint,
        persistErrorCode: "live_binding_mismatch",
        persistErrorMessage: "verified host/env/root/project does not match the stored snapshot",
      });
      return ok({
        kind: "needs_reconciliation",
        attempt,
        code: "live_binding_mismatch",
        message: "verified host/env/root/project does not match the stored snapshot",
        receipt: saved.view,
      });
    }
    if (identity.providerId !== snapshot.value.snapshot.agentVersion.providerId) {
      const saved = saveReceipt(ctx, {
        ...hint,
        persistErrorCode: "live_binding_mismatch",
        persistErrorMessage: "verified provider does not match the stored snapshot",
      });
      return ok({
        kind: "needs_reconciliation",
        attempt,
        code: "live_binding_mismatch",
        message: "verified provider does not match the stored snapshot",
        receipt: saved.view,
      });
    }

    const bound = ports.store.transition(ctx, {
      requestId: opId(input.requestId, "reconcile-bind"),
      attemptId: attempt.attemptId,
      expectedRevision: attempt.revision,
      to: "running",
      threadId: identity.threadId,
      launchId: input.launchId,
    });
    if (!bound.ok) {
      const kept = saveReceipt(ctx, {
        ...hint,
        persistErrorCode: bound.error.code,
        persistErrorMessage: bound.error.message,
      });
      return ok({
        kind: "unknown",
        attempt,
        code: "persist_after_spawn",
        message: `${bound.error.message}. ${LAUNCH_DURABILITY_LIMIT}`,
        receipt: kept.view,
      });
    }
    const job = await applyJobBind(
      ctx,
      input.requestId,
      bound.value,
      identity.threadId,
      input.launchId,
      draftFrom(bound.value, input.launchId, opId(input.requestId, "repair-job"), { spawnKind: "confirmed" }),
    );
    return ok({
      kind: "running",
      attempt: bound.value,
      contract: contract.value,
      jobStateApplied: job.applied,
      receipt: job.receipt,
    });
  }

  async function reconcileLaunch(
    ctx: ServiceContext,
    input: ReconcileLaunchInput,
  ): Promise<DomainResult<LaunchCoordinatorResult>> {
    const requestId = requestIdSchema.safeParse(input.requestId);
    if (!requestId.success) return fail("invalid_command", "requestId must be a UUID");
    const attempt = ports.store.getAttempt(ctx, input.attemptId);
    if (!attempt.ok) return attempt;
    if (attempt.value.launchId && attempt.value.launchId !== input.launchId) {
      return fail("bind_id_immutable", "reconcile launchId does not match the stored launchId");
    }
    const storedReceipt = ports.store.getReceipt(ctx, input.launchId);
    const stored = storedReceipt.ok ? storedReceipt.value : undefined;
    const merged = mergeKnownReceipt(attempt.value, input, stored);
    if (!merged.ok) return merged;
    const receipt = merged.value;

    if (attempt.value.state === "running" && attempt.value.threadId) {
      const snapshot = ports.store.getSnapshot(ctx, attempt.value.snapshotId);
      if (!snapshot.ok) return snapshot;
      const contract = launchContractFromSnapshot(snapshot.value.snapshot, {
        snapshotId: snapshot.value.snapshotId,
        attemptId: attempt.value.attemptId,
        launchId: input.launchId,
      });
      if (!contract.ok) return contract;
      const job = await applyJobBind(
        ctx,
        input.requestId,
        attempt.value,
        attempt.value.threadId,
        input.launchId,
        draftFrom(attempt.value, input.launchId, opId(input.requestId, "repair-job"), {
          threadId: attempt.value.threadId,
          spawnKind: "confirmed",
          jobBindState: receipt?.jobBindState === "applied" ? "applied" : "needs_repair",
        }),
      );
      return ok({
        kind: "running",
        attempt: attempt.value,
        contract: contract.value,
        jobStateApplied: job.applied,
        receipt: job.receipt,
      });
    }

    if (receipt?.threadId && (attempt.value.state === "launching" || attempt.value.state === "unknown")) {
      return bindVerifiedThread(ctx, input, attempt.value, receipt, stored, receipt.threadId);
    }

    if (attempt.value.state === "canceled" && receipt?.threadId) {
      if (ports.spawn.cancelThread) {
        const canceled = await ports.spawn.cancelThread(receipt.threadId);
        if (canceled.ok) {
          const saved = saveReceipt(ctx, {
            ...receipt,
            needsReconciliation: false,
            persistErrorCode: null,
            persistErrorMessage: null,
            parentRequestId: opId(input.requestId, "receipt"),
          });
          return ok({
            kind: "canceled",
            attempt: attempt.value,
            code: "thread_canceled",
            message: "orphan thread canceled through the supported port",
            receipt: saved.view,
          });
        }
      }
      return ok({
        kind: "needs_reconciliation",
        attempt: attempt.value,
        code: "orphan_thread",
        message: "canceled attempt still has a live thread on the receipt; cancel only via supported port",
        receipt: viewFromDraft(receipt, Boolean(stored)),
      });
    }

    if (!ports.spawn.reconcileByLaunchId) {
      return ok({
        kind: "unknown",
        attempt: attempt.value,
        code: "reconcile_unsupported",
        message: "no durable thread on receipt and spawn port cannot reconcile; do not invent SDK idempotency",
        receipt: receipt
          ? viewFromDraft(receipt, Boolean(stored))
          : viewFromDraft(draftFrom(attempt.value, input.launchId, input.requestId, { needsReconciliation: true }), false),
      });
    }
    const found = await ports.spawn.reconcileByLaunchId(input.launchId);
    if (found.kind === "unsupported" || found.kind === "unknown") {
      return ok({
        kind: "unknown",
        attempt: attempt.value,
        code: found.kind === "unsupported" ? "reconcile_unsupported" : found.code,
        message: found.kind === "unsupported" ? "launchId reconcile is not supported on this port" : found.message,
        receipt: receipt
          ? viewFromDraft(receipt, Boolean(stored))
          : viewFromDraft(draftFrom(attempt.value, input.launchId, input.requestId, { needsReconciliation: true }), false),
      });
    }
    if (found.kind === "confirmed") {
      return bindVerifiedThread(
        ctx,
        input,
        attempt.value,
        receipt ?? draftFrom(attempt.value, input.launchId, input.requestId, { threadId: found.threadId, spawnKind: "confirmed" }),
        stored,
        found.threadId,
      );
    }
    if (found.kind === "rejected") {
      const failed = ports.store.transition(ctx, {
        requestId: opId(input.requestId, "reconcile-failed"),
        attemptId: attempt.value.attemptId,
        expectedRevision: attempt.value.revision,
        to: "failed",
      });
      const next = failed.ok ? failed.value : attempt.value;
      const saved = saveReceipt(
        ctx,
        draftFrom(next, input.launchId, opId(input.requestId, "receipt"), {
          spawnKind: "rejected",
          persistErrorCode: failed.ok ? found.code : failed.error.code,
          persistErrorMessage: found.message,
        }),
      );
      return ok({ kind: "failed", attempt: next, code: found.code, message: found.message, receipt: saved.view });
    }
    if (found.threadId) {
      return ok({
        kind: "needs_reconciliation",
        attempt: attempt.value,
        code: "orphan_thread",
        message: "reconcile saw a canceled outcome with a thread",
        receipt: viewFromDraft(
          draftFrom(attempt.value, input.launchId, input.requestId, {
            threadId: found.threadId,
            spawnKind: "confirmed",
            needsReconciliation: true,
          }),
          false,
        ),
      });
    }
    const canceled = ports.store.transition(ctx, {
      requestId: opId(input.requestId, "reconcile-canceled"),
      attemptId: attempt.value.attemptId,
      expectedRevision: attempt.value.revision,
      to: "canceled",
    });
    const next = canceled.ok ? canceled.value : attempt.value;
    const saved = saveReceipt(
      ctx,
      draftFrom(next, input.launchId, opId(input.requestId, "receipt"), { spawnKind: "canceled" }),
    );
    return ok({ kind: "canceled", attempt: next, code: found.code, message: found.message, receipt: saved.view });
  }

  function loadPrepared(
    ctx: ServiceContext,
    input: LaunchPreparedInput,
  ): DomainResult<{ snapshot: ContextSnapshot; attempt: RunAttempt }> {
    const stored = ports.store.getSnapshot(ctx, input.snapshotId);
    if (!stored.ok) return stored;
    if (stored.value.digest !== input.digest || stored.value.snapshot.digest !== input.digest) {
      return fail("snapshot_digest_mismatch", "request digest does not match the stored snapshot");
    }
    const attempt = ports.store.getAttempt(ctx, input.attemptId);
    if (!attempt.ok) return attempt;
    if (attempt.value.snapshotId !== input.snapshotId || attempt.value.digest !== input.digest) {
      return fail("snapshot_digest_mismatch", "attempt digest does not match the snapshot");
    }
    if (attempt.value.state === "unknown" || attempt.value.state === "awaiting_review") {
      return fail(
        "spawn_not_allowed",
        `attempt is ${attempt.value.state}; spawn is only allowed from prepared`,
      );
    }
    if (attempt.value.state !== "prepared") {
      return fail("not_prepared", `attempt is ${attempt.value.state}; only prepared may launch`);
    }
    return ok({ snapshot: stored.value.snapshot, attempt: attempt.value });
  }

  function markUnknown(
    ctx: ServiceContext,
    parentRequestId: string,
    current: RunAttempt,
    launchId: string,
    code: string,
    threadId: string | null = null,
  ): DomainResult<LaunchCoordinatorResult> {
    const unknown = ports.store.transition(ctx, {
      requestId: opId(parentRequestId, "unknown"),
      attemptId: current.attemptId,
      expectedRevision: current.revision,
      to: "unknown",
      launchId,
    });
    const attempt = unknown.ok ? unknown.value : current;
    const receipt = saveReceipt(
      ctx,
      draftFrom(attempt, launchId, opId(parentRequestId, "receipt"), {
        threadId,
        spawnKind: threadId ? "confirmed" : "unknown",
        persistErrorCode: unknown.ok ? code : "persist_after_spawn",
        persistErrorMessage: unknown.ok
          ? "transport outcome is unknown; do not automatically retry spawn"
          : unknown.error.message,
        needsReconciliation: true,
      }),
    );
    return ok({
      kind: threadId ? "needs_reconciliation" : "unknown",
      attempt,
      code: unknown.ok ? code : "persist_after_spawn",
      message: threadId
        ? "unknown transport left a thread on the receipt"
        : "transport outcome is unknown; do not automatically retry spawn",
      receipt: receipt.view,
    });
  }

  return {
    status: LAUNCH_COORDINATOR_STATUS,
    launchPreparedRun,
    reconcileLaunch,
  };
}

export type LaunchCoordinator = ReturnType<typeof createLaunchCoordinator>;
