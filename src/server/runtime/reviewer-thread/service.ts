import { canonicalizeJson } from "../context-snapshot/canonical";
import { agencyLanguage, type AgencyLanguage } from "../../i18n/language.js";
import type { Job } from "../../../shared/contracts";
import type { SqlDatabase } from "../../db/sql";
import type { ContextSnapshot } from "../context-snapshot/types.js";
import { attemptPackDir } from "../context-snapshot/pack.js";
import type { IsolatedSendOutcome, IsolatedSendPort } from "../isolated-sdk/send-port.js";
import type { IsolatedThreadsApi } from "../isolated-sdk/sdk-ports.js";
import type { ThreadReusePort } from "../launch/ports.js";
import { nowUtc, type ServiceContext } from "../../services/context.js";
import type { RunAttempt } from "../run-store/types.js";

/**
 * Remembers the reviewer's hidden thread for a work line (reviewer + line root).
 * The launch coordinator (AG-151 2/2) reuses a live thread instead of spawning.
 */

const LINE_WALK_LIMIT = 20;

export const REVIEWER_THREAD_MIGRATION = `CREATE TABLE agency_reviewer_thread (
    reviewer_agent_id TEXT NOT NULL,
    line_job_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    origin_launch_id TEXT NOT NULL,
    origin_attempt_id TEXT NOT NULL,
    origin_job_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('live', 'dead')),
    dead_reason TEXT,
    last_job_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (reviewer_agent_id, line_job_id)
  )`;

export type ReviewerThreadState = "live" | "dead";

export type ReviewerThreadRow = {
  reviewerAgentId: string;
  lineJobId: string;
  threadId: string;
  originLaunchId: string;
  originAttemptId: string;
  originJobId: string;
  state: ReviewerThreadState;
  deadReason: string | null;
  lastJobId: string;
  createdAt: string;
  updatedAt: string;
};

export type RememberReviewerThreadInput = {
  reviewerAgentId: string;
  lineJobId: string;
  threadId: string;
  launchId: string;
  attemptId: string;
  jobId: string;
  now: string;
};

export type ReviewFollowUpInput = {
  job: Pick<Job, "key" | "title" | "brief" | "acceptance">;
  packDir: string;
  version: { hash: string; version: number } | null;
  attemptId: string;
};

type ThreadSqlRow = {
  reviewer_agent_id: string;
  line_job_id: string;
  thread_id: string;
  origin_launch_id: string;
  origin_attempt_id: string;
  origin_job_id: string;
  state: ReviewerThreadState;
  dead_reason: string | null;
  last_job_id: string;
  created_at: string;
  updated_at: string;
};

