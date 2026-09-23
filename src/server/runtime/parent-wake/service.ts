import { readLaunchIssue } from "../launch-queue/issues";
import { recordTrace } from "../trace/store";
import { latestReviewText, parseReviewVerdict } from "../conveyor/verdict.js";
import { agencyLanguage, type AgencyLanguage } from "../../i18n/language.js";
import { createRepositories } from "../../db/repositories.js";
import type { SqlDatabase } from "../../db/sql";
import { parseJson } from "../../db/sql";
import type { Activity, ActivityActor, Job } from "../../../shared/contracts";
import { TERMINAL_RUN_ATTEMPT_STATES } from "../run-store/types.js";
import type { IsolatedSendOutcome, IsolatedSendPort } from "../isolated-sdk/send-port.js";
import { loopWakeNote } from "../loop-break/mark.js";
import { latestLoopMark, rootJobId } from "../loop-break/store.js";

/** Closing states wake the lead too: an owner may accept or cancel a subtask from the card. */
export const PARENT_WAKE_STATES = new Set(["review", "blocked", "waiting_input", "done", "canceled"]);

const CLOSING_HINT: Record<string, string> = {
  done: "Подзадача закрыта. Если открытых подзадач не осталось, соберите итог главной задачи.",
  canceled: "Подзадача отменена. Решите, нужна ли замена.",
};

export function parentWakeToken(activityId: string): string {
  return `agency.parentWake:${activityId}`;
}

const CLOSING_HINT_EN: Record<string, string> = {
  done: "Subtask closed. If no subtasks are left open, assemble the main job result.",
  canceled: "Subtask canceled. Decide whether it needs a replacement.",
};

export function formatParentWakeText(
  child: { key: string; state: string },
  activityId: string,
  lang: AgencyLanguage = agencyLanguage(),
  note?: string | null,
): string {
  const line = note?.trim();
  if (lang === "en") {
    return [
      `${child.key} → ${child.state}.`,
      "Read the child with getJob. This is not an acceptance and not access to its artifacts.",
      ...(CLOSING_HINT_EN[child.state] ? [CLOSING_HINT_EN[child.state]] : []),
      ...(line ? [line] : []),
      parentWakeToken(activityId),
    ].join("\n");
  }
  return [
    `${child.key} → ${child.state}.`,
    "Прочитайте ребёнка getJob. Это не приёмка и не доступ к артефактам.",
    ...(CLOSING_HINT[child.state] ? [CLOSING_HINT[child.state]] : []),
    ...(line ? [line] : []),
    parentWakeToken(activityId),
  ].join("\n");
}

type ParentTarget = {
  parentJobId: string;
  parentAttemptId: string;
  parentLaunchId: string;
  parentThreadId: string;
};

type WakeRow = {
  activity_id: string;
  causation_id: string;
  child_job_id: string;
  child_key: string;
  child_state: string;
  parent_job_id: string;
  parent_attempt_id: string;
  parent_launch_id: string;
  parent_thread_id: string;
  send_state: string;
  send_code: string | null;
  send_message: string | null;
  dispatch_claimed: number;
  queued_message_id: string | null;
  created_at: string;
  updated_at: string;
};

type ClaimedWake = { row: WakeRow; sendNow: boolean };

function wakeStateFromActivity(row: Activity): string | null {
  if (row.kind === "comment" && row.references.some(ref => ref.type === "launch_issue"))
    return row.references.find(ref => ref.type === "job_state")?.id ?? null;
  if (row.kind !== "job_transitioned") return null;
  const ref = row.references.find((item) => item.type === "job_state");
  if (!ref || !PARENT_WAKE_STATES.has(ref.id)) return null;
  return ref.id;
}

/**
 * A lead hears about every subtask of its job: another department, another folder of the
 * project or an employee's workplace. Placement was checked when the subtask was created.
 */
function linkedChild(parent: Job, child: Job): boolean {
  return child.parentJobId === parent.id;
}

