import { agencyLanguage, type AgencyLanguage } from "../../i18n/language.js";
import type { Job } from "../../../shared/contracts";
import type { SqlDatabase } from "../../db/sql";

/**
 * Due dates. Once per due date a job gets a «soon» reminder when it enters the
 * department's reminder window and an «overdue» one when the date passes: a
 * system comment in the job and, if an employee is working on it, a message to
 * that thread. A changed due date starts over.
 */

export const DUE_REMINDER_MIGRATION = `CREATE TABLE agency_due_reminder (
    job_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('soon', 'overdue')),
    due_at TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (job_id, kind, due_at)
  )`;

export const DUE_SWEEP_INTERVAL_MS = 60_000;

export type DueReminderKind = "soon" | "overdue";

export type DuePorts = {
  isActive?: () => boolean;
  db: SqlDatabase;
  /** Open jobs with a due date. */
  listDueJobs: () => Job[];
  /** Hours before the due date to remind; 0 turns the «soon» reminder off. */
  reminderHours: (job: Job) => number;
  comment: (job: Job, text: string) => boolean;
  /** Thread of a running attempt of the job, if any. */
  workingThread: (jobId: string) => string | null;
  send: (threadId: string, text: string) => Promise<unknown>;
  now: () => Date;
};

function hoursLeft(dueAt: string, now: Date): number {
  return Math.max(0, Math.ceil((Date.parse(dueAt) - now.getTime()) / 3_600_000));
}

function formatDue(dueAt: string, lang: AgencyLanguage): string {
  return new Date(dueAt).toLocaleString(lang === "en" ? "en-GB" : "ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function dueCommentText(kind: DueReminderKind, job: Pick<Job, "key" | "dueAt">, now: Date, lang: AgencyLanguage = agencyLanguage()): string {
  const due = formatDue(job.dueAt!, lang);
  if (lang === "en") {
    return kind === "soon"
      ? `Due ${due}: ${hoursLeft(job.dueAt!, now)} h left.`
      : `Due date ${due} has passed: the job is overdue.`;
  }
  return kind === "soon" ? `Срок ${due}: осталось ${hoursLeft(job.dueAt!, now)} ч.` : `Срок ${due} прошёл: задача просрочена.`;
}

export function dueThreadText(kind: DueReminderKind, job: Pick<Job, "key" | "dueAt">, now: Date, lang: AgencyLanguage = agencyLanguage()): string {
  if (lang === "en") {
    return kind === "soon"
      ? `Agency: ${hoursLeft(job.dueAt!, now)} h left until the due date of ${job.key}. If you will not make it, tell the lead now with a job comment: the reason and a new estimate.`
      : `Agency: the due date of ${job.key} has passed. Hand in what is ready as a version, or say in a job comment what remains and how much time it needs.`;
  }
  return kind === "soon"
    ? `Агентство: до срока ${job.key} осталось ${hoursLeft(job.dueAt!, now)} ч. Если не успеваете — сообщите руководителю сейчас комментарием к задаче: причина и новая оценка.`
    : `Агентство: срок ${job.key} прошёл. Сдайте готовое версией или напишите в комментарии к задаче, что осталось и сколько времени нужно.`;
}

/** Which reminder a job needs now, if any. */
export function dueReminderFor(job: Pick<Job, "dueAt">, hours: number, now: Date): DueReminderKind | null {
  if (!job.dueAt) return null;
  const due = Date.parse(job.dueAt);
  if (Number.isNaN(due)) return null;
  if (now.getTime() >= due) return "overdue";
  if (hours > 0 && now.getTime() >= due - hours * 3_600_000) return "soon";
  return null;
}

function alreadySent(db: SqlDatabase, jobId: string, kind: DueReminderKind, dueAt: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM agency_due_reminder WHERE job_id = ? AND kind = ? AND due_at = ?`).get(jobId, kind, dueAt));
}

export async function sweepDueReminders(ports: DuePorts): Promise<number> {
  if (ports.isActive?.() === false || !ports.db.open) return 0;
  const now = ports.now();
  let sent = 0;
  for (const job of ports.listDueJobs()) {
    if (ports.isActive?.() === false || !ports.db.open) return sent;
    const kind = dueReminderFor(job, ports.reminderHours(job), now);
    if (!kind || !job.dueAt) continue;
    if (alreadySent(ports.db, job.id, kind, job.dueAt)) continue;
    ports.db
      .prepare(`INSERT INTO agency_due_reminder (job_id, kind, due_at, sent_at) VALUES (?, ?, ?, ?)`)
      .run(job.id, kind, job.dueAt, now.toISOString());
    ports.comment(job, dueCommentText(kind, job, now));
    const thread = ports.workingThread(job.id);
    if (thread) await ports.send(thread, dueThreadText(kind, job, now)).catch(() => undefined);
    sent += 1;
  }
  return sent;
}