function mapRow(row: ThreadSqlRow): ReviewerThreadRow {
  return {
    reviewerAgentId: row.reviewer_agent_id,
    lineJobId: row.line_job_id,
    threadId: row.thread_id,
    originLaunchId: row.origin_launch_id,
    originAttemptId: row.origin_attempt_id,
    originJobId: row.origin_job_id,
    state: row.state,
    deadReason: row.dead_reason,
    lastJobId: row.last_job_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function workJobIdForReview(db: SqlDatabase, reviewJobId: string): string | null {
  const row = db
    .prepare(`SELECT job_id FROM agency_auto_review WHERE review_job_id = ? LIMIT 1`)
    .get(reviewJobId) as { job_id: string } | undefined;
  return row?.job_id ?? null;
}

function isAutoReviewJob(db: SqlDatabase, jobId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM agency_auto_review WHERE review_job_id = ? LIMIT 1`).get(jobId));
}

function jobParentId(db: SqlDatabase, jobId: string): string | null | undefined {
  const row = db.prepare(`SELECT parent_job_id FROM agency_job WHERE id = ?`).get(jobId) as
    | { parent_job_id: string | null }
    | undefined;
  return row ? row.parent_job_id : undefined;
}

function nextLineJob(db: SqlDatabase, currentId: string, parentJobId: string | null, visited: Set<string>): string | null {
  const sources = db
    .prepare(`SELECT source_job_id FROM agency_job_input_ref WHERE target_job_id = ? ORDER BY created_at ASC, source_job_id ASC`)
    .all(currentId) as Array<{ source_job_id: string }>;
  let sibling: string | null = null;
  for (const { source_job_id: sourceId } of sources) {
    if (sourceId === currentId || visited.has(sourceId)) continue;
    if (isAutoReviewJob(db, sourceId)) {
      const workId = workJobIdForReview(db, sourceId);
      if (workId && workId !== currentId && !visited.has(workId)) return workId;
      continue;
    }
    if (sibling) continue;
    const sourceParent = jobParentId(db, sourceId);
    if (sourceParent === undefined) continue;
    if (sourceParent === parentJobId) sibling = sourceId;
  }
  return sibling;
}

/** Root work job of an auto-review chain, or null when the job is not an auto-review. */
export function resolveReviewLine(db: SqlDatabase, reviewJobId: string): string | null {
  const workId = workJobIdForReview(db, reviewJobId);
  if (!workId) return null;
  const visited = new Set<string>();
  let current = workId;
  for (let step = 0; step < LINE_WALK_LIMIT; step += 1) {
    if (visited.has(current)) return current;
    visited.add(current);
    const parentJobId = jobParentId(db, current);
    if (parentJobId === undefined) return current;
    const next = nextLineJob(db, current, parentJobId, visited);
    if (!next) return current;
    current = next;
  }
  return current;
}

export function findReviewerThread(db: SqlDatabase, reviewerAgentId: string, lineJobId: string): ReviewerThreadRow | null {
  const row = db
    .prepare(`SELECT * FROM agency_reviewer_thread WHERE reviewer_agent_id = ? AND line_job_id = ? AND state = 'live'`)
    .get(reviewerAgentId, lineJobId) as ThreadSqlRow | undefined;
  return row ? mapRow(row) : null;
}

export function rememberReviewerThread(db: SqlDatabase, input: RememberReviewerThreadInput): ReviewerThreadRow {
  const existing = db
    .prepare(`SELECT * FROM agency_reviewer_thread WHERE reviewer_agent_id = ? AND line_job_id = ?`)
    .get(input.reviewerAgentId, input.lineJobId) as ThreadSqlRow | undefined;
  const replaceOrigin = !existing || existing.thread_id !== input.threadId;
  db.prepare(
    `INSERT INTO agency_reviewer_thread (
        reviewer_agent_id, line_job_id, thread_id, origin_launch_id, origin_attempt_id, origin_job_id,
        state, dead_reason, last_job_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'live', NULL, ?, ?, ?)
      ON CONFLICT(reviewer_agent_id, line_job_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        origin_launch_id = CASE WHEN agency_reviewer_thread.thread_id != excluded.thread_id
          THEN excluded.origin_launch_id ELSE agency_reviewer_thread.origin_launch_id END,
        origin_attempt_id = CASE WHEN agency_reviewer_thread.thread_id != excluded.thread_id
          THEN excluded.origin_attempt_id ELSE agency_reviewer_thread.origin_attempt_id END,
        origin_job_id = CASE WHEN agency_reviewer_thread.thread_id != excluded.thread_id
          THEN excluded.origin_job_id ELSE agency_reviewer_thread.origin_job_id END,
        state = 'live',
        dead_reason = NULL,
        last_job_id = excluded.last_job_id,
        updated_at = excluded.updated_at`,
  ).run(
    input.reviewerAgentId,
    input.lineJobId,
    input.threadId,
    replaceOrigin || !existing ? input.launchId : existing.origin_launch_id,
    replaceOrigin || !existing ? input.attemptId : existing.origin_attempt_id,
    replaceOrigin || !existing ? input.jobId : existing.origin_job_id,
    input.jobId,
    existing?.created_at ?? input.now,
    input.now,
  );
  const row = db
    .prepare(`SELECT * FROM agency_reviewer_thread WHERE reviewer_agent_id = ? AND line_job_id = ?`)
    .get(input.reviewerAgentId, input.lineJobId) as ThreadSqlRow;
  return mapRow(row);
}

export function markReviewerThreadDead(db: SqlDatabase, reviewerAgentId: string, lineJobId: string, reason: string, now: string): void {
  db.prepare(
    `UPDATE agency_reviewer_thread SET state = 'dead', dead_reason = ?, updated_at = ? WHERE reviewer_agent_id = ? AND line_job_id = ?`,
  ).run(reason, now, reviewerAgentId, lineJobId);
}

export function reviewFollowUpToken(attemptId: string): string {
  return `agency.review-followup:${attemptId}`;
}

export function composeReviewFollowUp(input: ReviewFollowUpInput, lang: AgencyLanguage = agencyLanguage()): string {
  const handIn =
    lang === "en"
      ? `Hand in: write ${input.packDir}/report.md, publish it as the job's artifact, submit that exact version with bb agency job submit (fresh job expectedRevision, artifactId, version, hash, comment) and end the turn. Do not wait for the owner to accept this station.`
      : `Сдача: напишите ${input.packDir}/report.md, опубликуйте его версией задачи, сдайте точную версию через bb agency job submit (свежая expectedRevision задачи, artifactId, version, hash, comment) и завершите ход. Не ждите, пока владелец примет станцию.`;
  const versionLine = input.version
    ? lang === "en"
      ? `Input version: v${input.version.version}, hash ${input.version.hash}.`
      : `Входная версия: v${input.version.version}, hash ${input.version.hash}.`
    : lang === "en"
      ? "Input version: none attached."
      : "Входная версия: не приложена.";
  const body =
    lang === "en"
      ? [
          `This is a repeat review of the same work line, not a new spawn.`,
          `Job ${input.job.key}: ${input.job.title}`,
          "",
          "Brief:",
          input.job.brief,
          "",
          "Acceptance:",
          input.job.acceptance,
          "",
          versionLine,
          `Job pack: ${input.packDir}/.`,
          handIn,
        ]
      : [
          `Это повторная проверка той же линии работы, не новый запуск.`,
          `Задача ${input.job.key}: ${input.job.title}`,
          "",
          "Бриф:",
          input.job.brief,
          "",
          "Критерий:",
          input.job.acceptance,
          "",
          versionLine,
          `Пакет задачи: ${input.packDir}/.`,
          handIn,
        ];
  return [`${input.job.key}: ${input.job.title}`, "", ...body, reviewFollowUpToken(input.attemptId)].join("\n");
}

const DEAD_THREAD_STATUSES = new Set(["archived"]);

function jobFollowUpFields(db: SqlDatabase, jobId: string): Pick<Job, "key" | "title" | "brief" | "acceptance"> | null {
  const row = db.prepare(`SELECT key, title, brief, acceptance FROM agency_job WHERE id = ?`).get(jobId) as
    | { key: string; title: string; brief: string; acceptance: string }
    | undefined;
  return row ?? null;
}

function inputVersionForFollowUp(snapshot: ContextSnapshot): { hash: string; version: number } | null {
  const fromArtifacts = snapshot.inputArtifacts[0];
  if (fromArtifacts) return { hash: fromArtifacts.hash, version: fromArtifacts.version };
  const fromHandoff = snapshot.handoff?.acceptedArtifacts[0];
  if (fromHandoff) return { hash: fromHandoff.hash, version: fromHandoff.version };
  return null;
}

function lineForReviewAttempt(db: SqlDatabase, attempt: RunAttempt, snapshot: ContextSnapshot): string | null {
  return resolveReviewLine(db, attempt.jobId) ?? resolveReviewLine(db, snapshot.job.id);
}

export function createReviewerThreadReusePort(
  db: SqlDatabase,
  threads: Pick<IsolatedThreadsApi, "get">,
  send: IsolatedSendPort | undefined,
): ThreadReusePort {
  return {
    resolve(_ctx, attempt, snapshot) {
      const lineJobId = lineForReviewAttempt(db, attempt, snapshot);
      if (!lineJobId) return null;
      const row = findReviewerThread(db, snapshot.agentVersion.agentId, lineJobId);
      if (!row) return null;
      const original = db.prepare(`SELECT s.snapshot_json FROM agency_run_attempt a JOIN agency_context_snapshot s ON s.id=a.snapshot_id WHERE a.id=?`).get(row.originAttemptId) as {snapshot_json:string}|undefined;
      const priorPolicy = original ? (JSON.parse(original.snapshot_json) as ContextSnapshot).workerContext?.policy ?? null : null;
      // Provider sessions cannot reliably replace their loaded context on a follow-up.
      if(canonicalizeJson(priorPolicy) !== canonicalizeJson(snapshot.workerContext?.policy ?? null)) return null;
      return {
        threadId: row.threadId,
        originLaunchId: row.originLaunchId,
        originAttemptId: row.originAttemptId,
        originJobId: row.originJobId,
      };
    },
    async deliver(threadId, attempt, snapshot): Promise<IsolatedSendOutcome> {
      try {
        const view = await threads.get({ threadId, include: "environment,host" });
        const status = view.status?.trim().toLowerCase() ?? "";
        if (DEAD_THREAD_STATUSES.has(status)) {
          return { kind: "rejected", code: "thread_archived", message: `saved reviewer thread is ${status}` };
        }
      } catch (error) {
        return {
          kind: "rejected",
          code: "thread_gone",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (!send) {
        return { kind: "rejected", code: "sdk_send_unsupported", message: "threads.send is not bound" };
      }
      const job = jobFollowUpFields(db, attempt.jobId);
      if (!job) {
        return { kind: "rejected", code: "review_job_missing", message: "auto-review job is missing for follow-up" };
      }
      const text = composeReviewFollowUp({
        job,
        packDir: snapshot.pack?.dir ?? attemptPackDir(job.key),
        version: inputVersionForFollowUp(snapshot),
        attemptId: attempt.attemptId,
      });
      return send.send({ threadId, text });
    },
    remember(ctx: ServiceContext, attempt, threadId, launchId) {
      const snapshotJobId = attempt.jobId;
      const lineJobId = resolveReviewLine(db, snapshotJobId);
      if (!lineJobId) return;
      const agentRow = db
        .prepare(
          `SELECT json_extract(snapshot_json, '$.agentVersion.agentId') AS agentId
           FROM agency_context_snapshot WHERE id = ?`,
        )
        .get(attempt.snapshotId) as { agentId: string | null } | undefined;
      const reviewerAgentId = agentRow?.agentId;
      if (!reviewerAgentId) return;
      rememberReviewerThread(db, {
        reviewerAgentId,
        lineJobId,
        threadId,
        launchId,
        attemptId: attempt.attemptId,
        jobId: attempt.jobId,
        now: nowUtc(ctx),
      });
    },
    markDead(ctx: ServiceContext, attempt, reason) {
      const lineJobId = resolveReviewLine(db, attempt.jobId);
      if (!lineJobId) return;
      const agentRow = db
        .prepare(
          `SELECT json_extract(snapshot_json, '$.agentVersion.agentId') AS agentId
           FROM agency_context_snapshot WHERE id = ?`,
        )
        .get(attempt.snapshotId) as { agentId: string | null } | undefined;
      const reviewerAgentId = agentRow?.agentId;
      if (!reviewerAgentId) return;
      markReviewerThreadDead(db, reviewerAgentId, lineJobId, reason, nowUtc(ctx));
    },
  };
}