function latestJobTransitioned(db: SqlDatabase, jobId: string): Activity | null {
  const row = db
    .prepare(
      `SELECT id, job_id, actor, kind, causation_id, timestamp, references_json, comment
       FROM agency_activity
       WHERE job_id = ? AND kind = 'job_transitioned'
       ORDER BY rowid DESC
       LIMIT 1`,
    )
    .get(jobId) as
    | {
        id: string;
        job_id: string;
        actor: string;
        kind: string;
        causation_id: string | null;
        timestamp: string;
        references_json: string;
        comment: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    actor: parseJson<ActivityActor>(row.actor),
    kind: row.kind,
    causationId: row.causation_id,
    timestamp: row.timestamp,
    references: parseJson(row.references_json),
    ...(row.comment ? { comment: row.comment } : {}),
  };
}

function isCurrentTransitionCausation(db: SqlDatabase, jobId: string, activityId: string, causationId: string): boolean {
  const issue = readLaunchIssue(db, jobId);
  if (issue?.activity_id === activityId && causationId === activityId) {
    const current = createRepositories(db).job.get(jobId);
    return Boolean(current && current.revision === issue.revision && !["done", "canceled"].includes(current.state));
  }
  const latest = latestJobTransitioned(db, jobId);
  if (!latest) return false;
  return latest.id === activityId && causationId === latest.id;
}

/** Exact current HEAD attempt only. Never walk to an older nonterminal. */
function resolveParentTarget(db: SqlDatabase, child: Job): ParentTarget | null {
  if (!child.parentJobId) return null;
  const repos = createRepositories(db);
  const parent = repos.job.get(child.parentJobId);
  if (!parent) return null;
  if (!linkedChild(parent, child)) return null;
  const head = db
    .prepare(
      `SELECT id, launch_id, thread_id, state, attempt_no FROM agency_run_attempt
       WHERE job_id = ? ORDER BY attempt_no DESC LIMIT 1`,
    )
    .get(parent.id) as
    | { id: string; launch_id: string | null; thread_id: string | null; state: string; attempt_no: number }
    | undefined;
  if (!head) return null;
  if ((TERMINAL_RUN_ATTEMPT_STATES as readonly string[]).includes(head.state)) return null;
  if (!head.thread_id || !head.launch_id) return null;
  const receipt = db
    .prepare(`SELECT attempt_id, job_id, thread_id, spawn_kind FROM agency_launch_receipt WHERE launch_id = ?`)
    .get(head.launch_id) as
    | { attempt_id: string; job_id: string; thread_id: string | null; spawn_kind: string }
    | undefined;
  if (!receipt || receipt.spawn_kind === "canceled" || receipt.spawn_kind === "rejected") return null;
  if (receipt.attempt_id !== head.id || receipt.job_id !== parent.id || receipt.thread_id !== head.thread_id) {
    return null;
  }
  return {
    parentJobId: parent.id,
    parentAttemptId: head.id,
    parentLaunchId: head.launch_id,
    parentThreadId: head.thread_id,
  };
}

function wakeStillCurrentHead(db: SqlDatabase, row: WakeRow): boolean {
  const repos = createRepositories(db);
  const child = repos.job.get(row.child_job_id);
  if (!child) return false;
  if (child.state !== row.child_state) return false;
  if (!isCurrentTransitionCausation(db, child.id, row.activity_id, row.causation_id)) return false;
  const parent = repos.job.get(row.parent_job_id);
  if (!parent || !linkedChild(parent, child)) return false;
  const target = resolveParentTarget(db, child);
  if (!target) return false;
  return (
    target.parentJobId === row.parent_job_id &&
    target.parentAttemptId === row.parent_attempt_id &&
    target.parentLaunchId === row.parent_launch_id &&
    target.parentThreadId === row.parent_thread_id
  );
}

function isAutoReviewChild(db: SqlDatabase, jobId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM agency_auto_review WHERE review_job_id = ? LIMIT 1`).get(jobId));
}

export function enqueueParentWake(db: SqlDatabase, child: Job, activity: Activity, now: string): boolean {
  const childState = wakeStateFromActivity(activity);
  if (!childState) return false;
  if (activity.jobId !== child.id) return false;
  if (child.state !== childState) return false;
  if (!isCurrentTransitionCausation(db, child.id, activity.id, activity.causationId ?? activity.id)) return false;
  // Automatic QC children are conveyor traffic. Pinging the lead on every
  // «done» burned a planning turn on a status the lead does not act on.
  if (isAutoReviewChild(db, child.id)) {
    const needsLead = activity.references.some(ref => ref.type === "launch_issue") || childState === "blocked" || childState === "waiting_input" ||
      (childState === "done" && parseReviewVerdict(latestReviewText(db, child.id)) !== "accept");
    if (!needsLead) return false;
  }
  const target = resolveParentTarget(db, child);
  if (!target) return false;
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO agency_parent_wake (
        activity_id, causation_id, child_job_id, child_key, child_state,
        parent_job_id, parent_attempt_id, parent_launch_id, parent_thread_id,
        send_state, send_code, send_message, dispatch_claimed, queued_message_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, 0, NULL, ?, ?)`,
    )
    .run(
      activity.id,
      activity.id,
      child.id,
      child.key,
      childState,
      target.parentJobId,
      target.parentAttemptId,
      target.parentLaunchId,
      target.parentThreadId,
      now,
      now,
    );
  return result.changes > 0;
}

