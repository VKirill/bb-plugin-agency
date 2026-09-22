import type { Activity, Job } from "../../../shared/contracts";
import type { DomainResult } from "../../../domain";
import type { SqlDatabase } from "../../db/sql";
import { recordTrace } from "../trace/store";

export const LAUNCH_ISSUE_MIGRATION = `CREATE TABLE agency_launch_issue (
  job_id TEXT PRIMARY KEY REFERENCES agency_job(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
  code TEXT NOT NULL, activity_id TEXT NOT NULL, activity_json TEXT NOT NULL, created_at TEXT NOT NULL
);`;
export const LEAD_ACTION_CODES = new Set(["spec_required", "owns_overlap", "catalog_skill_hash_mismatch", "loop_blocked", "rework_limit_reached"]);

export function launchIssueText(jobKey: string, code: string, en: boolean): string {
  const action = code === "spec_required"
    ? en ? "Read the source work and its published inputs. Attach the exact normative artifact/version/hash or add the required dependency. Do not rewrite an existing specification or create a replacement review."
      : "Прочитайте исходную работу и её опубликованные входы. Прикрепите точный нормативный артефакт/версию/hash либо добавьте нужную зависимость. Не переписывайте существующую спецификацию и не создавайте замену проверки."
    : code === "owns_overlap"
      ? en ? "Compare the active task contracts and file ownership. Sequence conflicting work or correct the ownership boundaries."
        : "Сопоставьте контракты активных задач и разрешённые пути. Разведите конфликтующие работы по времени или исправьте границы файлов."
      : en ? "Inspect launch readiness and the latest job history. Repair the department-owned contract or input; if a protected setting or engine defect prevents this, report the exact blocker."
        : "Проверьте готовность запуска и последние события задачи. Исправьте контракт или вход в пределах отдела; если мешает защищённая настройка или дефект движка, укажите конкретный блокер.";
  return en
    ? `${jobKey}: launch needs the lead's action (${code}). ${action} Keep the same job; verify readiness after the repair. The queue resumes automatically. Record the cause, correction and verification in the job. After a confirmed fix, save a reusable lesson in department knowledge; do not turn an unverified guess into a rule. Ask the owner only for changed requirements, access or authority outside this department.`
    : `${jobKey}: для запуска нужно действие руководителя (${code}). ${action} Сохраните эту задачу; после исправления проверьте готовность. Очередь продолжит запуск автоматически. Зафиксируйте причину, исправление и проверку в задаче. После подтверждения исправления сохраните повторно применимый урок в знаниях отдела; не превращайте непроверенную догадку в правило. Владелец нужен для изменения требований, доступа или полномочий вне отдела.`;
}

export function readLaunchIssue(db: SqlDatabase, jobId: string) {
  return db.prepare(`SELECT * FROM agency_launch_issue WHERE job_id = ?`).get(jobId) as
    { job_id: string; revision: number; code: string; activity_id: string; activity_json: string; created_at: string } | undefined;
}
export function resolveLaunchIssue(db: SqlDatabase, jobId: string): void {
  if (db.prepare(`DELETE FROM agency_launch_issue WHERE job_id = ?`).run(jobId).changes)
    recordTrace(db, { jobId, step: "lead.issue", outcome: "succeeded", reason: "condition_cleared" });
}

/** Published metadata is a pointer, not a new instruction or an automatic acceptance. */
function inputPointers(db: SqlDatabase, job: Job, en: boolean): string {
  const rows = db.prepare(`SELECT DISTINCT j.key AS sourceKey, i.source_job_id AS sourceJobId,
      i.artifact_id AS artifactId, i.version, i.hash, v.relative_path AS path
    FROM agency_job_input_ref i JOIN agency_job j ON j.id = i.source_job_id
      JOIN agency_artifact_version v ON v.artifact_id = i.artifact_id AND v.version = i.version AND v.hash = i.hash
    WHERE i.target_job_id IN (?, ?, (SELECT job_id FROM agency_auto_review WHERE review_job_id = ? LIMIT 1)) LIMIT 12`)
    .all(job.id, job.parentJobId, job.id);
  if (!rows.length) return "";
  return `\n${en ? "Known published inputs from this job, its source work and parent (metadata only; verify which version meets the gate):" : "Известные опубликованные входы задачи, исходной работы и родителя (только указатели; проверьте, какая версия удовлетворяет допуску):"}\n${rows.map(row => JSON.stringify(row)).join("\n")}`;
}

/** Durable incident, one activity per unchanged condition. Repeated sweeps only retry delivery/reconciliation. */
export function ensureLaunchIssue(db: SqlDatabase, job: Job, code: string, now: string,
  create: (text: string) => DomainResult<Activity>, en: boolean): Activity | null {
  if (!LEAD_ACTION_CODES.has(code)) return null;
  const previous = readLaunchIssue(db, job.id);
  if (previous?.code === code && previous.revision === job.revision) return JSON.parse(previous.activity_json) as Activity;
  return db.transaction(() => {
    const result = create(launchIssueText(job.key, code, en) + inputPointers(db, job, en));
    if (!result.ok) { recordTrace(db, { jobId: job.id, step: "lead.issue", outcome: "failed", reason: result.error.code }); return null; }
    db.prepare(`INSERT OR REPLACE INTO agency_launch_issue (job_id, revision, code, activity_id, activity_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(job.id, job.revision, code, result.value.id, JSON.stringify(result.value), now);
    recordTrace(db, { jobId: job.id, relatedJobId: job.parentJobId, step: "lead.issue", outcome: "blocked", reason: code, requestId: result.value.id });
    return result.value;
  })();
}
