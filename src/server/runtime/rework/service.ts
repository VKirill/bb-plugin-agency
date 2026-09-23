import { failedLaunchCount } from "../recovery/permit";
import { randomUUID } from "node:crypto";
import { ensureLaunchIssue, resolveLaunchIssue } from "../launch-queue/issues";
import { enqueueParentWake } from "../parent-wake";
import { recordTrace } from "../trace/store";
import { assertRecoveryAuthority, recoveryText } from "../recovery/authorization";
import { recoveryDecisionSchema, type RecoveryDecision } from "../../../shared/rpc-contract";
import { reworkRoundCount } from "./lineage.js";
import { agencyLanguage, type AgencyLanguage } from "../../i18n/language.js";
import { fail, ok, type DomainResult } from "../../../domain";
import type { Job } from "../../../shared/contracts";
import type { SqlDatabase } from "../../db/sql";
import type { IsolatedSendOutcome, IsolatedSendPort } from "../isolated-sdk/send-port.js";
import type { InternalRunStoreReads, RunStore } from "../run-store/types.js";
import type { ServiceContext } from "../../services/context.js";
import type { DomainStore } from "../../services/domain-store.js";
import { uuidV5 } from "../launch/operation-ids.js";
import { loopEffect } from "../loop-break/mark.js";
import { latestLoopMark, rootJobId } from "../loop-break/store.js";

/**
 * Returning a result for rework continues the same worker thread: the worker
 * keeps its context and gets the remarks as a message. The job goes back to
 * running and does not re-enter review until a new version (a different hash)
 * is published; the returned version is remembered here.
 *
 * Reclamation: the customer may return a root job that the line has already
 * delivered (done). It reopens done → review → running in one transaction and
 * reworks in the same thread. Stations inside the line are not reclaimed one
 * by one: the customer returns the product, the lead decides which station redoes it.
 */