export function recoverParentWakesFromActivities(db: SqlDatabase, now: string): number {
  const repos = createRepositories(db);
  const rows = db
    .prepare(`SELECT job_id FROM agency_activity WHERE kind = 'job_transitioned'`)
    .all() as Array<{ job_id: string }>;
  const jobIds = [...new Set(rows.map((row) => row.job_id))];
  let inserted = 0;
  for (const jobId of jobIds) {
    const child = repos.job.get(jobId);
    if (!child) continue;
    const latest = latestJobTransitioned(db, jobId);
    if (!latest) continue;
    if (enqueueParentWake(db, child, latest, now)) inserted += 1;
  }
  const issues = db.prepare("SELECT activity_json, job_id FROM agency_launch_issue").all() as Array<{ activity_json: string; job_id: string }>;
  for (const issue of issues) {
    const child = repos.job.get(issue.job_id);
    if (child && enqueueParentWake(db, child, JSON.parse(issue.activity_json) as Activity, now)) inserted++;
  }
  return inserted;
}

function readWake(db: SqlDatabase, activityId: string, parentAttemptId: string): WakeRow | undefined {
  return db
    .prepare(`SELECT * FROM agency_parent_wake WHERE activity_id = ? AND parent_attempt_id = ?`)
    .get(activityId, parentAttemptId) as WakeRow | undefined;
}

function claimPending(db: SqlDatabase, now: string): ClaimedWake[] {
  const pending = db
    .prepare(
      `SELECT * FROM agency_parent_wake
       WHERE send_state IN ('pending', 'queued', 'unknown')
       ORDER BY created_at`,
    )
    .all() as WakeRow[];
  const claimed: ClaimedWake[] = [];
  for (const row of pending) {
    if (row.send_state === "pending" && row.dispatch_claimed === 0) {
      const updated = db
        .prepare(
          `UPDATE agency_parent_wake SET dispatch_claimed = 1, updated_at = ?
           WHERE activity_id = ? AND parent_attempt_id = ? AND dispatch_claimed = 0 AND send_state = 'pending'`,
        )
        .run(now, row.activity_id, row.parent_attempt_id);
      if (updated.changes !== 1) {
        const lost = readWake(db, row.activity_id, row.parent_attempt_id);
        if (
          lost &&
          lost.dispatch_claimed === 1 &&
          (lost.send_state === "pending" || lost.send_state === "queued" || lost.send_state === "unknown")
        ) {
          claimed.push({ row: lost, sendNow: false });
        }
        continue;
      }
      const next = readWake(db, row.activity_id, row.parent_attempt_id);
      if (next) claimed.push({ row: next, sendNow: true });
      continue;
    }
    if (
      row.dispatch_claimed === 1 &&
      (row.send_state === "pending" || row.send_state === "queued" || row.send_state === "unknown")
    ) {
      claimed.push({ row, sendNow: false });
    }
  }
  return claimed;
}

function markSkipped(db: SqlDatabase, row: WakeRow, now: string, code: string, message: string): void {
  db.prepare(
    `UPDATE agency_parent_wake SET send_state = 'skipped', send_code = ?, send_message = ?, updated_at = ?
     WHERE activity_id = ? AND parent_attempt_id = ?`,
  ).run(code, message, now, row.activity_id, row.parent_attempt_id);
}

