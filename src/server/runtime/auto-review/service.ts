import { recordTrace } from "../trace/store";
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

export type AutoReviewOutcome = "skipped" | "pending" | "created" | "failed" | "manual";

export function reviewJobText(job: Pick<Job, "key" | "title">, version: HandedInVersion, lang = agencyLanguage()) {
  const title = `${lang === "en" ? "Review" : "Проверка"} ${job.key}: ${job.title}`.slice(0, 180);
  if (lang === "en") {
    return {
      title,
      brief: `Independent review of version v${version.version} of ${job.key} «${job.title}» against its acceptance criteria. The version is attached as input: open it by hash, do not trust working files.\nDo not fix the result: describe defects (criterion → place → how to reproduce → severity). On rework, retain valid evidence for passed unaffected criteria; check the changed code and related regressions. Explain any full scenario rerun. Do not introduce new wishes as blockers; resolve contradictory criteria with the lead.`,
      acceptance: `The review report is published as a version. First line of both the report and the job submit comment: Verdict: accept or Verdict: rework. Then every acceptance criterion of ${job.key} marked passed / failed / not checked with the command or place.`,
    };
  }
  return {
    title,
    brief: `Независимая проверка версии v${version.version} результата ${job.key} «${job.title}» по её критериям приёмки. Версия приложена входом: открывайте её по hash, рабочим файлам на слово не верьте.\nРезультат не правьте: описывайте дефекты (критерий → место → как воспроизвести → серьёзность). При доработке сохраняйте действительные доказательства по принятым незатронутым критериям; проверьте изменения и связанные регрессии. Обоснуйте полный повтор сценария. Новые пожелания не становятся блокерами; противоречие критериев сначала разрешает руководитель.`,
    acceptance: `Заключение опубликовано версией. Первая строка отчёта и итогового комментария задачи: Вердикт: принять или Вердикт: доработать. Затем каждый критерий приёмки ${job.key} — пройден / не пройден / не проверен с командой или местом.`,
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
    recordTrace(ports.db, { jobId, step: "review.create", outcome: "failed", reason: "creation_or_input_failed", artifactHash: version.hash });
    finish("failed", null);
    ports.comment(
      job,
      en
        ? `Automatic review was not created: ${reason}. The lead assigns the review.`
        : `Автопроверка не создана: ${reason}. Проверку назначит руководитель.`,
    );
    return "failed";
  };
  // A lead may arrange predeploy → final review before the author's hand-in.
  // Input provenance establishes a possible overlap, not authority to adopt its old verdict.
  // Keep the existing station; the lead resolves the exact final version after independent acceptance.
  const assigned = ports.db.prepare(`SELECT DISTINCT r.id, r.key FROM agency_job r
    JOIN agency_membership m ON m.department_id = r.department_id AND m.agent_id = r.assigned_agent_id
    JOIN agency_job_input_ref i ON i.target_job_id = r.id AND i.source_job_id = ?
    WHERE r.parent_job_id = ? AND r.binding_id = ? AND r.department_id = ?
      AND r.assigned_agent_id != ? AND m.role = 'reviewer'
      AND (r.state IN ('backlog','queued','running','waiting_input','blocked','review') OR
        (r.state = 'done' AND i.artifact_id = ? AND i.version = ? AND i.hash = ?
          AND i.created_at <= (SELECT MAX(timestamp) FROM agency_activity WHERE job_id = r.id AND kind = 'artifact_published')))
      AND NOT EXISTS (SELECT 1 FROM agency_auto_review a WHERE a.review_job_id = r.id AND a.job_id != ?)
    ORDER BY r.id`).all(job.id, job.parentJobId ?? job.id, job.bindingId, job.departmentId, job.assignedAgentId,
      version.artifactId, version.version, version.hash, job.id) as Array<{ id: string; key: string }>;
  if (assigned.length) {
    // Do not choose between multiple reviewers or hand work to a blocked/closed thread.
    // No auto-review association is created: that would allow a partial predeploy verdict to accept the product.
    if (assigned.length === 1) {
      const existingReview = ports.getJob(assigned[0]!.id);
      if (existingReview && !["done", "canceled"].includes(existingReview.state)) {
        const attached = await ports.attachInput(existingReview, job, version);
        if (!attached.ok) return failWith(attached.error.message); // Preserve the existing station on failure.
      }
    }
    finish("manual", null);
    recordTrace(ports.db, { jobId, step: "review.create", outcome: "waiting", reason: "existing_review_requires_resolution",
      relatedJobId: assigned.length === 1 ? assigned[0]!.id : null, artifactHash: version.hash, facts: { count: assigned.length } });
    ports.comment(job, en
      ? `Existing review with inputs from this work: ${assigned.map(r => r.key).join(", ")}. No duplicate created. The lead selects the intended final review, attaches this exact artifact/version/hash BEFORE the final review report, and after its acceptance uses artifact accept with reviewResolution. An earlier predeploy verdict does not accept this version.`
      : `Уже есть проверка со входами этой работы: ${assigned.map(r => r.key).join(", ")}. Дубль не создан. Руководитель выбирает назначенную финальную проверку, прикладывает точный artifact/version/hash ДО её итогового отчёта, а после положительного заключения использует artifact accept с reviewResolution. Прежний predeploy-допуск не принимает эту версию.`);
    return "manual";
  }
  const review = ports.createReview(job, version);
  if (!review.ok) return failWith(review.error.message);
  const attached = await ports.attachInput(review.value, job, version);
  if (!attached.ok) {
    ports.discard(ports.getJob(review.value.id) ?? review.value);
    return failWith(attached.error.message);
  }
  // A reviewer needs the same normative inputs as the author, not only the hand-in.
  const inputs = ports.db.prepare(`SELECT source_job_id, artifact_id, version, hash FROM agency_job_input_ref WHERE target_job_id = ?`)
    .all(job.id) as Array<{ source_job_id: string; artifact_id: string; version: number; hash: string }>;
  for (const input of inputs) {
    const source = ports.getJob(input.source_job_id);
    if (!source) continue;
    const inherited = await ports.attachInput(ports.getJob(review.value.id) ?? review.value, source, {
      artifactId: input.artifact_id, version: input.version, hash: input.hash,
    });
    if (!inherited.ok) {
      ports.discard(ports.getJob(review.value.id) ?? review.value);
      return failWith(inherited.error.message);
    }
  }
  const queued = ports.queue(ports.getJob(review.value.id) ?? review.value);
  finish(queued.ok ? "queued" : "created", review.value.id);
  recordTrace(ports.db, { jobId, step: "review.create", outcome: queued.ok ? "succeeded" : "failed", reason: queued.ok ? "queued" : queued.error.code, relatedJobId: review.value.id, artifactHash: version.hash, facts: { count: inputs.length } });
  ports.comment(
    job,
    en
      ? `Automatic review: ${review.value.key} created for version v${version.version}${queued.ok ? " and queued for launch" : ""}.`
      : `Автопроверка: создана ${review.value.key} по версии v${version.version}${queued.ok ? ", проверка в очереди запуска" : ""}.`,
  );
  return "created";
}