export const REWORK_MIGRATION = `CREATE TABLE agency_rework (
    request_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    returned_hash TEXT NOT NULL,
    comment TEXT NOT NULL,
    send_state TEXT NOT NULL,
    resolved_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

export type ReturnForReworkInput = {
  requestId: string;
  jobId: string;
  expectedRevision: number;
  comment: string;
  recoveryDecision?: RecoveryDecision;
};

export type ReworkDeps = {
  db: SqlDatabase;
  store: Pick<DomainStore, "getJob" | "transitionJob" | "createActivity">;
  runs: Pick<RunStore, "transitionAttempt">;
  reads: Pick<InternalRunStoreReads, "getAttempt">;
  send: IsolatedSendPort;
  /** Hash of the current published version, verified against the file. */
  currentPublishedHash: (jobId: string) => Promise<string | null>;
  /** Owner returns allowed per job; unlimited when omitted. */
  reworkLimit?: (job: Job) => number;
};

type ReworkRow = {
  request_id: string;
  job_id: string;
  attempt_id: string;
  thread_id: string;
  returned_hash: string;
  comment: string;
  send_state: string;
};

export function reworkToken(requestId: string): string {
  return `agency.rework:${requestId}`;
}

export function reworkText(jobKey: string, comment: string, returnedHash: string, requestId: string, lang: AgencyLanguage = agencyLanguage()): string {
  if (lang === "en") {
    return [
      `Agency: returned ${jobKey} for rework.`,
      "",
      "Remarks:",
      comment.trim(),
      "",
      `Fix the result, update the report .agency/jobs/${jobKey}/report.md, publish a new version (bb agency artifact publish), submit the exact version with bb agency job submit (fresh job expectedRevision, artifactId, version, hash, comment) and end the turn. The previous version ${returnedHash.slice(0, 8)} will not go to review again. If you disagree with a remark, answer with a comment and report-needs-input.`,
      reworkToken(requestId),
    ].join("\n");
  }
  return [
    `Агентство: задача ${jobKey} возвращена на доработку.`,
    "",
    "Замечания:",
    comment.trim(),
    "",
    `Исправьте результат, обновите отчёт .agency/jobs/${jobKey}/report.md, опубликуйте новую версию (bb agency artifact publish), сдайте точную версию через bb agency job submit (свежая expectedRevision задачи, artifactId, version, hash, comment) и завершите ход. Прежняя версия ${returnedHash.slice(0, 8)} на проверку больше не пойдёт. Не согласны с замечанием — ответьте комментарием и report-needs-input.`,
    reworkToken(requestId),
  ].join("\n");
}

function readRow(db: SqlDatabase, requestId: string): ReworkRow | undefined {
  return db.prepare(`SELECT * FROM agency_rework WHERE request_id = ?`).get(requestId) as ReworkRow | undefined;
}

function setSendState(db: SqlDatabase, requestId: string, state: string, now: string): void {
  db.prepare(`UPDATE agency_rework SET send_state = ?, updated_at = ?,
    confirmed_at = CASE WHEN ? = 'confirmed' THEN COALESCE(confirmed_at, ?) ELSE confirmed_at END
    WHERE request_id = ?`).run(state, now, state, now, requestId);
}

/**
 * Only the latest attempt may receive a returned version. Explicit hand-in can put the job
 * in review before reconciliation changes its attempt from running to awaiting_review.
 * Sending remarks to that same thread is safe and does not fabricate a completed attempt.
 * A delivered job may have its attempt marked succeeded; reclamation reopens it.
 */
function reviewedAttempt(db: SqlDatabase, jobId: string, delivered: boolean): { id: string; thread_id: string; launch_id: string } | undefined {
  const states = delivered ? ["awaiting_review", "succeeded"] : ["awaiting_review", "running"];
  const latest = db
    .prepare(
      `SELECT id, thread_id, launch_id, state FROM agency_run_attempt
       WHERE job_id = ?
       ORDER BY attempt_no DESC LIMIT 1`,
    )
    .get(jobId) as { id: string; thread_id: string | null; launch_id: string | null; state: string } | undefined;
  return latest?.thread_id && latest.launch_id && states.includes(latest.state)
    ? { id: latest.id, thread_id: latest.thread_id, launch_id: latest.launch_id } : undefined;
}

function applyReturn(deps: ReworkDeps, ctx: ServiceContext, row: ReworkRow, expectedRevision: number): DomainResult<Job> {
  return deps.db.transaction(() => {
    const job = deps.store.getJob(row.job_id);
    if (!job) return fail("not_found", `job ${row.job_id} not found`);
    if (job.state === "running") return ok(job);
    let revision = expectedRevision;
    if (job.state === "done") {
      // Reclamation: the delivered product goes back on the line before it goes back to work.
      const reopened = deps.store.transitionJob(ctx, {
        requestId: uuidV5(row.request_id, "agency.rework.reopen"),
        jobId: row.job_id,
        expectedRevision,
        to: "review",
      });
      if (!reopened.ok) return reopened;
      revision = reopened.value.revision;
    }
    const moved = deps.store.transitionJob(ctx, {
      requestId: uuidV5(row.request_id, "agency.rework.job"),
      jobId: row.job_id,
      expectedRevision: revision,
      to: "running",
      reworkComment: row.comment,
    });
    if (!moved.ok) return moved;
    const attempt = deps.reads.getAttempt(ctx, row.attempt_id);
    if (!attempt.ok) return attempt;
    if (attempt.value.state === "awaiting_review" || attempt.value.state === "succeeded") {
      const reopened = deps.runs.transitionAttempt(ctx, {
        requestId: uuidV5(row.request_id, "agency.rework.attempt"),
        attemptId: row.attempt_id,
        expectedRevision: attempt.value.revision,
        to: "running",
      });
      if (!reopened.ok) return reopened;
    }
    const commented = deps.store.createActivity(ctx, {
      requestId: uuidV5(row.request_id, "agency.rework.comment"),
      jobId: row.job_id,
      actor: ctx.actor.kind === "user" ? { kind: "user", userId: ctx.actor.userId } : { kind: "system" },
      kind: "comment",
      causationId: null,
      references: [],
      comment: `${job.state === "done" && !job.parentJobId ? "Рекламация: заказчик вернул выданный продукт" : "Возврат на доработку"}:\n\n${row.comment}`,
    });
    if (!commented.ok) return commented;
    // Rework invalidates the previous hand-in even when timestamps share a millisecond.
    deps.db.prepare("DELETE FROM agency_result_submission WHERE attempt_id = ?").run(row.attempt_id);
    setSendState(deps.db, row.request_id, "confirmed", new Date().toISOString());
    resolveLaunchIssue(deps.db, job.id);
    recordTrace(deps.db, { jobId: job.id, step: "rework.return", outcome: "succeeded", reason: row.comment.startsWith("Recovery decision") ? "lead_recovery" : "ordinary_return", requestId: row.request_id, attemptId: row.attempt_id, threadId: row.thread_id, artifactHash: row.returned_hash });
    return ok(moved.value);
  })();
}

function reportRecoveryBlock(deps: ReworkDeps, ctx: ServiceContext, job: Job, code: string): void {
  const now = new Date().toISOString();
  const activity = ensureLaunchIssue(deps.db, job, code, now, comment => deps.store.createActivity(ctx, {
    requestId: randomUUID(), jobId: job.id, actor: { kind: "system" }, kind: "comment", causationId: null,
    references: [{ type: "launch_issue", id: code }, { type: "job_state", id: job.state }], comment,
  }), agencyLanguage() === "en");
  if (activity) enqueueParentWake(deps.db, job, activity, now);
}

export async function returnJobForRework(deps: ReworkDeps, ctx: ServiceContext, input: ReturnForReworkInput): Promise<DomainResult<Job>> {
  if (input.recoveryDecision && !recoveryDecisionSchema.safeParse(input.recoveryDecision).success)
    return fail("invalid_command", "Recovery requires a cause, correction and verified evidence.");
  const target = deps.store.getJob(input.jobId);
  if (!target) return fail("not_found", `job ${input.jobId} not found`);
  if (input.recoveryDecision) {
    const authority = assertRecoveryAuthority(deps.db, ctx, target);
    if (!authority.ok) return authority;
  }
  const comment = input.recoveryDecision
    ? `${recoveryText(input.recoveryDecision)}\nDecision by: ${ctx.caller?.agentId ?? (ctx.actor.kind === "agent" ? ctx.actor.agentId : ctx.actor.kind)}\n\n${input.comment.trim()}`
    : input.comment.trim();
  if (!comment) return fail("invalid_command", "rework comment is required");
  const existing = readRow(deps.db, input.requestId);
  if (existing && (existing.job_id !== input.jobId || existing.comment !== comment))
    return fail("request_conflict", "Rework request identity changed.");
  if (existing?.send_state === "confirmed") {
    const job = deps.store.getJob(existing.job_id);
    return job ? ok(job) : fail("not_found", `job ${existing.job_id} not found`);
  }
  const job = deps.store.getJob(input.jobId);
  if (!job) return fail("not_found", `job ${input.jobId} not found`);
  const root = rootJobId(deps.db, job.parentJobId ?? job.id);
  if (!input.recoveryDecision && loopEffect(latestLoopMark(deps.db, root, job.reworkOfJobId ?? job.id)) === "block") {
    reportRecoveryBlock(deps, ctx, job, "loop_blocked");
    return fail("loop_blocked", "loop mark blocks another pass; the responsible lead must repair the cause and use job recover with verified evidence");
  }
  const delivered = job.state === "done";
  const rootJob = deps.store.getJob(root);
  const internalReview = delivered && Boolean(job.parentJobId) && rootJob && !["done", "canceled"].includes(rootJob.state)
    && Boolean(deps.db.prepare("SELECT 1 FROM agency_membership WHERE department_id = ? AND agent_id = ? AND role = 'reviewer'")
      .get(job.departmentId, job.assignedAgentId));
  if (internalReview) {
    const authority = assertRecoveryAuthority(deps.db, ctx, job);
    if (!authority.ok) return authority;
    if (ctx.caller && rootJobId(deps.db, ctx.caller.jobId) !== root)
      return fail("recovery_lead_only", "Only the lead responsible for this open product may return its internal review");
  } else if (delivered) {
    if (ctx.caller) return fail("reclamation_owner_only", `${job.key} is delivered; only the customer returns a delivered product`);
    if (job.parentJobId) {
      return fail(
        "reclamation_root_only",
        `${job.key} is a closed station inside a product; return the root job and say what is wrong — the lead decides which station redoes it`,
      );
    }
  } else if (job.state !== "review") {
    return fail("illegal_transition", `rework needs a job in review or a delivered root job, not ${job.state}`);
  }
  if (job.revision !== input.expectedRevision) {
    return fail("revision_conflict", "expectedRevision does not match the live job revision");
  }

  let row = existing;
  // The department limit bounds rounds inside the line; a reclamation is the customer's call.
  if (!row && deps.reworkLimit && (!delivered || internalReview)) {
    const limit = Math.min(2, deps.reworkLimit(job));
    const done = reworkRoundCount(deps.db, job.reworkOfJobId ?? job.id) + failedLaunchCount(deps.db, job.id);
    if (done >= limit && !input.recoveryDecision) {
      reportRecoveryBlock(deps, ctx, job, "rework_limit_reached");
      return fail(
        "rework_limit_reached",
        `the job was returned ${done} time(s), automatic continuation limit ${limit} (three failed passes maximum, or a stricter department setting). The responsible department lead must diagnose the failures, fix the cause and authorize one recovery with cause, correction and verification. Do not launch another unchanged pass.`,
      );
    }
  }
  if (!row) {
    const attempt = reviewedAttempt(deps.db, job.id, delivered);
    if (!attempt) return fail("rework_no_thread", "latest attempt has no resumable thread; reconcile it or recover a stopped job instead");
    const hash = await deps.currentPublishedHash(job.id);
    if (!hash) return fail("rework_no_version", "the job has no verified published version to return");
    const now = new Date().toISOString();
    deps.db
      .prepare(
        `INSERT INTO agency_rework (request_id, job_id, attempt_id, thread_id, returned_hash, comment, send_state, resolved_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
      )
      .run(input.requestId, job.id, attempt.id, attempt.thread_id, hash, comment, now, now);
    row = readRow(deps.db, input.requestId)!;
  }

  let outcome: IsolatedSendOutcome | { kind: "recovered" };
  if (row.send_state === "pending") {
    try {
      outcome = await deps.send.send({ threadId: row.thread_id, text: reworkText(job.key, row.comment, row.returned_hash, row.request_id, "en") });
    } catch {
      outcome = { kind: "unknown", code: "send_transport", message: "send failed" };
    }
  } else {
    const presence = await deps.send.recoverContinuation(row.thread_id, reworkToken(row.request_id), null);
    outcome = presence === "present" || presence === "queued" ? { kind: "recovered" } : { kind: "unknown", code: "send_unconfirmed", message: "rework message not found in the thread" };
  }
  const now = new Date().toISOString();
  if (outcome.kind === "rejected") {
    setSendState(deps.db, row.request_id, "rejected", now);
    return fail("rework_send_rejected", outcome.message);
  }
  if (outcome.kind === "unknown") {
    setSendState(deps.db, row.request_id, "unknown", now);
    return fail("rework_send_unknown", "the remarks may not have reached the worker; retry with the same request");
  }
  return applyReturn(deps, ctx, row, input.expectedRevision);
}

/** A version returned for rework must not put the job back in review. */
export function reworkBlocksReview(db: SqlDatabase, jobId: string, publishedHash: string | null): boolean {
  if (!publishedHash) return false;
  const row = db
    .prepare(
      `SELECT 1 FROM agency_rework WHERE job_id = ? AND send_state = 'confirmed' AND resolved_at IS NULL AND returned_hash = ? LIMIT 1`,
    )
    .get(jobId, publishedHash);
  return Boolean(row);
}

export function resolveRework(db: SqlDatabase, jobId: string, now: string): void {
  db.prepare(`UPDATE agency_rework SET resolved_at = ?, updated_at = ? WHERE job_id = ? AND resolved_at IS NULL`).run(now, now, jobId);
}
