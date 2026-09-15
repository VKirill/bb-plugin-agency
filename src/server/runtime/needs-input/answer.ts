import { fail, ok, type DomainResult } from "../../../domain";
import { canonicalizeJson, sha256Hex } from "../context-snapshot/canonical.js";
import {
  answerNeedsInputCommandSchema,
  type AnswerNeedsInputCommand,
  type AnswerNeedsInputRecord,
  type ContinuationAmendment,
  type NeedsInputAnswer,
  type NeedsInputQuestion,
} from "../../../shared/contracts";
import { createRepositories } from "../../db/repositories.js";
import type { SqlDatabase } from "../../db/sql";
import { parseJson, toJson } from "../../db/sql";
import { assertBindingAccess, nowUtc, type ServiceContext } from "../../services/context.js";
import type { DomainStore } from "../../services";
import { payloadWithoutRequestId, sameActor, sameCanonical } from "../../services/request-identity.js";
import { uuidV5 } from "../launch/operation-ids.js";
import type { IsolatedSendOutcome, IsolatedSendPort } from "../isolated-sdk/send-port.js";
import { readOpenWait } from "./report.js";
import type { InternalRunStoreReads, RunStore } from "../run-store/types.js";

export type AnswerNeedsInputDeps = {
  db: SqlDatabase;
  store: DomainStore;
  runs: Pick<RunStore, "transitionAttempt">;
  reads: Pick<InternalRunStoreReads, "getAttempt" | "getLaunchReceipt" | "getSnapshot">;
  send: IsolatedSendPort;
};

type AnswerSendState = AnswerNeedsInputRecord["sendState"];

type AnswerRow = {
  request_id: string;
  wait_id: string;
  job_id: string;
  attempt_id: string;
  launch_id: string;
  thread_id: string;
  answers_json: string;
  body_hash: string;
  expected_process_version_id: string;
  expected_snapshot_digest: string;
  send_state: AnswerSendState;
  send_code: string | null;
  send_message: string | null;
  dispatch_claimed: number;
  pinned_job_revision: number;
  pinned_attempt_revision: number;
  queued_message_id: string | null;
  created_at: string;
  updated_at: string;
};

type AmendmentRow = {
  request_id: string;
  wait_id: string;
  job_id: string;
  attempt_id: string;
  process_version_id: string;
  snapshot_process_version_id: string;
  snapshot_digest: string;
  process_instructions: string;
  process_acceptance: string;
  process_instructions_hash: string;
  process_acceptance_hash: string;
  job_brief: string;
  job_acceptance: string;
  job_brief_hash: string;
  job_acceptance_hash: string;
  created_at: string;
};

type NeedsInputRow = {
  wait_id: string;
  job_id: string;
  attempt_id: string;
  launch_id: string;
  thread_id: string;
  questions_json: string;
};

export function answersBodyHash(answers: readonly NeedsInputAnswer[]): string {
  return sha256Hex(canonicalizeJson(answers));
}

export function answerCommandBodyHash(input: Pick<
  AnswerNeedsInputCommand,
  | "answers"
  | "expectedProcessVersionId"
  | "expectedSnapshotDigest"
  | "expectedProcessInstructionsHash"
  | "expectedProcessAcceptanceHash"
  | "expectedJobBriefHash"
  | "expectedJobAcceptanceHash"
>): string {
  return sha256Hex(
    canonicalizeJson({
      answers: input.answers,
      expectedProcessVersionId: input.expectedProcessVersionId,
      expectedSnapshotDigest: input.expectedSnapshotDigest,
      expectedProcessInstructionsHash: input.expectedProcessInstructionsHash,
      expectedProcessAcceptanceHash: input.expectedProcessAcceptanceHash,
      expectedJobBriefHash: input.expectedJobBriefHash,
      expectedJobAcceptanceHash: input.expectedJobAcceptanceHash,
    }),
  );
}

export function continuationToken(requestId: string): string {
  return `agency.answerNeedsInput:${requestId}`;
}

