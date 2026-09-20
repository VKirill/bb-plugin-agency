import { fail, ok, type DomainResult } from "../../../domain";
import { canonicalizeJson, sha256Hex } from "../context-snapshot/canonical.js";
import {
  reportNeedsInputCommandSchema,
  type NeedsInputQuestion,
  type NeedsInputRecord,
  type ReportNeedsInputCommand,
} from "../../../shared/contracts";
import { createRepositories } from "../../db/repositories.js";
import type { SqlDatabase } from "../../db/sql";
import { parseJson, toJson } from "../../db/sql";
import { assertBindingAccess, nowUtc, type ServiceContext } from "../../services/context.js";
import type { DomainStore } from "../../services";
import { payloadWithoutRequestId, sameActor, sameCanonical } from "../../services/request-identity.js";
import { uuidV5 } from "../launch/operation-ids.js";
import { enqueueClientBounce } from "../client-bounce/index.js";
import type { InternalRunStoreReads, RunStore } from "../run-store/types.js";

export type ReportNeedsInputDeps = {
  db: SqlDatabase;
  store: DomainStore;
  runs: Pick<RunStore, "transitionAttempt">;
  reads: Pick<InternalRunStoreReads, "getAttempt" | "getLaunchReceipt">;
};

type NeedsInputRow = {
  wait_id: string;
  job_id: string;
  attempt_id: string;
  launch_id: string;
  thread_id: string;
  request_id: string;
  questions_json: string;
  body_hash: string;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
};

export function waitIdForReport(requestId: string): string {
  return uuidV5(requestId, "agency.needsInput.wait");
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (String((error as { code: unknown }).code) === "SQLITE_CONSTRAINT_UNIQUE" ||
      String((error as { code: unknown }).code) === "SQLITE_CONSTRAINT");
}

export function readOpenWait(db: SqlDatabase, jobId: string): NeedsInputRow | undefined {
  return db
    .prepare(`SELECT * FROM agency_job_needs_input_wait WHERE job_id = ? AND closed_at IS NULL`)
    .get(jobId) as NeedsInputRow | undefined;
}

function recordFromWait(
  row: NeedsInputRow,
  jobRevision: number,
  attemptRevision: number,
): NeedsInputRecord {
  return {
    waitId: row.wait_id,
    jobId: row.job_id,
    attemptId: row.attempt_id,
    launchId: row.launch_id,
    threadId: row.thread_id,
    requestId: row.request_id,
    questions: parseJson(row.questions_json) as NeedsInputQuestion[],
    bodyHash: row.body_hash,
    jobState: "waiting_input",
    attemptState: "waiting_input",
    jobRevision,
    attemptRevision,
  };
}

export function questionsBodyHash(questions: readonly NeedsInputQuestion[]): string {
  return sha256Hex(canonicalizeJson(questions));
}

export function readNeedsInputRecord(db: SqlDatabase, jobId: string): NeedsInputRecord | null {
  const row = readOpenWait(db, jobId);
  if (!row) return null;
  const job = createRepositories(db).job.get(jobId);
  const attempt = db
    .prepare(`SELECT state, revision FROM agency_run_attempt WHERE id = ?`)
    .get(row.attempt_id) as { state: string; revision: number } | undefined;
  if (!job || job.state !== "waiting_input" || !attempt || attempt.state !== "waiting_input") {
    return null;
  }
  return recordFromWait(row, job.revision, attempt.revision);
}

function rememberReport<T>(
  db: SqlDatabase,
  ctx: ServiceContext,
  identity: { requestId: string; payload: unknown; scopeBindingIds: readonly string[] },
  run: () => DomainResult<T>,
): DomainResult<T> {
  const repos = createRepositories(db);
  const payload = payloadWithoutRequestId(identity.payload);
  const existing = repos.request.get(identity.requestId);
  if (existing) {
    for (const bindingId of existing.scopeBindingIds) {
      const access = assertBindingAccess(ctx, bindingId);
      if (!access.ok) return access;
    }
    if (
      existing.kind !== "reportNeedsInput" ||
      !sameCanonical(existing.payload, payload) ||
      !sameActor(existing.actor, ctx.actor) ||
      !sameCanonical(existing.scopeBindingIds, identity.scopeBindingIds)
    ) {
      return fail("request_conflict", `request ${identity.requestId} already used with a different reportNeedsInput payload`);
    }
    return existing.result as DomainResult<T>;
  }
  const result = run();
  repos.request.insert(
    identity.requestId,
    "reportNeedsInput",
    result,
    payload,
    ctx.actor,
    identity.scopeBindingIds,
    nowUtc(ctx),
  );
  return result;
}

