import { evaluateSpecGate, type SpecGateInput, type SpecGateReason, type SpecGateResult } from "../../domain/spec-gate";
import { fail, ok, type DomainResult } from "../../domain";
import type { Job } from "../../shared/contracts";
import type { WorkRules } from "../../shared/contracts/work-rules";
import type { SqlDatabase } from "../db/sql";
import { acceptedVersions, dependencyLinks } from "./service";

type JobWalkRow = {
  id: string;
  key: string;
  department_id: string;
  parent_job_id: string | null;
  state: string;
  work_kind: string | null;
};

function normalizeSpecDepartmentId(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length ? trimmed : null;
}

function normalizeGatedDepartmentIds(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
}

function readJobRow(db: SqlDatabase, jobId: string): JobWalkRow | undefined {
  return db
    .prepare(`SELECT id, key, department_id, parent_job_id, state, work_kind FROM agency_job WHERE id = ?`)
    .get(jobId) as JobWalkRow | undefined;
}

/** Walks to the tree root; a cycle stops at the last unseen parent. */
export function resolveRootJobId(db: SqlDatabase, jobId: string): string {
  let current = readJobRow(db, jobId);
  const seen = new Set<string>();
  while (current?.parent_job_id && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = readJobRow(db, current.parent_job_id);
    if (!parent) break;
    current = parent;
  }
  return current?.id ?? jobId;
}

function listTreeRows(db: SqlDatabase, rootId: string): JobWalkRow[] {
  return db
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT ? UNION SELECT j.id FROM agency_job j JOIN tree ON j.parent_job_id = tree.id
       )
       SELECT id, key, department_id, parent_job_id, state, work_kind
       FROM agency_job WHERE id IN (SELECT id FROM tree)`,
    )
    .all(rootId) as JobWalkRow[];
}

function listJobInputs(db: SqlDatabase, jobId: string): SpecGateInput["inputs"] {
  return (
    db
      .prepare(
        `SELECT source_job_id, artifact_id, version, hash FROM agency_job_input_ref WHERE target_job_id = ?`,
      )
      .all(jobId) as { source_job_id: string; artifact_id: string; version: number; hash: string }[]
  ).map((row) => ({
    sourceJobId: row.source_job_id,
    artifactId: row.artifact_id,
    version: row.version,
    hash: row.hash,
  }));
}

export function collectSpecGateInput(db: SqlDatabase, job: Pick<Job, "id" | "departmentId">, rules: WorkRules): {
  rootId: string;
  input: SpecGateInput;
} {
  const rootId = resolveRootJobId(db, job.id);
  const root = readJobRow(db, rootId);
  const specDepartmentId = normalizeSpecDepartmentId(rules.specDepartmentId);
  const tree = listTreeRows(db, rootId);
  const specJobs = specDepartmentId
    ? tree
        .filter((row) => row.department_id === specDepartmentId)
        .map((row) => ({
          id: row.id,
          state: row.state,
          accepted: acceptedVersions(db, row.id),
        }))
    : [];
  return {
    rootId,
    input: {
      rootWorkKind: root?.work_kind ?? null,
      jobDepartmentId: job.departmentId,
      specDepartmentId,
      gatedDepartmentIds: normalizeGatedDepartmentIds(rules.specGatedDepartmentIds),
      specJobs,
      inputs: listJobInputs(db, job.id),
      waitsFor: dependencyLinks(db, job.id).waitsFor.map((link) => link.jobId),
    },
  };
}

export function inspectSpecGate(db: SqlDatabase, job: Pick<Job, "id" | "departmentId">, rules: WorkRules): {
  rootId: string;
  result: SpecGateResult;
} {
  const collected = collectSpecGateInput(db, job, rules);
  return { rootId: collected.rootId, result: evaluateSpecGate(collected.input) };
}

function specRequiredMessage(reason: SpecGateReason, en: boolean): string {
  if (reason === "no_spec_job") {
    return en
      ? "spec_required (no_spec_job): create a job in the spec department, wait until it is accepted, then attach the accepted version (attach-input) or set job depend."
      : "spec_required (no_spec_job): создайте задачу в отделе спецификаций, дождитесь приёмки, затем приложите принятую версию (attach-input) или поставьте job depend.";
  }
  if (reason === "spec_not_accepted") {
    return en
      ? "spec_required (spec_not_accepted): wait until the spec job is done with an accepted version, then attach that version (attach-input) or set job depend."
      : "spec_required (spec_not_accepted): дождитесь приёмки задачи спецификаций, затем приложите принятую версию (attach-input) или поставьте job depend.";
  }
  return en
    ? "spec_required (spec_not_linked): attach the accepted spec version (attach-input) or set job depend."
    : "spec_required (spec_not_linked): приложите принятую версию спецификации (attach-input) или поставьте job depend.";
}

export function specIntakeViolationComment(jobKey: string, reason: SpecGateReason, en: boolean): string {
  const action =
    reason === "no_spec_job"
      ? en
        ? "Create a job in the spec department, wait until it is accepted, then attach-input or job depend."
        : "Создайте задачу в отделе спецификаций, дождитесь приёмки, затем attach-input или job depend."
      : en
        ? "Wait until the spec job is done with an accepted version, then attach-input or job depend."
        : "Дождитесь приёмки задачи спецификаций, затем attach-input или job depend.";
  return `intake_violation=spec-before-code\n${jobKey}: ${reason}. ${action}`;
}

export function assertSpecAccepted(
  db: SqlDatabase,
  job: Pick<Job, "id" | "departmentId">,
  rules: WorkRules,
  en: boolean,
): DomainResult<true> {
  const { result } = inspectSpecGate(db, job, rules);
  if (!result.required || result.satisfied) return ok(true);
  return fail("spec_required", specRequiredMessage(result.reason, en));
}