export function formatContinuationText(
  questions: readonly NeedsInputQuestion[],
  answers: readonly NeedsInputAnswer[],
  amendment: AmendmentRow,
  requestId: string,
): string {
  const byId = new Map(answers.map((item) => [item.questionId, item.text]));
  const lines = questions.map((question, index) => {
    const text = byId.get(question.id) ?? "";
    return `${index + 1}. ${question.text}\nОтвет: ${text}`;
  });
  const processChanged = amendment.process_version_id !== amendment.snapshot_process_version_id;
  return [
    "Продолжение той же работы. Вопросы закрыты владельцем.",
    "",
    lines.join("\n\n"),
    "",
    processChanged
      ? `Поправка процесса (текущая ProcessVersion ${amendment.process_version_id}; снимок запуска был ${amendment.snapshot_process_version_id}):`
      : `Текущий процесс (ProcessVersion ${amendment.process_version_id}, совпадает со снимком запуска):`,
    `Инструкции:\n${amendment.process_instructions}`,
    `Acceptance:\n${amendment.process_acceptance}`,
    `Job.brief:\n${amendment.job_brief}`,
    `Job.acceptance:\n${amendment.job_acceptance}`,
    `snapshotDigest=${amendment.snapshot_digest}`,
    continuationToken(requestId),
  ].join("\n\n");
}

function isConfirmedAnswerRemember(result: unknown): result is DomainResult<AnswerNeedsInputRecord> {
  if (!result || typeof result !== "object") return false;
  const remembered = result as DomainResult<AnswerNeedsInputRecord>;
  return remembered.ok === true && remembered.value.sendState === "confirmed";
}

function rememberIdentityMatches(
  existing: { kind: string; payload: unknown; actor: unknown; scopeBindingIds: readonly string[] },
  ctx: ServiceContext,
  payload: unknown,
  scopeBindingIds: readonly string[],
): boolean {
  return (
    existing.kind === "answerNeedsInput" &&
    sameCanonical(existing.payload, payload) &&
    sameActor(existing.actor, ctx.actor) &&
    sameCanonical(existing.scopeBindingIds, scopeBindingIds)
  );
}

function rememberTerminal<T>(
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
    if (!rememberIdentityMatches(existing, ctx, payload, identity.scopeBindingIds)) {
      return fail("request_conflict", `request ${identity.requestId} already used with a different answerNeedsInput payload`);
    }
    if (isConfirmedAnswerRemember(existing.result)) {
      return existing.result as DomainResult<T>;
    }
  }
  const result = run();
  if (result.ok && (result.value as AnswerNeedsInputRecord).sendState === "confirmed") {
    if (existing) {
      repos.request.updateResult(identity.requestId, "answerNeedsInput", result);
    } else {
      repos.request.insert(
        identity.requestId,
        "answerNeedsInput",
        result,
        payload,
        ctx.actor,
        identity.scopeBindingIds,
        nowUtc(ctx),
      );
    }
  }
  return result;
}

function readAnswerRow(db: SqlDatabase, requestId: string): AnswerRow | undefined {
  return db.prepare(`SELECT * FROM agency_job_needs_input_answer WHERE request_id = ?`).get(requestId) as
    | AnswerRow
    | undefined;
}

function readAmendmentRow(db: SqlDatabase, requestId: string): AmendmentRow | undefined {
  return db.prepare(`SELECT * FROM agency_job_needs_input_amendment WHERE request_id = ?`).get(requestId) as
    | AmendmentRow
    | undefined;
}

function upsertAnswerRow(db: SqlDatabase, row: AnswerRow): void {
  db.prepare(
    `INSERT INTO agency_job_needs_input_answer (
      request_id, wait_id, job_id, attempt_id, launch_id, thread_id, answers_json, body_hash,
      expected_process_version_id, expected_snapshot_digest, send_state, send_code, send_message,
      dispatch_claimed, pinned_job_revision, pinned_attempt_revision, queued_message_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(request_id) DO UPDATE SET
      send_state = excluded.send_state,
      send_code = excluded.send_code,
      send_message = excluded.send_message,
      dispatch_claimed = excluded.dispatch_claimed,
      queued_message_id = excluded.queued_message_id,
      updated_at = excluded.updated_at`,
  ).run(
    row.request_id,
    row.wait_id,
    row.job_id,
    row.attempt_id,
    row.launch_id,
    row.thread_id,
    row.answers_json,
    row.body_hash,
    row.expected_process_version_id,
    row.expected_snapshot_digest,
    row.send_state,
    row.send_code,
    row.send_message,
    row.dispatch_claimed,
    row.pinned_job_revision,
    row.pinned_attempt_revision,
    row.queued_message_id,
    row.created_at,
    row.updated_at,
  );
}

