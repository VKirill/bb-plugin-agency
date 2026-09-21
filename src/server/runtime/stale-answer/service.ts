import { randomUUID } from "node:crypto";
import { agencyLanguage } from "../../i18n/language.js";
import { callerAttemptForThread, callerThreadId } from "../../api/caller.js";
import { fail, ok, type DomainResult } from "../../../domain/result.js";
import type { SqlDatabase } from "../../db/sql";
import { recordOwnerMessage } from "../../owner-messages/service.js";
import type { ServiceContext } from "../../services/context.js";
import { latestHandedInVersion } from "../conveyor/station.js";
import { isOriginThreadId } from "../client-bounce/origin.js";
import { hasLiveAttempt } from "../stale-sweeper/service.js";
import type { Job } from "../../../shared/contracts";
import {
  STALE_OUTCOME_CODE,
  staleAnswerSchema,
  type StaleAnswerCommand,
} from "../../../shared/contracts/stale-nudge";

export type StaleAnswerStore = {
  getJob: (id: string) => Job | undefined;
  getJobByKey: (key: string) => Job | undefined;
  transitionJob: (
    ctx: ServiceContext,
    input: { requestId: string; jobId: string; expectedRevision: number; to: "canceled" },
  ) => DomainResult<Job>;
  createActivity: (
    ctx: ServiceContext,
    input: {
      requestId: string;
      jobId: string;
      actor: { kind: "system" };
      kind: "comment";
      causationId: null;
      references: [];
      comment: string;
    },
  ) => DomainResult<unknown>;
};

export type StaleAnswerResult = {
  jobId: string;
  jobKey: string;
  nudgeId: string;
  decision: StaleAnswerCommand["decision"];
  jobState: string;
  revision: number;
  outcomeCode?: typeof STALE_OUTCOME_CODE;
  nextCheckAt?: string;
};

type NudgeRow = {
  nudge_id: string;
  job_id: string;
  origin_thread_id: string;
  state_since: string;
  send_state: string;
  decision: string | null;
};

function resolveJob(store: StaleAnswerStore, idOrKey: string): Job | undefined {
  return store.getJob(idOrKey) ?? store.getJobByKey(idOrKey);
}

function readNudge(db: SqlDatabase, id: string): NudgeRow | undefined {
  return db.prepare(`SELECT nudge_id, job_id, origin_thread_id, state_since, send_state, decision FROM agency_stale_nudge WHERE nudge_id = ?`).get(id) as
    | NudgeRow
    | undefined;
}

function callerIsOrigin(db: SqlDatabase, origin: string): boolean {
  const thread = callerThreadId()?.trim() ?? null;
  if (!thread || thread !== origin || !isOriginThreadId(thread)) return false;
  return !callerAttemptForThread(db, thread);
}

function commentText(job: Pick<Job, "key">, decision: string, reason: string, extra: string): string {
  const en = agencyLanguage() === "en";
  if (en) {
    return extra
      ? `${job.key}: origin-chat agent chose ${decision}. ${reason} ${extra}`
      : `${job.key}: origin-chat agent chose ${decision}. ${reason}`;
  }
  return extra
    ? `${job.key}: агент чата постановки ответил ${decision}. ${reason} ${extra}`
    : `${job.key}: агент чата постановки ответил ${decision}. ${reason}`;
}

