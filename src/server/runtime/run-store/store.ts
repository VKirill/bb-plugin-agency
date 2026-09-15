import { fail, ok, type DomainResult } from "../../../domain";
import { matchRevision } from "../../../domain";
import { requestIdSchema } from "../../../shared/contracts";
import { commitDomainTransaction } from "../../db/domain-txn";
import { newOpaqueId } from "../../db/ids";
import { createRepositories } from "../../db/repositories";
import { parseJson, toJson, type SqlDatabase } from "../../db/sql";
import { assertBindingAccess, assertBindingScope, nowUtc, type ServiceContext } from "../../services/context";
import { payloadWithoutRequestId, sameActor, sameCanonical } from "../../services/request-identity";
import type { ContextSnapshot } from "../context-snapshot/types.js";
import { assertSnapshotIntegrity } from "./digest.js";
import { identityOptional } from "./identity.js";
import { assertAttemptTransition, requiresConfirmedThread } from "./states.js";
import {
  RUN_ATTEMPT_STATES,
  type InternalRunStoreReads,
  type LaunchReceipt,
  type PersistedContextSnapshot,
  type RecordLaunchReceiptInput,
  type ReservePreparedRunInput,
  type ReservedPreparedRun,
  type RunAttempt,
  type RunAttemptState,
  type RunStore,
  type TransitionRunAttemptInput,
} from "./types.js";
import { verifyAuthorizedRecords, verifyLiveLaunchIdentity } from "./verify-live.js";

type SnapshotRow = {
  id: string;
  job_id: string;
  digest: string;
  snapshot_json: string;
  created_at: string;
};

type ReceiptRow = {
  launch_id: string;
  attempt_id: string;
  job_id: string;
  snapshot_id: string;
  digest: string;
  thread_id: string | null;
  spawn_kind: LaunchReceipt["spawnKind"];
  persist_error_code: string | null;
  persist_error_message: string | null;
  job_bind_state: LaunchReceipt["jobBindState"];
  needs_reconciliation: number;
  parent_request_id: string;
  created_at: string;
  updated_at: string;
};

type AttemptRow = {
  id: string;
  job_id: string;
  attempt_no: number;
  snapshot_id: string;
  digest: string;
  thread_id: string | null;
  launch_id: string | null;
  state: RunAttemptState;
  revision: number;
  created_at: string;
  updated_at: string;
};