function writeOutcome(db: SqlDatabase, row: WakeRow, outcome: IsolatedSendOutcome | { kind: "recovered" }, now: string): void {
  if (outcome.kind === "recovered" || (outcome.kind === "confirmed" && outcome.delivery === "sent")) {
    db.prepare(
      `UPDATE agency_parent_wake SET send_state = 'confirmed', send_code = NULL, send_message = NULL, updated_at = ?
       WHERE activity_id = ? AND parent_attempt_id = ?`,
    ).run(now, row.activity_id, row.parent_attempt_id);
    return;
  }
  if (outcome.kind === "confirmed" && outcome.delivery === "queued") {
    db.prepare(
      `UPDATE agency_parent_wake
       SET send_state = 'queued', queued_message_id = ?, send_code = NULL, send_message = NULL, updated_at = ?
       WHERE activity_id = ? AND parent_attempt_id = ?`,
    ).run(outcome.queuedMessageId ?? row.queued_message_id, now, row.activity_id, row.parent_attempt_id);
    return;
  }
  if (outcome.kind === "unknown") {
    db.prepare(
      `UPDATE agency_parent_wake SET send_state = 'unknown', send_code = ?, send_message = ?, updated_at = ?
       WHERE activity_id = ? AND parent_attempt_id = ?`,
    ).run(outcome.code, outcome.message, now, row.activity_id, row.parent_attempt_id);
    return;
  }
  if (outcome.kind === "rejected") {
    db.prepare(
      `UPDATE agency_parent_wake SET send_state = 'rejected', send_code = ?, send_message = ?, updated_at = ?
       WHERE activity_id = ? AND parent_attempt_id = ?`,
    ).run(outcome.code, outcome.message, now, row.activity_id, row.parent_attempt_id);
  }
}

export async function flushParentWakes(deps: {
  db: SqlDatabase;
  send: IsolatedSendPort;
  now: string;
}): Promise<void> {
  const claimed = deps.db.transaction(() => claimPending(deps.db, deps.now))();
  for (const item of claimed) {
    const live = deps.db.transaction(() => {
      const row = readWake(deps.db, item.row.activity_id, item.row.parent_attempt_id) ?? item.row;
      if (!wakeStillCurrentHead(deps.db, row)) {
        markSkipped(deps.db, row, deps.now, "parent_head_changed", "wake is not the current parent HEAD receipt");
        return { ok: false as const };
      }
      return { ok: true as const, row };
    })();
    if (!live.ok) continue;
    const row = live.row;
    let outcome: IsolatedSendOutcome | { kind: "recovered" };
    try {
      if (item.sendNow) {
        outcome = await deps.send.send({
          threadId: row.parent_thread_id,
          text: formatParentWakeText(
            { key: row.child_key, state: row.child_state },
            row.activity_id,
            "en",
            readLaunchIssue(deps.db, row.child_job_id)?.activity_id === row.activity_id
              ? (JSON.parse(readLaunchIssue(deps.db, row.child_job_id)!.activity_json) as Activity).comment
              : loopWakeNote(latestLoopMark(deps.db, rootJobId(deps.db, row.parent_job_id)), "en"),
          ) + `\nRead current goal and decision: bb agency job state --input-json '{"jobId":"${row.parent_job_id}"}'. Update job decide only if the route changes.`,
        });
      } else {
        const presence = await deps.send.recoverContinuation(
          row.parent_thread_id,
          parentWakeToken(row.activity_id),
          row.queued_message_id,
        );
        if (presence === "present") outcome = { kind: "recovered" };
        else if (presence === "queued") {
          outcome = { kind: "confirmed", delivery: "queued", queuedMessageId: row.queued_message_id ?? undefined };
        } else {
          continue;
        }
      }
    } catch {
      outcome = { kind: "unknown", code: "send_transport", message: item.sendNow ? "send failed" : "recover failed" };
    }
    deps.db.transaction(() => writeOutcome(deps.db, row, outcome, deps.now))();
    recordTrace(deps.db, { jobId: row.child_job_id, relatedJobId: row.parent_job_id, step: "lead.delivery",
      outcome: outcome.kind === "confirmed" || outcome.kind === "recovered" ? "succeeded" : "failed",
      reason: outcome.kind, requestId: row.activity_id, attemptId: row.parent_attempt_id, launchId: row.parent_launch_id, threadId: row.parent_thread_id,
      facts: { delivery: "delivery" in outcome ? outcome.delivery : outcome.kind }, collapse: true });
  }
}