export function applyStaleAnswer(
  deps: { db: SqlDatabase; store: StaleAnswerStore; now?: () => Date },
  ctx: ServiceContext,
  raw: unknown,
): DomainResult<StaleAnswerResult> {
  const parsed = staleAnswerSchema.safeParse(raw);
  if (!parsed.success) return fail("invalid_command", parsed.error.message);
  const input = parsed.data;
  const job = resolveJob(deps.store, input.jobId);
  if (!job) return fail("not_found", `job ${input.jobId} not found`);
  const origin = job.originThreadId?.trim() ?? "";
  if (!callerIsOrigin(deps.db, origin)) {
    return fail(
      "foreign_thread",
      agencyLanguage() === "en"
        ? "stale-answer is only allowed from the job's commissioning chat"
        : "stale-answer можно вызвать только из чата, откуда ставили задачу",
    );
  }
  const nudge = readNudge(deps.db, input.nudgeId);
  if (!nudge || nudge.job_id !== job.id) {
    return fail("not_stale_candidate", `nudge ${input.nudgeId} is not an open stale nudge for ${job.key}`);
  }
  if (nudge.decision || job.state === "done" || job.state === "canceled") {
    return fail("duplicate", `nudge ${input.nudgeId} is already closed`);
  }
  if (job.revision !== input.expectedJobRevision) {
    return fail("revision_conflict", `job revision is ${job.revision}, expected ${input.expectedJobRevision}`);
  }
  if (job.state === "waiting_input" || (job.state !== "blocked" && job.state !== "running")) {
    return fail("not_stale_candidate", `job ${job.key} is ${job.state}`);
  }
  const now = deps.now?.() ?? new Date();
  if (input.decision === "keep") {
    const hours = input.nextCheckHours!;
    const nextCheckAt = new Date(now.getTime() + hours * 3_600_000).toISOString();
    deps.db
      .prepare(`UPDATE agency_stale_nudge SET decision = 'keep', next_check_at = ?, reason_code = NULL WHERE nudge_id = ?`)
      .run(nextCheckAt, nudge.nudge_id);
    deps.store.createActivity(ctx, {
      requestId: input.requestId,
      jobId: job.id,
      actor: { kind: "system" },
      kind: "comment",
      causationId: null,
      references: [],
      comment: commentText(job, "keep", input.reason, agencyLanguage() === "en" ? `Next check ${nextCheckAt}.` : `Следующая проверка ${nextCheckAt}.`),
    });
    return ok({
      jobId: job.id,
      jobKey: job.key,
      nudgeId: nudge.nudge_id,
      decision: "keep",
      jobState: job.state,
      revision: job.revision,
      nextCheckAt,
    });
  }
  if (input.decision === "escalate") {
    const key = `stale:${nudge.nudge_id}:escalate`;
    const text =
      agencyLanguage() === "en"
        ? `Origin chat asked to escalate ${job.key} «${job.title}»: ${input.reason}`
        : `Чат постановки просит эскалацию ${job.key} «${job.title}»: ${input.reason}`;
    recordOwnerMessage(deps.db, { text, level: "warning", jobId: job.id, dedupeKey: key }, "stale-answer", now.toISOString());
    deps.db.prepare(`UPDATE agency_stale_nudge SET decision = 'escalate', reason_code = 'escalated' WHERE nudge_id = ?`).run(nudge.nudge_id);
    deps.store.createActivity(ctx, {
      requestId: input.requestId,
      jobId: job.id,
      actor: { kind: "system" },
      kind: "comment",
      causationId: null,
      references: [],
      comment: commentText(job, "escalate", input.reason, ""),
    });
    return ok({
      jobId: job.id,
      jobKey: job.key,
      nudgeId: nudge.nudge_id,
      decision: "escalate",
      jobState: job.state,
      revision: job.revision,
    });
  }
  if (job.state === "running" && hasLiveAttempt(deps.db, job.id)) {
    return fail(
      "live_attempt",
      agencyLanguage() === "en"
        ? "stop the running attempt (launch cancel) before close/cancel"
        : "сначала остановите живую попытку (launch cancel)",
    );
  }
  if (input.decision === "close" && latestHandedInVersion(deps.db, job.id)) {
    return fail(
      "needs_acceptance",
      agencyLanguage() === "en"
        ? "this job has a published version; acceptance stays with the reviewer or owner"
        : "у задачи есть опубликованная версия; приёмка остаётся за проверяющим или владельцем",
    );
  }
  const moved = deps.store.transitionJob(ctx, {
    requestId: input.requestId,
    jobId: job.id,
    expectedRevision: job.revision,
    to: "canceled",
  });
  if (!moved.ok) return moved;
  deps.db
    .prepare(`UPDATE agency_stale_nudge SET decision = ?, reason_code = ? WHERE nudge_id = ?`)
    .run(input.decision, STALE_OUTCOME_CODE, nudge.nudge_id);
  const extra =
    input.decision === "close"
      ? agencyLanguage() === "en"
        ? `Closed by origin-chat answer: the question was resolved outside this job; no version was accepted (${STALE_OUTCOME_CODE}).`
        : `Закрыто по ответу origin-чата: вопрос решён вне этой задачи, версия не принималась (${STALE_OUTCOME_CODE}).`
      : agencyLanguage() === "en"
        ? `Canceled by origin-chat answer (${STALE_OUTCOME_CODE}).`
        : `Отменено по ответу origin-чата (${STALE_OUTCOME_CODE}).`;
  deps.store.createActivity(ctx, {
    requestId: randomUUID(),
    jobId: moved.value.id,
    actor: { kind: "system" },
    kind: "comment",
    causationId: null,
    references: [],
    comment: commentText(moved.value, input.decision, input.reason, extra),
  });
  return ok({
    jobId: moved.value.id,
    jobKey: moved.value.key,
    nudgeId: nudge.nudge_id,
    decision: input.decision,
    jobState: moved.value.state,
    revision: moved.value.revision,
    outcomeCode: STALE_OUTCOME_CODE,
  });
}