function readAnswerByWait(db: SqlDatabase, waitId: string): AnswerRow | undefined {
  return db.prepare(`SELECT * FROM agency_job_needs_input_answer WHERE wait_id = ?`).get(waitId) as AnswerRow | undefined;
}

function closeWait(db: SqlDatabase, waitId: string, at: string): void {
  db.prepare(
    `UPDATE agency_job_needs_input_wait SET closed_at = ?, updated_at = ?
     WHERE wait_id = ? AND closed_at IS NULL`,
  ).run(at, at, waitId);
}

function claimDispatch(db: SqlDatabase, requestId: string): boolean {
  const result = db
    .prepare(
      `UPDATE agency_job_needs_input_answer SET dispatch_claimed = 1, updated_at = updated_at
       WHERE request_id = ? AND dispatch_claimed = 0`,
    )
    .run(requestId);
  return result.changes === 1;
}

function insertAmendment(db: SqlDatabase, row: AmendmentRow): void {
  db.prepare(
    `INSERT OR IGNORE INTO agency_job_needs_input_amendment (
      request_id, wait_id, job_id, attempt_id, process_version_id, snapshot_process_version_id, snapshot_digest,
      process_instructions, process_acceptance, process_instructions_hash, process_acceptance_hash,
      job_brief, job_acceptance, job_brief_hash, job_acceptance_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.request_id,
    row.wait_id,
    row.job_id,
    row.attempt_id,
    row.process_version_id,
    row.snapshot_process_version_id,
    row.snapshot_digest,
    row.process_instructions,
    row.process_acceptance,
    row.process_instructions_hash,
    row.process_acceptance_hash,
    row.job_brief,
    row.job_acceptance,
    row.job_brief_hash,
    row.job_acceptance_hash,
    row.created_at,
  );
}

function publicAmendment(row: AmendmentRow): ContinuationAmendment {
  return {
    processVersionId: row.process_version_id,
    snapshotProcessVersionId: row.snapshot_process_version_id,
    processInstructionsHash: row.process_instructions_hash,
    processAcceptanceHash: row.process_acceptance_hash,
    jobBriefHash: row.job_brief_hash,
    jobAcceptanceHash: row.job_acceptance_hash,
    snapshotDigest: row.snapshot_digest,
  };
}

function recordFromRow(
  row: AnswerRow,
  amendment: AmendmentRow,
  jobState: "waiting_input" | "running",
  attemptState: "waiting_input" | "running",
  jobRevision: number,
  attemptRevision: number,
): AnswerNeedsInputRecord {
  return {
    waitId: row.wait_id,
    jobId: row.job_id,
    attemptId: row.attempt_id,
    launchId: row.launch_id,
    threadId: row.thread_id,
    requestId: row.request_id,
    answers: parseJson(row.answers_json) as NeedsInputAnswer[],
    bodyHash: row.body_hash,
    jobState,
    attemptState,
    jobRevision,
    attemptRevision,
    sendState: row.send_state,
    turnActive: row.send_state === "confirmed",
    amendment: publicAmendment(amendment),
  };
}

function waitingRecord(
  deps: AnswerNeedsInputDeps,
  ctx: ServiceContext,
  input: AnswerNeedsInputCommand,
  row: AnswerRow,
  amendment: AmendmentRow,
): DomainResult<AnswerNeedsInputRecord> {
  const job = deps.store.getJob(input.jobId);
  const attempt = deps.reads.getAttempt(ctx, input.attemptId);
  return ok(
    recordFromRow(
      row,
      amendment,
      "waiting_input",
      "waiting_input",
      job?.revision ?? input.expectedRevision,
      attempt.ok ? attempt.value.revision : input.expectedAttemptRevision,
    ),
  );
}

function assertAnswerCoverage(
  questions: readonly NeedsInputQuestion[],
  answers: readonly NeedsInputAnswer[],
): DomainResult<true> {
  const expected = new Set(questions.map((item) => item.id));
  const seen = new Set<string>();
  for (const answer of answers) {
    if (!expected.has(answer.questionId)) {
      return fail("invalid_command", `answer ${answer.questionId} is not an open question`);
    }
    if (seen.has(answer.questionId)) {
      return fail("invalid_command", `duplicate answer for ${answer.questionId}`);
    }
    seen.add(answer.questionId);
  }
  for (const id of expected) {
    if (!seen.has(id)) return fail("invalid_command", `missing answer for ${id}`);
  }
  return ok(true);
}

function applyResume(
  deps: AnswerNeedsInputDeps,
  ctx: ServiceContext,
  input: AnswerNeedsInputCommand,
  row: AnswerRow,
  amendment: AmendmentRow,
): DomainResult<AnswerNeedsInputRecord> {
  const job = deps.store.getJob(input.jobId);
  if (!job) return fail("not_found", `job ${input.jobId} not found`);
  const attempt = deps.reads.getAttempt(ctx, input.attemptId);
  if (!attempt.ok) return attempt;
  const pinnedJob = input.expectedRevision;
  const pinnedAttempt = input.expectedAttemptRevision;
  if (job.revision !== pinnedJob || attempt.value.revision !== pinnedAttempt) {
    const next: AnswerRow = {
      ...row,
      send_state: "needs_reconciliation",
      send_code: "resume_revision_conflict",
      send_message: `pinned job ${pinnedJob}/attempt ${pinnedAttempt} != live ${job.revision}/${attempt.value.revision}`,
      dispatch_claimed: 1,
      updated_at: nowUtc(ctx),
    };
    upsertAnswerRow(deps.db, next);
    return waitingRecord(deps, ctx, input, next, amendment);
  }
  const facts = deps.store.setJobExecutionFacts(ctx, {
    requestId: uuidV5(input.requestId, "agency.answerNeedsInput.facts"),
    jobId: input.jobId,
    openQuestions: false,
    confirmedContinuation: true,
  });
  if (!facts.ok) return facts;
  let jobRevision = job.revision;
  if (job.state === "waiting_input") {
    const nextJob = deps.store.transitionJob(ctx, {
      requestId: uuidV5(input.requestId, "agency.answerNeedsInput.job"),
      jobId: input.jobId,
      expectedRevision: pinnedJob,
      to: "running",
    });
    if (!nextJob.ok) {
      const next: AnswerRow = {
        ...row,
        send_state: "needs_reconciliation",
        send_code: nextJob.error.code,
        send_message: nextJob.error.message,
        dispatch_claimed: 1,
        updated_at: nowUtc(ctx),
      };
      upsertAnswerRow(deps.db, next);
      return waitingRecord(deps, ctx, input, next, amendment);
    }
    jobRevision = nextJob.value.revision;
  }
  let attemptRevision = attempt.value.revision;
  if (attempt.value.state === "waiting_input") {
    const nextAttempt = deps.runs.transitionAttempt(ctx, {
      requestId: uuidV5(input.requestId, "agency.answerNeedsInput.attempt"),
      attemptId: input.attemptId,
      expectedRevision: pinnedAttempt,
      to: "running",
      threadId: input.threadId,
      launchId: input.launchId,
    });
    if (!nextAttempt.ok) {
      const next: AnswerRow = {
        ...row,
        send_state: "needs_reconciliation",
        send_code: nextAttempt.error.code,
        send_message: nextAttempt.error.message,
        dispatch_claimed: 1,
        updated_at: nowUtc(ctx),
      };
      upsertAnswerRow(deps.db, next);
      return waitingRecord(deps, ctx, input, next, amendment);
    }
    attemptRevision = nextAttempt.value.revision;
  }
  const next: AnswerRow = {
    ...row,
    send_state: "confirmed",
    send_code: null,
    send_message: null,
    dispatch_claimed: 1,
    updated_at: nowUtc(ctx),
  };
  upsertAnswerRow(deps.db, next);
  closeWait(deps.db, row.wait_id, next.updated_at);
  return ok(recordFromRow(next, amendment, "running", "running", jobRevision, attemptRevision));
}

function validateIntent(
  deps: AnswerNeedsInputDeps,
  ctx: ServiceContext,
  input: AnswerNeedsInputCommand,
): DomainResult<{
  questions: NeedsInputQuestion[];
  row: AnswerRow;
  amendment: AmendmentRow;
  scopeBindingIds: readonly string[];
}> {
  const scoped = deps.store.scopedJob(ctx, input.jobId);
  if (!scoped.ok) return scoped;
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
  const waiting = readOpenWait(deps.db, input.jobId) as NeedsInputRow | undefined;
  if (!waiting) return fail("not_found", `no open needsInput for job ${input.jobId}`);
  if (waiting.wait_id !== input.waitId) {
    return fail("request_conflict", `waitId ${input.waitId} is not the open wait ${waiting.wait_id}`);
  }
  if (
    live.jobId !== input.jobId ||
    rec.jobId !== input.jobId ||
    rec.attemptId !== input.attemptId ||
    live.launchId !== input.launchId ||
    rec.launchId !== input.launchId ||
    live.threadId !== input.threadId ||
    rec.threadId !== input.threadId ||
    waiting.attempt_id !== input.attemptId ||
    waiting.launch_id !== input.launchId ||
    waiting.thread_id !== input.threadId
  ) {
    return fail("unknown_identity", "job/attempt/thread/launch do not bind as one verified current run");
  }
  if (job.revision !== input.expectedRevision) {
    return fail("revision_conflict", `job revision ${job.revision} != ${input.expectedRevision}`);
  }
  if (live.revision !== input.expectedAttemptRevision) {
    return fail("revision_conflict", `attempt revision ${live.revision} != ${input.expectedAttemptRevision}`);
  }
  if (job.state !== "waiting_input" || live.state !== "waiting_input") {
    return fail(
      "illegal_transition",
      `answerNeedsInput requires waiting_input, got job ${job.state} attempt ${live.state}`,
    );
  }
  const department = deps.store.getDepartment(job.departmentId);
  if (!department) return fail("not_found", `department ${job.departmentId} not found`);
  if (department.processVersionId !== input.expectedProcessVersionId) {
    return fail(
      "versions_changed",
      `processVersionId ${department.processVersionId} != ${input.expectedProcessVersionId}`,
    );
  }
  const process = deps.store.getProcessVersion(department.processVersionId);
  if (!process) return fail("not_found", `process ${department.processVersionId} not found`);
  if (live.digest !== input.expectedSnapshotDigest) {
    return fail("snapshot_stale", `snapshot digest ${live.digest} != ${input.expectedSnapshotDigest}`);
  }
  const snapshot = deps.reads.getSnapshot(ctx, live.snapshotId);
  if (!snapshot.ok) return snapshot;
  const liveProcessInstructionsHash = sha256Hex(process.instructions);
  const liveProcessAcceptanceHash = sha256Hex(process.acceptance);
  const liveJobBriefHash = sha256Hex(job.brief);
  const liveJobAcceptanceHash = sha256Hex(job.acceptance);
  if (
    (input.expectedProcessInstructionsHash && liveProcessInstructionsHash !== input.expectedProcessInstructionsHash) ||
    (input.expectedProcessAcceptanceHash && liveProcessAcceptanceHash !== input.expectedProcessAcceptanceHash)
  ) {
    return fail(
      "versions_changed",
      `process content ${liveProcessInstructionsHash}/${liveProcessAcceptanceHash} != ${input.expectedProcessInstructionsHash}/${input.expectedProcessAcceptanceHash}`,
    );
  }
  if (
    (input.expectedJobBriefHash && liveJobBriefHash !== input.expectedJobBriefHash) ||
    (input.expectedJobAcceptanceHash && liveJobAcceptanceHash !== input.expectedJobAcceptanceHash)
  ) {
    return fail(
      "versions_changed",
      `job content ${liveJobBriefHash}/${liveJobAcceptanceHash} != ${input.expectedJobBriefHash}/${input.expectedJobAcceptanceHash}`,
    );
  }
  const questions = parseJson(waiting.questions_json) as NeedsInputQuestion[];
  const covered = assertAnswerCoverage(questions, input.answers);
  if (!covered.ok) return covered;
  const bodyHash = answerCommandBodyHash(input);
  const existingByRequest = readAnswerRow(deps.db, input.requestId);
  if (existingByRequest && existingByRequest.wait_id !== input.waitId) {
    return fail("request_conflict", "requestId is already bound to another wait");
  }
  const existingByWait = readAnswerByWait(deps.db, input.waitId);
  if (existingByWait && existingByWait.request_id !== input.requestId) {
    return fail("request_conflict", "this wait already has a dispatch claim from another requestId");
  }
  const existing = existingByRequest ?? existingByWait;
  if (existing && existing.body_hash !== bodyHash) {
    return fail("request_conflict", "answerNeedsInput already recorded with a different body");
  }
  const now = nowUtc(ctx);
  const row: AnswerRow = existing ?? {
    request_id: input.requestId,
    wait_id: input.waitId,
    job_id: input.jobId,
    attempt_id: input.attemptId,
    launch_id: input.launchId,
    thread_id: input.threadId,
    answers_json: toJson(input.answers),
    body_hash: bodyHash,
    expected_process_version_id: input.expectedProcessVersionId,
    expected_snapshot_digest: input.expectedSnapshotDigest,
    send_state: "pending",
    send_code: null,
    send_message: null,
    dispatch_claimed: 0,
    pinned_job_revision: input.expectedRevision,
    pinned_attempt_revision: input.expectedAttemptRevision,
    queued_message_id: null,
    created_at: now,
    updated_at: now,
  };
  if (!existing) upsertAnswerRow(deps.db, row);
  const amendment: AmendmentRow = readAmendmentRow(deps.db, input.requestId) ?? {
    request_id: input.requestId,
    wait_id: input.waitId,
    job_id: input.jobId,
    attempt_id: input.attemptId,
    process_version_id: process.id,
    snapshot_process_version_id: snapshot.value.snapshot.processVersion.id,
    snapshot_digest: live.digest,
    process_instructions: process.instructions,
    process_acceptance: process.acceptance,
    process_instructions_hash: liveProcessInstructionsHash,
    process_acceptance_hash: liveProcessAcceptanceHash,
    job_brief: job.brief,
    job_acceptance: job.acceptance,
    job_brief_hash: liveJobBriefHash,
    job_acceptance_hash: liveJobAcceptanceHash,
    created_at: now,
  };
  insertAmendment(deps.db, amendment);
  return ok({ questions, row, amendment, scopeBindingIds: [scoped.value.binding.id] });
}

export async function answerNeedsInput(
  deps: AnswerNeedsInputDeps,
  ctx: ServiceContext,
  raw: AnswerNeedsInputCommand,
): Promise<DomainResult<AnswerNeedsInputRecord>> {
  const parsed = answerNeedsInputCommandSchema.safeParse(raw);
  if (!parsed.success) return fail("invalid_command", parsed.error.message);
  const input = parsed.data;
  const scoped = deps.store.scopedJob(ctx, input.jobId);
  if (!scoped.ok) return scoped;
  const remembered = createRepositories(deps.db).request.get(input.requestId);
  if (remembered) {
    for (const bindingId of remembered.scopeBindingIds) {
      const access = assertBindingAccess(ctx, bindingId);
      if (!access.ok) return access;
    }
    if (
      !rememberIdentityMatches(remembered, ctx, payloadWithoutRequestId(input), [scoped.value.binding.id])
    ) {
      return fail("request_conflict", `request ${input.requestId} already used with a different answerNeedsInput payload`);
    }
    if (isConfirmedAnswerRemember(remembered.result)) {
      return remembered.result;
    }
  }

  const prepared = deps.db.transaction(() => validateIntent(deps, ctx, input)).immediate();
  if (!prepared.ok) return prepared;
  let { questions, row, amendment } = prepared.value;
  if (row.send_state === "confirmed") {
    return deps.db.transaction(() =>
      rememberTerminal(deps.db, ctx, {
        requestId: input.requestId,
        payload: input,
        scopeBindingIds: prepared.value.scopeBindingIds,
      }, () => applyResume(deps, ctx, input, row, amendment)),
    ).immediate();
  }
  if (row.send_state === "rejected") {
    return fail(row.send_code ?? "sdk_send_unsupported", row.send_message ?? "official send rejected");
  }

  const claimedNow =
    row.send_state === "queued"
      ? false
      : deps.db.transaction(() => claimDispatch(deps.db, input.requestId)).immediate();
  row = readAnswerRow(deps.db, input.requestId) ?? row;
  amendment = readAmendmentRow(deps.db, input.requestId) ?? amendment;

  let outcome: IsolatedSendOutcome | { kind: "recovered" } | { kind: "still_queued" } | { kind: "reconcile" };
  if (claimedNow) {
    outcome = await deps.send.send({
      threadId: input.threadId,
      text: formatContinuationText(questions, input.answers, amendment, input.requestId),
    });
  } else {
    const presence = await deps.send.recoverContinuation(
      input.threadId,
      continuationToken(input.requestId),
      row.queued_message_id,
    );
    outcome =
      presence === "present" ? { kind: "recovered" } : presence === "queued" ? { kind: "still_queued" } : { kind: "reconcile" };
  }

  return deps.db.transaction(() =>
    rememberTerminal(deps.db, ctx, {
      requestId: input.requestId,
      payload: input,
      scopeBindingIds: prepared.value.scopeBindingIds,
    }, () => {
      const now = nowUtc(ctx);
      if (outcome.kind === "recovered") {
        return applyResume(deps, ctx, input, { ...row, dispatch_claimed: 1 }, amendment);
      }
      if (outcome.kind === "still_queued") {
        const next: AnswerRow = {
          ...row,
          send_state: "queued",
          dispatch_claimed: 1,
          updated_at: now,
        };
        upsertAnswerRow(deps.db, next);
        return waitingRecord(deps, ctx, input, next, amendment);
      }
      if (outcome.kind === "reconcile") {
        const next: AnswerRow = {
          ...row,
          send_state: "needs_reconciliation",
          send_code: "send_needs_reconciliation",
          send_message: "dispatch already claimed; limited timeline absent is not a safe resend",
          dispatch_claimed: 1,
          updated_at: now,
        };
        upsertAnswerRow(deps.db, next);
        return waitingRecord(deps, ctx, input, next, amendment);
      }
      if (outcome.kind === "rejected") {
        const next: AnswerRow = {
          ...row,
          send_state: "rejected",
          send_code: outcome.code,
          send_message: outcome.message,
          dispatch_claimed: 1,
          updated_at: now,
        };
        upsertAnswerRow(deps.db, next);
        return fail(outcome.code, outcome.message);
      }
      if (outcome.kind === "unknown") {
        const next: AnswerRow = {
          ...row,
          send_state: "unknown",
          send_code: outcome.code,
          send_message: outcome.message,
          dispatch_claimed: 1,
          updated_at: now,
        };
        upsertAnswerRow(deps.db, next);
        return waitingRecord(deps, ctx, input, next, amendment);
      }
      if (outcome.delivery === "queued") {
        const next: AnswerRow = {
          ...row,
          send_state: "queued",
          send_code: null,
          send_message: null,
          dispatch_claimed: 1,
          queued_message_id: outcome.queuedMessageId ?? row.queued_message_id,
          updated_at: now,
        };
        upsertAnswerRow(deps.db, next);
        return waitingRecord(deps, ctx, input, next, amendment);
      }
      return applyResume(deps, ctx, input, { ...row, dispatch_claimed: 1 }, amendment);
    }),
  ).immediate();
}