function mapReceipt(row: ReceiptRow): LaunchReceipt {
  return {
    launchId: row.launch_id,
    attemptId: row.attempt_id,
    jobId: row.job_id,
    snapshotId: row.snapshot_id,
    digest: row.digest,
    threadId: row.thread_id,
    spawnKind: row.spawn_kind,
    persistErrorCode: row.persist_error_code,
    persistErrorMessage: row.persist_error_message,
    jobBindState: row.job_bind_state,
    needsReconciliation: row.needs_reconciliation === 1,
    parentRequestId: row.parent_request_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAttempt(row: AttemptRow): RunAttempt {
  return {
    attemptId: row.id,
    jobId: row.job_id,
    attemptNo: row.attempt_no,
    snapshotId: row.snapshot_id,
    digest: row.digest,
    threadId: row.thread_id,
    launchId: row.launch_id,
    state: row.state,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseStoredSnapshot(row: SnapshotRow): DomainResult<PersistedContextSnapshot> {
  let snapshot: ContextSnapshot;
  try {
    snapshot = parseJson<ContextSnapshot>(row.snapshot_json);
  } catch {
    return fail("snapshot_corrupt", `snapshot ${row.id} JSON is not parseable`);
  }
  const integrity = assertSnapshotIntegrity(snapshot);
  if (!integrity.ok) {
    return fail(integrity.code, integrity.message);
  }
  if (snapshot.digest !== row.digest) {
    return fail("snapshot_corrupt", `snapshot ${row.id} stored digest does not match body`);
  }
  if (snapshot.job.id !== row.job_id) {
    return fail("snapshot_corrupt", `snapshot ${row.id} jobId does not match stored link`);
  }
  return ok({
    snapshotId: row.id,
    jobId: row.job_id,
    digest: row.digest,
    snapshot,
    createdAt: row.created_at,
  });
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE|FOREIGN KEY/i.test(error.message);
}

function nextBoundId(
  current: string | null,
  incoming: string | null | undefined,
  field: "threadId" | "launchId",
): DomainResult<string | null> {
  if (incoming === undefined) return ok(current);
  if (incoming === null) {
    if (current !== null) {
      return fail("bind_id_immutable", `${field} is already bound and cannot be cleared`);
    }
    return ok(null);
  }
  if (current !== null && current !== incoming) {
    return fail("bind_id_immutable", `${field} is already bound and cannot be replaced`);
  }
  return ok(incoming);
}

export function createRunStore(db: SqlDatabase): RunStore {
  return createRunStoreParts(db).writes;
}

/** @internal Not published. Requires ServiceContext. Do not wire to register/RPC/CLI. */
export function createInternalRunStoreReads(db: SqlDatabase): InternalRunStoreReads {
  return createRunStoreParts(db).reads;
}

function createRunStoreParts(db: SqlDatabase): { writes: RunStore; reads: InternalRunStoreReads } {
  const repos = createRepositories(db);

  function remember<T>(
    ctx: ServiceContext,
    identity: { requestId: string; kind: string; payload: unknown; scopeBindingIds: readonly string[] },
    run: () => DomainResult<T>,
  ): DomainResult<T> {
    const payload = payloadWithoutRequestId(identity.payload);
    const existing = repos.request.get(identity.requestId);
    if (existing) {
      for (const bindingId of existing.scopeBindingIds) {
        const access = assertBindingAccess(ctx, bindingId);
        if (!access.ok) return access;
      }
      if (
        existing.kind !== identity.kind ||
        !sameCanonical(existing.payload, payload) ||
        !sameActor(existing.actor, ctx.actor) ||
        !sameCanonical(existing.scopeBindingIds, identity.scopeBindingIds)
      ) {
        return fail(
          "request_conflict",
          `request ${identity.requestId} already used with a different kind, payload, actor or scope`,
        );
      }
      return existing.result as DomainResult<T>;
    }
    const result = run();
    repos.request.insert(
      identity.requestId,
      identity.kind,
      result,
      payload,
      ctx.actor,
      identity.scopeBindingIds,
      nowUtc(ctx),
    );
    return result;
  }

  function getSnapshotRow(snapshotId: string): SnapshotRow | undefined {
    return db.prepare(`SELECT * FROM agency_context_snapshot WHERE id = ?`).get(snapshotId) as SnapshotRow | undefined;
  }

  function getSnapshotByDigest(digest: string): SnapshotRow | undefined {
    return db.prepare(`SELECT * FROM agency_context_snapshot WHERE digest = ?`).get(digest) as SnapshotRow | undefined;
  }

  function getAttemptRow(attemptId: string): AttemptRow | undefined {
    return db.prepare(`SELECT * FROM agency_run_attempt WHERE id = ?`).get(attemptId) as AttemptRow | undefined;
  }

  function listAttemptRows(jobId: string): AttemptRow[] {
    return db
      .prepare(`SELECT * FROM agency_run_attempt WHERE job_id = ? ORDER BY attempt_no ASC`)
      .all(jobId) as AttemptRow[];
  }

  function findActiveAttempt(jobId: string): AttemptRow | undefined {
    return db
      .prepare(
        `SELECT * FROM agency_run_attempt
         WHERE job_id = ? AND state IN ('prepared', 'launching', 'running', 'waiting_input', 'awaiting_review', 'unknown')`,
      )
      .get(jobId) as AttemptRow | undefined;
  }

  function nextAttemptNo(jobId: string): number {
    const row = db.prepare(`SELECT MAX(attempt_no) AS n FROM agency_run_attempt WHERE job_id = ?`).get(jobId) as {
      n: number | null;
    };
    return (row.n ?? 0) + 1;
  }

  function loadSnapshot(snapshotId: string): DomainResult<PersistedContextSnapshot> {
    const row = getSnapshotRow(snapshotId);
    if (!row) return fail("not_found", `snapshot ${snapshotId} not found`);
    return parseStoredSnapshot(row);
  }

  function requireAttestation(input: ReservePreparedRunInput): DomainResult<true> {
    const { attestation } = input;
    if (!attestation || attestation.accessVerified !== true || attestation.revisionsVerified !== true) {
      return fail(
        "attestation_required",
        "caller must verify access and revisions before reserve; compiler snapshot is not authorization",
      );
    }
    return ok(true);
  }

  function verifyLiveRecords(ctx: ServiceContext, input: ReservePreparedRunInput): DomainResult<{
    jobId: string;
    bindingId: string;
  }> {
    const live = verifyLiveLaunchIdentity(
      ctx,
      repos,
      input.snapshot,
      input.claimedBbProjectId,
      input.attestation,
    );
    if (!live.ok) return live;
    const authorized = verifyAuthorizedRecords(ctx, repos, input.snapshot, (attemptId) => {
      const row = getAttemptRow(attemptId);
      return row ? { jobId: row.job_id } : undefined;
    });
    if (!authorized.ok) return authorized;
    return ok({ jobId: live.value.job.id, bindingId: live.value.binding.id });
  }

  const reservePreparedRun = (
    ctx: ServiceContext,
    input: ReservePreparedRunInput,
  ): DomainResult<ReservedPreparedRun> => {
    const requestId = requestIdSchema.safeParse(input.requestId);
    if (!requestId.success) return fail("invalid_command", "requestId must be a UUID");
    const attested = requireAttestation(input);
    if (!attested.ok) return attested;
    const integrity = assertSnapshotIntegrity(input.snapshot);
    if (!integrity.ok) return fail(integrity.code, integrity.message);
    return commitDomainTransaction(db, () => {
      const live = verifyLiveRecords(ctx, input);
      if (!live.ok) return live;
      return remember(
        ctx,
        {
          requestId: input.requestId,
          kind: "runStore.reservePreparedRun",
          payload: {
            digest: input.snapshot.digest,
            jobId: input.snapshot.job.id,
            jobRevision: input.attestation.expectedJobRevision,
            bindingRevision: input.attestation.expectedBindingRevision,
          },
          scopeBindingIds: [live.value.bindingId],
        },
        () => {
          const existingByDigest = getSnapshotByDigest(input.snapshot.digest);
          let snapshotId: string;
          if (existingByDigest) {
            const stored = parseStoredSnapshot(existingByDigest);
            if (!stored.ok) return stored;
            if (!sameCanonical(stored.value.snapshot, input.snapshot)) {
              return fail("snapshot_digest_conflict", "digest already stored with a different snapshot body");
            }
            if (existingByDigest.job_id !== input.snapshot.job.id) {
              return fail("snapshot_digest_conflict", "digest is already bound to another job");
            }
            snapshotId = existingByDigest.id;
          } else {
            snapshotId = newOpaqueId("snapshot");
            try {
              db.prepare(
                `INSERT INTO agency_context_snapshot (id, job_id, digest, snapshot_json, created_at)
                 VALUES (?, ?, ?, ?, ?)`,
              ).run(snapshotId, input.snapshot.job.id, input.snapshot.digest, toJson(input.snapshot), nowUtc(ctx));
            } catch (error) {
              if (isConstraintError(error)) {
                return fail("snapshot_digest_conflict", "snapshot insert conflicted; no silent overwrite");
              }
              throw error;
            }
          }
          const active = findActiveAttempt(input.snapshot.job.id);
          if (active) {
            return fail("active_attempt_exists", `job ${input.snapshot.job.id} already has an active attempt`);
          }
          const attempt: RunAttempt = {
            attemptId: newOpaqueId("runAttempt"),
            jobId: input.snapshot.job.id,
            attemptNo: nextAttemptNo(input.snapshot.job.id),
            snapshotId,
            digest: input.snapshot.digest,
            threadId: null,
            launchId: null,
            state: "prepared",
            revision: 1,
            createdAt: nowUtc(ctx),
            updatedAt: nowUtc(ctx),
          };
          try {
            db.prepare(
              `INSERT INTO agency_run_attempt
                (id, job_id, attempt_no, snapshot_id, digest, thread_id, launch_id, state, revision, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              attempt.attemptId,
              attempt.jobId,
              attempt.attemptNo,
              attempt.snapshotId,
              attempt.digest,
              attempt.threadId,
              attempt.launchId,
              attempt.state,
              attempt.revision,
              attempt.createdAt,
              attempt.updatedAt,
            );
          } catch (error) {
            if (isConstraintError(error)) {
              return fail("active_attempt_exists", `job ${input.snapshot.job.id} already has an active attempt`);
            }
            throw error;
          }
          return ok({ snapshotId, digest: input.snapshot.digest, attempt });
        },
      );
    });
  };

  const transitionAttempt = (ctx: ServiceContext, input: TransitionRunAttemptInput): DomainResult<RunAttempt> => {
    const requestId = requestIdSchema.safeParse(input.requestId);
    if (!requestId.success) return fail("invalid_command", "requestId must be a UUID");
    if (!(RUN_ATTEMPT_STATES as readonly string[]).includes(input.to)) {
      return fail("invalid_command", `unknown attempt state ${String(input.to)}`);
    }
    return commitDomainTransaction(db, () => {
      const row = getAttemptRow(input.attemptId);
      if (!row) return fail("not_found", `attempt ${input.attemptId} not found`);
      const job = repos.job.get(row.job_id);
      if (!job) return fail("not_found", `job ${row.job_id} not found`);
      const binding = repos.binding.get(job.bindingId);
      if (!binding) return fail("not_found", `binding ${job.bindingId} not found`);
      const scope = assertBindingScope(ctx, binding, input.claimedBbProjectId);
      if (!scope.ok) return scope;
      return remember(
        ctx,
        {
          requestId: input.requestId,
          kind: "runStore.transitionAttempt",
          payload: {
            attemptId: input.attemptId,
            expectedRevision: input.expectedRevision,
            to: input.to,
            threadId: identityOptional(input.threadId),
            launchId: identityOptional(input.launchId),
          },
          scopeBindingIds: [binding.id],
        },
        () => {
          const current = getAttemptRow(input.attemptId);
          if (!current) return fail("not_found", `attempt ${input.attemptId} not found`);
          const cas = matchRevision(current.revision, {
            expectedRevision: input.expectedRevision,
            requestId: input.requestId,
          });
          if (!cas.ok) return cas;
          const allowed = assertAttemptTransition(current.state, input.to);
          if (!allowed.ok) return allowed;
          const nextThread = nextBoundId(current.thread_id, input.threadId, "threadId");
          if (!nextThread.ok) return nextThread;
          const nextLaunch = nextBoundId(current.launch_id, input.launchId, "launchId");
          if (!nextLaunch.ok) return nextLaunch;
          if (requiresConfirmedThread(input.to) && !nextThread.value) {
            return fail("thread_required", `${input.to} requires a confirmed threadId; job state is not changed here`);
          }
          const updated: AttemptRow = {
            ...current,
            state: input.to,
            thread_id: nextThread.value,
            launch_id: nextLaunch.value,
            revision: current.revision + 1,
            updated_at: nowUtc(ctx),
          };
          db.prepare(
            `UPDATE agency_run_attempt
             SET state = ?, thread_id = ?, launch_id = ?, revision = ?, updated_at = ?
             WHERE id = ? AND revision = ?`,
          ).run(
            updated.state,
            updated.thread_id,
            updated.launch_id,
            updated.revision,
            updated.updated_at,
            updated.id,
            current.revision,
          );
          const written = getAttemptRow(input.attemptId);
          if (!written || written.revision !== updated.revision) {
            return fail("revision_conflict", "attempt revision changed during update");
          }
          return ok(mapAttempt(written));
        },
      );
    });
  };

  const recordLaunchReceipt = (
    ctx: ServiceContext,
    input: RecordLaunchReceiptInput,
  ): DomainResult<LaunchReceipt> => {
    const requestId = requestIdSchema.safeParse(input.requestId);
    if (!requestId.success) return fail("invalid_command", "requestId must be a UUID");
    return commitDomainTransaction(db, () => {
      const attempt = getAttemptRow(input.receipt.attemptId);
      if (!attempt) return fail("not_found", `attempt ${input.receipt.attemptId} not found`);
      const job = repos.job.get(attempt.job_id);
      if (!job) return fail("not_found", `job ${attempt.job_id} not found`);
      const binding = repos.binding.get(job.bindingId);
      if (!binding) return fail("not_found", `binding ${job.bindingId} not found`);
      const scope = assertBindingScope(ctx, binding, input.claimedBbProjectId);
      if (!scope.ok) return scope;
      if (input.receipt.jobId !== job.id || input.receipt.snapshotId !== attempt.snapshot_id) {
        return fail("binding_mismatch", "receipt does not match the live attempt");
      }
      const existing = getReceiptRow(input.receipt.launchId) ?? getReceiptRowByAttempt(attempt.id);
      const nextThread = nextBoundId(existing?.thread_id ?? null, input.receipt.threadId ?? undefined, "threadId");
      if (!nextThread.ok) return nextThread;
      if (existing && existing.launch_id !== input.receipt.launchId) {
        return fail("bind_id_immutable", "attempt already has a different launch receipt");
      }
      if (existing && existing.spawn_kind === "confirmed" && input.receipt.spawnKind !== "confirmed") {
        return fail("bind_id_immutable", "confirmed spawn receipt cannot be downgraded");
      }
      const now = nowUtc(ctx);
      const row: ReceiptRow = {
        launch_id: input.receipt.launchId,
        attempt_id: attempt.id,
        job_id: job.id,
        snapshot_id: attempt.snapshot_id,
        digest: attempt.digest,
        thread_id: nextThread.value,
        spawn_kind: existing?.spawn_kind === "confirmed" ? "confirmed" : input.receipt.spawnKind,
        persist_error_code: input.receipt.persistErrorCode,
        persist_error_message: input.receipt.persistErrorMessage,
        job_bind_state: input.receipt.jobBindState,
        needs_reconciliation: input.receipt.needsReconciliation ? 1 : 0,
        parent_request_id: input.receipt.parentRequestId,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      db.prepare(
        `INSERT INTO agency_launch_receipt (
          launch_id, attempt_id, job_id, snapshot_id, digest, thread_id, spawn_kind,
          persist_error_code, persist_error_message, job_bind_state, needs_reconciliation,
          parent_request_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(launch_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          spawn_kind = excluded.spawn_kind,
          persist_error_code = excluded.persist_error_code,
          persist_error_message = excluded.persist_error_message,
          job_bind_state = excluded.job_bind_state,
          needs_reconciliation = excluded.needs_reconciliation,
          updated_at = excluded.updated_at`,
      ).run(
        row.launch_id,
        row.attempt_id,
        row.job_id,
        row.snapshot_id,
        row.digest,
        row.thread_id,
        row.spawn_kind,
        row.persist_error_code,
        row.persist_error_message,
        row.job_bind_state,
        row.needs_reconciliation,
        row.parent_request_id,
        row.created_at,
        row.updated_at,
      );
      const stored = getReceiptRow(row.launch_id);
      return stored ? ok(mapReceipt(stored)) : fail("snapshot_corrupt", "launch receipt was not stored");
    });
  };

  function getReceiptRow(launchId: string): ReceiptRow | undefined {
    return db.prepare(`SELECT * FROM agency_launch_receipt WHERE launch_id = ?`).get(launchId) as ReceiptRow | undefined;
  }

  function getReceiptRowByAttempt(attemptId: string): ReceiptRow | undefined {
    return db.prepare(`SELECT * FROM agency_launch_receipt WHERE attempt_id = ?`).get(attemptId) as
      | ReceiptRow
      | undefined;
  }

  function loadReceipt(ctx: ServiceContext, row: ReceiptRow | undefined, missing: string): DomainResult<LaunchReceipt> {
    if (!row) return fail("not_found", missing);
    const readable = assertReadableJob(ctx, row.job_id);
    if (!readable.ok) return readable;
    return ok(mapReceipt(row));
  }

  function assertReadableJob(ctx: ServiceContext, jobId: string): DomainResult<true> {
    const job = repos.job.get(jobId);
    if (!job) return fail("not_found", `job ${jobId} not found`);
    const binding = repos.binding.get(job.bindingId);
    if (!binding) return fail("not_found", `binding ${job.bindingId} not found`);
    const access = assertBindingAccess(ctx, binding.id);
    if (!access.ok) return access;
    return ok(true);
  }

  return {
    writes: {
      reservePreparedRun,
      transitionAttempt,
      recordLaunchReceipt,
    },
    reads: {
      getLaunchReceipt: (ctx, launchId) => loadReceipt(ctx, getReceiptRow(launchId), `launch receipt ${launchId} not found`),
      getLaunchReceiptByAttempt: (ctx, attemptId) =>
        loadReceipt(ctx, getReceiptRowByAttempt(attemptId), `launch receipt for attempt ${attemptId} not found`),
      getSnapshot: (ctx, snapshotId) => {
        const loaded = loadSnapshot(snapshotId);
        if (!loaded.ok) return loaded;
        const readable = assertReadableJob(ctx, loaded.value.jobId);
        if (!readable.ok) return readable;
        return loaded;
      },
      getAttempt: (ctx, attemptId) => {
        const row = getAttemptRow(attemptId);
        if (!row) return fail("not_found", `attempt ${attemptId} not found`);
        const readable = assertReadableJob(ctx, row.job_id);
        if (!readable.ok) return readable;
        return ok(mapAttempt(row));
      },
      listAttempts: (ctx, jobId) => {
        const readable = assertReadableJob(ctx, jobId);
        if (!readable.ok) return readable;
        return ok(listAttemptRows(jobId).map(mapAttempt));
      },
    },
  };
}
