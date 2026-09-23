import { fail, ok, type DomainResult } from "../../../domain";
import type { Job } from "../../../shared/contracts";
import { assertRecoveryAuthority } from "../recovery/authorization.js";
import { latestHandedInVersion, type AcceptInput, type ClosePorts } from "./station.js";
import { latestReviewText, parseReviewVerdict } from "./verdict.js";

/** Explicit lead/owner resolution of an advisory hold or a failed automatic QC handoff.
 * The manual review must already have examined precisely this version; attaching it
 * after the report or merely mentioning its key is not evidence of a review.
 */
export function validateReviewResolution(ports: ClosePorts, job: Job, input: AcceptInput): DomainResult<true> {
  const authority = assertRecoveryAuthority(ports.db, ports.ctx, job);
  if (!authority.ok) return authority;
  const refuse = () => fail("review_resolution_invalid", "A completed independent review of this exact latest version is required; active QC cannot be replaced.");
  const version = latestHandedInVersion(ports.db, job.id);
  if (!version || version.artifactId !== input.artifactId || version.version !== input.version || version.hash !== input.hash) return refuse();
  const review = input.reviewResolution ? ports.store.getJob(input.reviewResolution.reviewJobId) : undefined;
  if (!review || review.state !== "done" || review.departmentId !== job.departmentId || review.bindingId !== job.bindingId ||
    review.parentJobId !== (job.parentJobId ?? job.id) || !review.assignedAgentId || review.assignedAgentId === job.assignedAgentId) return refuse();
  const member = ports.db.prepare("SELECT role FROM agency_membership WHERE department_id = ? AND agent_id = ?")
    .get(job.departmentId, review.assignedAgentId) as { role: string } | undefined;
  if (member?.role !== "reviewer" || !latestHandedInVersion(ports.db, review.id) || parseReviewVerdict(latestReviewText(ports.db, review.id)) !== "accept") return refuse();
  const pinned = ports.db.prepare(`SELECT 1 FROM agency_job_input_ref i WHERE i.target_job_id = ? AND i.source_job_id = ?
    AND i.artifact_id = ? AND i.version = ? AND i.hash = ? AND i.created_at <=
      COALESCE((SELECT MAX(timestamp) FROM agency_activity WHERE job_id = ? AND kind = 'artifact_published'),
        (SELECT a.created_at FROM agency_artifact_version v JOIN agency_run_attempt a ON a.id = json_extract(v.author, '$.runId')
          WHERE v.job_id = ? ORDER BY v.rowid DESC LIMIT 1))`)
    .get(review.id, job.id, input.artifactId, input.version, input.hash, review.id, review.id);
  if (!pinned) return refuse();
  // Reject also when the reviewed version was authored through another job.
  const selfAuthored = ports.db.prepare(`SELECT 1 FROM agency_artifact_version v
    JOIN agency_run_attempt a ON a.id = json_extract(v.author, '$.runId') JOIN agency_job j ON j.id = a.job_id
    WHERE v.artifact_id = ? AND v.version = ? AND j.assigned_agent_id = ?`)
    .get(input.artifactId, input.version, review.assignedAgentId);
  if (selfAuthored) return refuse();
  const claim = ports.db.prepare("SELECT review_job_id FROM agency_auto_review WHERE job_id = ? AND hash = ?")
    .get(job.id, input.hash) as { review_job_id: string | null } | undefined;
  const active = claim?.review_job_id ? ports.store.getJob(claim.review_job_id) : undefined;
  if (active && active.id !== review.id && !["done", "canceled", "blocked"].includes(active.state)) return refuse();
  return ok(true);
}
