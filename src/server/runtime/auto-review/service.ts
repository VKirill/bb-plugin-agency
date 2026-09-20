import type { DomainResult } from "../../../domain";
import type { Job } from "../../../shared/contracts";
import type { SqlDatabase } from "../../db/sql";
import { agencyLanguage } from "../../i18n/language.js";

/**
 * Executor → reviewer chain. When a department has «Проверка создаётся
 * автоматически», an executor's hand-in (the job enters review) creates a review
 * subtask next to it, assigns the least loaded reviewer, attaches the handed-in
 * version and puts the review into the launch queue. One review per version.
 */

export const AUTO_REVIEW_MIGRATION = `CREATE TABLE agency_auto_review (
    job_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    review_job_id TEXT,
    outcome TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (job_id, hash)
  )`;

export type HandedInVersion = { artifactId: string; version: number; hash: string };

export type AutoReviewPorts = {
  db: SqlDatabase;
  getJob: (jobId: string) => Job | undefined;
  enabled: (job: Job) => boolean;
  memberRole: (departmentId: string, agentId: string) => string | null;
  latestVersion: (jobId: string) => HandedInVersion | null;
  createReview: (job: Job, version: HandedInVersion) => DomainResult<Job>;
  attachInput: (review: Job, job: Job, version: HandedInVersion) => Promise<DomainResult<unknown>>;
  queue: (review: Job) => DomainResult<unknown>;
  /** Cancels a review job that could not get its input: no half-made review stays on the board. */
  discard: (review: Job) => void;
  comment: (job: Job, text: string) => boolean;
  now: () => string;
};

export type AutoReviewOutcome = "skipped" | "pending" | "created" | "failed";

export function reviewJobText(job: Pick<Job, "key" | "title">, version: HandedInVersion, lang = agencyLanguage()) {
  const title = `${lang === "en" ? "Review" : "Проверка"} ${job.key}: ${job.title}`.slice(0, 180);
  if (lang === "en") {
    return {
      title,
      brief: `Independent review of version v${version.version} of ${job.key} «${job.title}» against its acceptance criteria. The version is attached as input: open it by hash, do not trust working files.\nDo not fix the result: describe defects (criterion → place → how to reproduce → severity).`,
      acceptance: `The review report is published as a version. First line: Verdict: accept or Verdict: rework. Then every acceptance criterion of ${job.key} marked passed / failed / not checked with the command or place.`,
    };
  }
  return {
    title,
    brief: `Независимая проверка версии v${version.version} результата ${job.key} «${job.title}» по её критериям приёмки. Версия приложена входом: открывайте её по hash, рабочим файлам на слово не верьте.\nРезультат не правьте: описывайте дефекты (критерий → место → как воспроизвести → серьёзность).`,
    acceptance: `Заключение опубликовано версией. Первая строка: Вердикт: принять или Вердикт: доработать. Затем каждый критерий приёмки ${job.key} — пройден / не пройден / не проверен с командой или местом.`,
  };
}

export async function startAutoReview(ports: AutoReviewPorts, jobId: string): Promise<AutoReviewOutcome> {
  const job = ports.getJob(jobId);
  if (!job || job.state !== "review" || !job.assignedAgentId) return "skipped";
  if (!ports.enabled(job)) return "skipped";
  // Only an executor's work is reviewed automatically; a lead's summary and a review verdict are not.
  if (ports.memberRole(job.departmentId, job.assignedAgentId) !== "executor") return "skipped";
  const version = ports.latestVersion(job.id);
  if (!version) return "skipped";
  const claimed = ports.db
    .prepare(`INSERT OR IGNORE INTO agency_auto_review (job_id, hash, review_job_id, outcome, created_at) VALUES (?, ?, NULL, 'pending', ?)`)
    .run(job.id, version.hash, ports.now());
  if (claimed.changes === 0) return "pending";
  const en = agencyLanguage() === "en";
  const finish = (outcome: string, reviewJobId: string | null) =>
    ports.db.prepare(`UPDATE agency_auto_review SET outcome = ?, review_job_id = ? WHERE job_id = ? AND hash = ?`).run(outcome, reviewJobId, job.id, version.hash);
  const failWith = (reason: string): AutoReviewOutcome => {
    finish("failed", null);
    ports.comment(
      job,
      en
        ? `Automatic review was not created: ${reason}. The lead assigns the review.`
        : `Автопроверка не создана: ${reason}. Проверку назначит руководитель.`,
    );
    return "failed";
  };
  const review = ports.createReview(job, version);
  if (!review.ok) return failWith(review.error.message);
  const attached = await ports.attachInput(review.value, job, version);
  if (!attached.ok) {
    ports.discard(ports.getJob(review.value.id) ?? review.value);
    return failWith(attached.error.message);
  }
  const queued = ports.queue(ports.getJob(review.value.id) ?? review.value);
  finish(queued.ok ? "queued" : "created", review.value.id);
  ports.comment(
    job,
    en
      ? `Automatic review: ${review.value.key} created for version v${version.version}${queued.ok ? " and queued for launch" : ""}.`
      : `Автопроверка: создана ${review.value.key} по версии v${version.version}${queued.ok ? ", проверка в очереди запуска" : ""}.`,
  );
  return "created";
}
