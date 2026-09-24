import type { Job } from "../../../shared/contracts";
import type { SqlDatabase } from "../../db/sql";
import { agencyLanguage } from "../../i18n/language.js";

export const HOST_RECONNECT_MIGRATION = `CREATE TABLE agency_host_retry (
  attempt_id TEXT NOT NULL, turn_request_id TEXT NOT NULL, job_id TEXT NOT NULL,
  error_seq INTEGER NOT NULL, state TEXT NOT NULL, claimed_at TEXT NOT NULL,
  delivery TEXT, PRIMARY KEY(attempt_id, turn_request_id)
)`;

type Event = { seq: number; type: string; data?: unknown };
export type ThreadFailure = { detail: string | null; willRetry: boolean | null; hostTurn: { requestId: string; errorSeq: number } | null };
const HOST_DISCONNECT = /\bHost is not connected\b|\bhost_disconnected\b|\bhost_unavailable\b/i;

/** Only the current failure and its preceding request; never replay a historical turn. */
export function readThreadFailure(events: readonly Event[]): ThreadFailure {
  const ordered = [...events].sort((a, b) => b.seq - a.seq);
  const empty: ThreadFailure = { detail: null, willRetry: null, hostTurn: null };
  const error = ordered.find(e => e.type === "provider/error" || e.type === "system/error");
  if (!error || ordered.some(e => e.seq > error.seq && (e.type === "client/turn/requested" || e.type === "turn/started"))) return empty;
  const data = error.data as { code?: unknown; detail?: unknown; message?: unknown; willRetry?: unknown } | undefined;
  const detail = [data?.detail, data?.message].find(v => typeof v === "string" && v.trim()) as string | undefined;
  const request = ordered.find(e => e.seq < error.seq && e.type === "client/turn/requested");
  const requestId = (request?.data as { requestId?: unknown } | undefined)?.requestId;
  const isHost = error.type === "system/error" && data?.code === "thread_command_failed" && HOST_DISCONNECT.test(detail ?? "");
  return { detail: detail ?? null, willRetry: typeof data?.willRetry === "boolean" ? data.willRetry : null,
    hostTurn: isHost && typeof requestId === "string" && requestId ? { requestId, errorSeq: error.seq } : null };
}

export type HostReconnectPorts = {
  db: SqlDatabase;
  getJob(id: string): Job | undefined;
  attemptForLaunch(id: string): { id: string; state: string } | undefined;
  hostOnline(job: Job): Promise<boolean | null>;
  threadStatus(id: string): Promise<string>;
  queuedCount(id: string): Promise<number>;
  retry(threadId: string, requestId: string): Promise<{ ok: true; delivery: "sent" | "queued" }>;
  block(job: Job, text: string): boolean;
  comment(job: Job, text: string): boolean;
  log(event: { jobId: string; attemptId: string; threadId: string; requestId: string; outcome: string }): void;
  now(): string;
};

/** One durable claim per failed turn, two automatic retries; a third failure goes to the lead.
 * Core owns dispatch/queue/provider continuation. No spawn, cancel, model change or
 * manual replay of prompts. Ambiguous delivery after crash is never resent blindly.
 */
export async function resumeAfterHostReconnect(
  ports: HostReconnectPorts,
  row: { jobId: string; launchId: string; threadId: string },
  failure: ThreadFailure,
): Promise<"skipped" | "waiting" | "retried" | "blocked"> {
  if (!failure.hostTurn) return "skipped";
  let job = ports.getJob(row.jobId);
  const attempt = ports.attemptForLaunch(row.launchId);
  if (!job || job.state !== "running" || attempt?.state !== "running") return "skipped";
  if (await ports.hostOnline(job) !== true) return "waiting";
  if (await ports.queuedCount(row.threadId) > 0) return "waiting";
  if (await ports.threadStatus(row.threadId) !== "error") return "waiting";
  // Re-read after network I/O: a manual stop or lead intervention wins.
  job = ports.getJob(row.jobId);
  if (!job || job.state !== "running" || ports.attemptForLaunch(row.launchId)?.state !== "running") return "skipped";
  const { requestId, errorSeq } = failure.hostTurn;
  const now = ports.now();
  const event = (outcome: string) => ports.log({ jobId: job!.id, attemptId: attempt.id, threadId: row.threadId, requestId, outcome });
  const block = (reason: string): "blocked" | "waiting" => {
    const fresh = ports.getJob(row.jobId);
    if (!fresh || fresh.state !== "running") return "waiting";
    const text = agencyLanguage() === "en"
      ? `Agency: reconnect needs the lead's decision: ${reason}. Thread ${row.threadId}, failed turn ${requestId}, attempt ${attempt.id}. Do not cancel or retry automatically; inspect the BB queue and the actual retry outcome.`
      : `Агентство: восстановление связи требует решения руководителя: ${reason}. Тред ${row.threadId}, failed turn ${requestId}, попытка ${attempt.id}. Не отменяйте и не повторяйте автоматически; проверьте очередь BB и фактический результат retry.`;
    const ok = ports.block(fresh, text);
    if (ok) event(reason);
    return ok ? "blocked" : "waiting";
  };
  const prior = ports.db.prepare("SELECT state, claimed_at FROM agency_host_retry WHERE attempt_id = ? AND turn_request_id = ?")
    .get(attempt.id, requestId) as { state: string; claimed_at: string } | undefined;
  if (prior) {
    if (Date.parse(now) - Date.parse(prior.claimed_at) < 60_000) return "waiting";
    return block("same_failure_after_retry");
  }
  // Synchronous durable claim: competing watchers cannot both dispatch.
  const claim = ports.db.transaction(() => {
    const n = (ports.db.prepare("SELECT COUNT(*) AS n FROM agency_host_retry WHERE attempt_id = ?").get(attempt.id) as { n: number }).n;
    if (n >= 2) return "limit";
    return ports.db.prepare("INSERT OR IGNORE INTO agency_host_retry (attempt_id,turn_request_id,job_id,error_seq,state,claimed_at) VALUES (?,?,?,?, 'claimed',?)")
      .run(attempt.id, requestId, job!.id, errorSeq, now).changes ? "claimed" : "existing";
  })();
  if (claim === "limit") return block("third_host_disconnect");
  if (claim !== "claimed") return "waiting";
  event("claimed");
  let result: Awaited<ReturnType<HostReconnectPorts["retry"]>>;
  try {
    result = await ports.retry(row.threadId, requestId);
  } catch {
    ports.db.prepare("UPDATE agency_host_retry SET state = 'uncertain' WHERE attempt_id = ? AND turn_request_id = ?").run(attempt.id, requestId);
    event("uncertain");
    // Another caller/core may have resumed it, or the host may have disconnected
    // after the check. Leave a minute for reconciliation; never duplicate the call.
    return "waiting";
  }
  ports.db.prepare("UPDATE agency_host_retry SET state = 'confirmed', delivery = ? WHERE attempt_id = ? AND turn_request_id = ?")
    .run(result.delivery, attempt.id, requestId);
  event(result.delivery);
  ports.comment(job, agencyLanguage() === "en"
    ? `Agency: host connection restored. BB retry for turn ${requestId}: ${result.delivery}; same thread ${row.threadId} and attempt ${attempt.id} retained.`
    : `Агентство: связь с хостом восстановлена. Штатный BB retry для хода ${requestId}: ${result.delivery}; прежние тред ${row.threadId} и попытка ${attempt.id} сохранены.`);
  return "retried";
}
