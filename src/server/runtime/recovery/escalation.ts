import type { Activity, Job } from "../../../shared/contracts";
import type { SqlDatabase } from "../../db/sql";
import type { DomainStore } from "../../services/domain-store";
import type { ServiceContext } from "../../services/context";
import { uuidV5 } from "../launch/operation-ids";
import { recordTrace } from "../trace/store";

export const RECOVERY_TRIAGE_MIGRATION = `CREATE TABLE agency_recovery_triage (
 job_id TEXT PRIMARY KEY REFERENCES agency_job(id), lead_job_id TEXT NOT NULL REFERENCES agency_job(id)
);`;

/** No live parent is not a reason to silently drop an incident. Give the department lead real work. */
export function ensureRecoveryTriage(db: SqlDatabase, store: DomainStore, ctx: ServiceContext, job: Job, activity: Activity, en: boolean): Job | null {
  const previous = db.prepare("SELECT lead_job_id FROM agency_recovery_triage WHERE job_id = ?").get(job.id) as { lead_job_id: string } | undefined;
  const previousJob = previous ? store.getJob(previous.lead_job_id) : undefined;
  if (previousJob && !["done", "canceled"].includes(previousJob.state)) return previousJob;
  const department = db.prepare("SELECT lead_agent_id FROM agency_department WHERE id = ?").get(job.departmentId) as { lead_agent_id: string } | undefined;
  // A lead cannot self-authorize a failing lead task: the existing owner/unreachable escalation handles it.
  if (!department || department.lead_agent_id === job.assignedAgentId) return null;
  const created = store.createJob(ctx, {
    requestId: uuidV5("4ce756f9-30b7-4eae-923c-d5150ca2a967", `recovery:${job.id}:${activity.id}`),
    bindingId: job.bindingId, departmentId: job.departmentId, parentJobId: null,
    assignedAgentId: department.lead_agent_id, priority: "high", dueAt: null,
    title: en ? `Resolve the blocker in ${job.key}` : `Устранить блокировку ${job.key}`,
    brief: `${activity.comment}\n\nOriginal job: ${job.key} (${job.id}). Read getJob and listJobAttempts; preserve this job and its evidence. You are receiving this incident because no active parent thread could receive it. Do not create a replacement of the original result. Diagnose and repair the cause, then use job recover with the current expectedRevision.`,
    acceptance: en ? "Cause and repair recorded with verified evidence; original job resumed through job recover; reusable lesson saved after verification. Review code repairs independently."
      : "Причина и исправление записаны с проверенными доказательствами; исходная задача возобновлена через job recover; подтверждённый урок сохранён. Изменения кода проверены независимо.",
  });
  if (!created.ok) {
    recordTrace(db, { jobId: job.id, step: "lead.recovery", outcome: "failed", reason: created.error.code });
    return null;
  }
  db.prepare("INSERT OR REPLACE INTO agency_recovery_triage(job_id,lead_job_id) VALUES (?,?)").run(job.id, created.value.id);
  recordTrace(db, { jobId: job.id, relatedJobId: created.value.id, step: "lead.recovery", outcome: "succeeded", reason: "triage_created", requestId: activity.id });
  return created.value;
}