export function reportNeedsInput(
  deps: ReportNeedsInputDeps,
  ctx: ServiceContext,
  raw: ReportNeedsInputCommand,
): DomainResult<NeedsInputRecord> {
  const parsed = reportNeedsInputCommandSchema.safeParse(raw);
  if (!parsed.success) return fail("invalid_command", parsed.error.message);
  const input = parsed.data;
  const scoped = deps.store.scopedJob(ctx, input.jobId);
  if (!scoped.ok) return scoped;
  return deps.db.transaction(() => rememberReport(deps.db, ctx, {
    requestId: input.requestId,
    payload: input,
    scopeBindingIds: [scoped.value.binding.id],
  }, () => {
    const job = scoped.value.job;
    const attempt = deps.reads.getAttempt(ctx, input.attemptId);
    if (!attempt.ok) {
      return attempt.error.code === "not_found"
        ? fail("unknown_identity", `attempt ${input.attemptId} is not a verified current attempt`)
        : attempt;
    }
    const receipt = deps.reads.getLaunchReceipt(ctx, input.launchId);
    if (!receipt.ok) {
      return receipt.error.code === "not_found"
        ? fail("unknown_identity", `launch ${input.launchId} is not a verified current receipt`)
        : receipt;
    }
    const live = attempt.value;
    const rec = receipt.value;
    if (
      live.jobId !== input.jobId ||
      rec.jobId !== input.jobId ||
      rec.attemptId !== input.attemptId ||
      live.launchId !== input.launchId ||
      rec.launchId !== input.launchId ||
      live.threadId !== input.threadId ||
      rec.threadId !== input.threadId
    ) {
      return fail("unknown_identity", "job/attempt/thread/launch do not bind as one verified current run");
    }
    if (job.revision !== input.expectedRevision) {
      return fail("revision_conflict", `job revision ${job.revision} != ${input.expectedRevision}`);
    }
    if (live.revision !== input.expectedAttemptRevision) {
      return fail("revision_conflict", `attempt revision ${live.revision} != ${input.expectedAttemptRevision}`);
    }
    if (
      (job.state !== "running" && job.state !== "waiting_input") ||
      (live.state !== "running" && live.state !== "waiting_input")
    ) {
      return fail("illegal_transition", `reportNeedsInput requires running or waiting_input, got job ${job.state} attempt ${live.state}`);
    }
    const bodyHash = questionsBodyHash(input.questions);
    const existing = readOpenWait(deps.db, input.jobId);
    if (existing && existing.body_hash !== bodyHash) {
      return fail("request_conflict", "waiting_input questions already recorded with a different body");
    }
    const now = nowUtc(ctx);
    const waitId = existing?.wait_id ?? waitIdForReport(input.requestId);
    if (!existing) {
      try {
        deps.db
          .prepare(
            `INSERT INTO agency_job_needs_input_wait
              (wait_id, job_id, attempt_id, launch_id, thread_id, request_id, questions_json, body_hash, closed_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(
            waitId,
            input.jobId,
            input.attemptId,
            input.launchId,
            input.threadId,
            input.requestId,
            toJson(input.questions),
            bodyHash,
            now,
            now,
          );
      } catch (error) {
        if (isUniqueViolation(error)) {
          return fail("request_conflict", "another open wait already exists for this job");
        }
        throw error;
      }
    }
    const facts = deps.store.setJobExecutionFacts(ctx, {
      requestId: uuidV5(input.requestId, "agency.needsInput.facts"),
      jobId: input.jobId,
      openQuestions: true,
    });
    if (!facts.ok) return facts;
    let jobRevision = job.revision;
    if (job.state === "running") {
      const nextJob = deps.store.transitionJob(ctx, {
        requestId: uuidV5(input.requestId, "agency.needsInput.job"),
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        to: "waiting_input",
      });
      if (!nextJob.ok) return nextJob;
      jobRevision = nextJob.value.revision;
    }
    let attemptRevision = live.revision;
    if (live.state === "running") {
      const nextAttempt = deps.runs.transitionAttempt(ctx, {
        requestId: uuidV5(input.requestId, "agency.needsInput.attempt"),
        attemptId: input.attemptId,
        expectedRevision: input.expectedAttemptRevision,
        to: "waiting_input",
        threadId: input.threadId,
        launchId: input.launchId,
      });
      if (!nextAttempt.ok) return nextAttempt;
      attemptRevision = nextAttempt.value.revision;
    }
    const latest = deps.store.getJob(input.jobId) ?? job;
    enqueueClientBounce(deps.db, latest, waitId, now);
    return ok({
      waitId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      launchId: input.launchId,
      threadId: input.threadId,
      requestId: input.requestId,
      questions: input.questions,
      bodyHash,
      jobState: "waiting_input" as const,
      attemptState: "waiting_input" as const,
      jobRevision,
      attemptRevision,
    });
  })).immediate();
}
