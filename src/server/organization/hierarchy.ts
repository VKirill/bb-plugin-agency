import { fail, ok, type DomainResult } from "../../domain";
import type { SqlDatabase } from "../db/sql";
import { agencyLanguage } from "../i18n/language.js";

/**
 * Department hierarchy and escalation. A department may report to a parent
 * department. A main job of a child department that stays in «Needs decision»
 * longer than the department's `escalateAfterHours` is escalated once: the
 * parent department sees it on its board and the job history says why.
 */

export const HIERARCHY_MIGRATION = `CREATE TABLE agency_department_parent (
    department_id TEXT PRIMARY KEY,
    parent_department_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
CREATE TABLE agency_escalation (
    job_id TEXT NOT NULL,
    blocked_since TEXT NOT NULL,
    to_department_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    PRIMARY KEY (job_id, blocked_since)
  )`;

export function departmentParents(db: SqlDatabase): Record<string, string> {
  return Object.fromEntries(
    (db.prepare(`SELECT department_id, parent_department_id FROM agency_department_parent`).all() as { department_id: string; parent_department_id: string }[]).map((row) => [
      row.department_id,
      row.parent_department_id,
    ]),
  );
}

export function setDepartmentParent(db: SqlDatabase, input: { departmentId: string; parentDepartmentId: string | null }, now: string): DomainResult<{ departmentId: string; parentDepartmentId: string | null }> {
  const exists = (id: string) => Boolean(db.prepare(`SELECT 1 FROM agency_department WHERE id = ?`).get(id));
  if (!exists(input.departmentId)) return fail("not_found", `department ${input.departmentId} not found`);
  if (input.parentDepartmentId === null) {
    db.prepare(`DELETE FROM agency_department_parent WHERE department_id = ?`).run(input.departmentId);
    return ok({ departmentId: input.departmentId, parentDepartmentId: null });
  }
  if (!exists(input.parentDepartmentId)) return fail("not_found", `department ${input.parentDepartmentId} not found`);
  // No cycles: walking up from the new parent must never reach the department itself.
  const parents = departmentParents(db);
  let cursor: string | undefined = input.parentDepartmentId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    if (cursor === input.departmentId) return fail("department_cycle", "Отдел не может подчиняться сам себе или своему подчинённому.");
    seen.add(cursor);
    cursor = parents[cursor];
  }
  db.prepare(
    `INSERT INTO agency_department_parent (department_id, parent_department_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(department_id) DO UPDATE SET parent_department_id = excluded.parent_department_id, updated_at = excluded.updated_at`,
  ).run(input.departmentId, input.parentDepartmentId, now);
  return ok({ departmentId: input.departmentId, parentDepartmentId: input.parentDepartmentId });
}

export type EscalationPorts = {
  db: SqlDatabase;
  escalateAfterHours: (departmentId: string) => number;
  comment: (jobId: string, text: string) => void;
  now: () => Date;
};

/** When the job entered its current blocked state: the latest transition to blocked. */
function blockedSince(db: SqlDatabase, jobId: string): string | null {
  const row = db
    .prepare(
      `SELECT timestamp FROM agency_activity WHERE job_id = ? AND kind = 'job_transitioned' AND references_json LIKE '%"id":"blocked"%'
       ORDER BY timestamp DESC LIMIT 1`,
    )
    .get(jobId) as { timestamp: string } | undefined;
  return row?.timestamp ?? null;
}

export function sweepEscalations(ports: EscalationPorts): number {
  const parents = departmentParents(ports.db);
  if (!Object.keys(parents).length) return 0;
  const now = ports.now();
  // A job that left «Needs decision» closes its escalation.
  ports.db.prepare(
    `UPDATE agency_escalation SET resolved_at = ? WHERE resolved_at IS NULL AND job_id IN (SELECT id FROM agency_job WHERE state != 'blocked')`,
  ).run(now.toISOString());
  const jobs = ports.db
    .prepare(`SELECT j.id, j.department_id, d.name AS department_name FROM agency_job j JOIN agency_department d ON d.id = j.department_id WHERE j.state = 'blocked' AND j.parent_job_id IS NULL`)
    .all() as { id: string; department_id: string; department_name: string }[];
  let escalated = 0;
  for (const job of jobs) {
    const parent = parents[job.department_id];
    const hours = ports.escalateAfterHours(job.department_id);
    if (!parent || hours <= 0) continue;
    const since = blockedSince(ports.db, job.id);
    if (!since || now.getTime() - Date.parse(since) < hours * 3_600_000) continue;
    const inserted = ports.db
      .prepare(`INSERT OR IGNORE INTO agency_escalation (job_id, blocked_since, to_department_id, created_at, resolved_at) VALUES (?, ?, ?, ?, NULL)`)
      .run(job.id, since, parent, now.toISOString());
    if (inserted.changes === 0) continue;
    const parentName = (ports.db.prepare(`SELECT name FROM agency_department WHERE id = ?`).get(parent) as { name: string } | undefined)?.name ?? parent;
    ports.comment(
      job.id,
      agencyLanguage() === "en"
        ? `Escalated to department «${parentName}»: the job has been waiting for a decision for more than ${hours} h.`
        : `Эскалировано в отдел «${parentName}»: задача ждёт решения дольше ${hours} ч.`,
    );
    escalated += 1;
  }
  return escalated;
}

/** Open escalations, by job id: the department the job was escalated to. */
export function openEscalations(db: SqlDatabase): Record<string, string> {
  return Object.fromEntries(
    (db.prepare(`SELECT job_id, to_department_id FROM agency_escalation WHERE resolved_at IS NULL`).all() as { job_id: string; to_department_id: string }[]).map((row) => [row.job_id, row.to_department_id]),
  );
}
