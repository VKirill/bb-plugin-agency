import { agencyLanguage, type AgencyLanguage } from "../../i18n/language.js";
import { fail, ok, type DomainResult } from "../../../domain";
import type { Job } from "../../../shared/contracts";
import type { SqlDatabase } from "../../db/sql";
import type { IsolatedSendOutcome, IsolatedSendPort } from "../isolated-sdk/send-port.js";
import type { InternalRunStoreReads, RunStore } from "../run-store/types.js";
import type { ServiceContext } from "../../services/context.js";
import type { DomainStore } from "../../services/domain-store.js";
import { uuidV5 } from "../launch/operation-ids.js";

/**
 * Returning a result for rework continues the same worker thread: the worker
 * keeps its context and gets the remarks as a message. The job goes back to
 * running and does not re-enter review until a new version (a different hash)
 * is published; the returned version is remembered here.
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
      `Agency: the owner returned ${jobKey} for rework.`,
      "",
      "Remarks:",
      comment.trim(),
      "",
      `Fix the result, update the report .agency/jobs/${jobKey}/report.md, publish a new version (bb agency artifact publish), leave a summary comment and end the turn. The previous version ${returnedHash.slice(0, 8)} will not go to review again. If you disagree with a remark, answer with a comment and report-needs-input.`,
      reworkToken(requestId),
    ].join("\n");
  }
  return [
    `Агентство: владелец вернул ${jobKey} на доработку.`,
    "",
    "Замечания:",
    comment.trim(),
    "",
    `Исправьте результат, обновите отчёт .agency/jobs/${jobKey}/report.md, опубликуйте новую версию (bb agency artifact publish), оставьте итоговый комментарий и завершите ход. Прежняя версия ${returnedHash.slice(0, 8)} на проверку больше не пойдёт. Не согласны с замечанием — ответьте комментарием и report-needs-input.`,
    reworkToken(requestId),
  ].join("\n");
}

function readRow(db: SqlDatabase, requestId: string): ReworkRow | undefined {
  return db.prepare(`SELECT * FROM agency_rework WHERE request_id = ?`).get(requestId) as ReworkRow | undefined;
}

function setSendState(db: SqlDatabase, requestId: string, state: string, now: string): void {
  db.prepare(`UPDATE agency_rework SET send_state = ?, updated_at = ? WHERE request_id = ?`).run(state, now, requestId);
}

/** The attempt that holds the reviewed version: the latest one, awaiting review, with a thread. */
function reviewedAttempt(db: SqlDatabase, jobId: string): { id: string; thread_id: string; launch_id: string } | undefined {
  return db
    .prepare(
      `SELECT id, thread_id, launch_id FROM agency_run_attempt
       WHERE job_id = ? AND state = 'awaiting_review' AND thread_id IS NOT NULL
       ORDER BY attempt_no DESC LIMIT 1`,
    )
    .get(jobId) as { id: string; thread_id: string; launch_id: string } | undefined;
}

function applyReturn(deps: ReworkDeps, ctx: ServiceContext, row: ReworkRow, expectedRevision: number): DomainResult<Job> {
  return deps.db.transaction(() => {
    const job = deps.store.getJob(row.job_id);
    if (!job) return fail("not_found", `job ${row.job_id} not found`);
    if (job.state === "running") return ok(job);
    const moved = deps.store.transitionJob(ctx, {
      requestId: uuidV5(row.request_id, "agency.rework.job"),
      jobId: row.job_id,
      expectedRevision,
      to: "running",
      reworkComment: row.comment,
    });
    if (!moved.ok) return moved;
    const attempt = deps.reads.getAttempt(ctx, row.attempt_id);
    if (!attempt.ok) return attempt;
    if (attempt.value.state === "awaiting_review") {
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
      comment: `Возврат на доработку:\n\n${row.comment}`,
    });
    if (!commented.ok) return commented;
    setSendState(deps.db, row.request_id, "confirmed", new Date().toISOString());
    return ok(moved.value);
  })();
}

export async function returnJobForRework(deps: ReworkDeps, ctx: ServiceContext, input: ReturnForReworkInput): Promise<DomainResult<Job>> {
  const comment = input.comment.trim();
  if (!comment) return fail("invalid_command", "rework comment is required");
  const existing = readRow(deps.db, input.requestId);
  if (existing?.send_state === "confirmed") {
    const job = deps.store.getJob(existing.job_id);
    return job ? ok(job) : fail("not_found", `job ${existing.job_id} not found`);
  }
  const job = deps.store.getJob(input.jobId);
  if (!job) return fail("not_found", `job ${input.jobId} not found`);
  if (job.state !== "review") return fail("illegal_transition", `rework needs a job in review, not ${job.state}`);
  if (job.revision !== input.expectedRevision) {
    return fail("revision_conflict", "expectedRevision does not match the live job revision");
  }

  let row = existing;
  if (!row && deps.reworkLimit) {
    const limit = deps.reworkLimit(job);
    const done = (deps.db
      .prepare(`SELECT COUNT(*) AS n FROM agency_rework WHERE job_id = ? AND send_state = 'confirmed'`)
      .get(job.id) as { n: number }).n;
    if (done >= limit) {
      return fail("rework_limit_reached", `the job was returned ${done} time(s), the department limit is ${limit}`);
    }
  }
  if (!row) {
    const attempt = reviewedAttempt(deps.db, job.id);
    if (!attempt) return fail("rework_no_thread", "no attempt awaiting review with a live thread; relaunch the job instead");
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
