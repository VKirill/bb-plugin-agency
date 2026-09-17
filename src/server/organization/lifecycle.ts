import { fail, ok, type DomainResult } from "../../domain";
import type { SqlDatabase } from "../db/sql";

/**
 * The owner shapes the organization freely: a department or an employee that is not
 * needed goes to the archive (history stays, no new work), or is deleted outright when
 * it never took part in any work. Nothing with history is ever deleted.
 */

export const DEPARTMENT_ARCHIVE_MIGRATION = `ALTER TABLE agency_department ADD COLUMN archived_at TEXT`;

function tableExists(db: SqlDatabase, name: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

const count = (db: SqlDatabase, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;

export function departmentArchivedAt(db: SqlDatabase, departmentId: string): string | null {
  const row = db.prepare(`SELECT archived_at FROM agency_department WHERE id = ?`).get(departmentId) as { archived_at: string | null } | undefined;
  return row?.archived_at ?? null;
}

/** Archive: the department leaves routing, forms and pickers; its jobs and history stay. */
export function archiveDepartment(db: SqlDatabase, departmentId: string, now: string, en: boolean): DomainResult<{ archivedAt: string }> {
  if (!db.prepare(`SELECT 1 FROM agency_department WHERE id = ?`).get(departmentId)) return fail("not_found", `department ${departmentId} not found`);
  const open = count(db, `SELECT COUNT(*) AS n FROM agency_job WHERE department_id = ? AND state NOT IN ('done', 'canceled')`, departmentId);
  if (open) {
    return fail(
      "department_has_open_jobs",
      en ? `The department has ${open} open jobs: finish, cancel or move them first.` : `У отдела открытых задач: ${open}. Завершите, отмените или перенесите их.`,
    );
  }
  db.prepare(`UPDATE agency_department SET archived_at = ? WHERE id = ?`).run(now, departmentId);
  return ok({ archivedAt: now });
}

export function restoreDepartment(db: SqlDatabase, departmentId: string): DomainResult<true> {
  const changed = db.prepare(`UPDATE agency_department SET archived_at = NULL WHERE id = ?`).run(departmentId).changes;
  return changed ? ok(true) : fail("not_found", `department ${departmentId} not found`);
}

/** A department is deletable when no job ever belonged to it and no department reports to it. */
export function departmentDeleteBlocker(db: SqlDatabase, departmentId: string, en: boolean): string | null {
  const jobs = count(db, `SELECT COUNT(*) AS n FROM agency_job WHERE department_id = ?`, departmentId);
  if (jobs) return en ? `The department has ${jobs} jobs in its history: archive it instead.` : `У отдела есть история задач (${jobs}): отправьте его в архив.`;
  if (tableExists(db, "agency_department_parent") && count(db, `SELECT COUNT(*) AS n FROM agency_department_parent WHERE parent_department_id = ?`, departmentId)) {
    return en ? "Other departments report to this one: change their parent first." : "Этому отделу подчиняются другие: сначала смените им вышестоящий отдел.";
  }
  if (tableExists(db, "agency_escalation") && count(db, `SELECT COUNT(*) AS n FROM agency_escalation WHERE to_department_id = ?`, departmentId)) {
    return en ? "Jobs were escalated to this department: archive it instead." : "В этот отдел эскалировались задачи: отправьте его в архив.";
  }
  return null;
}

/** Deletes a department without history, with its versions, members and links. Employees stay. */
export function deleteDepartment(db: SqlDatabase, departmentId: string, en: boolean): DomainResult<true> {
  if (!db.prepare(`SELECT 1 FROM agency_department WHERE id = ?`).get(departmentId)) return fail("not_found", `department ${departmentId} not found`);
  const blocker = departmentDeleteBlocker(db, departmentId, en);
  if (blocker) return fail("department_has_history", blocker);
  db.transaction(() => {
    db.pragma("defer_foreign_keys = ON");
    db.prepare(`DELETE FROM agency_membership WHERE department_id = ?`).run(departmentId);
    db.prepare(`DELETE FROM agency_project_department WHERE department_id = ?`).run(departmentId);
    if (tableExists(db, "agency_department_parent")) db.prepare(`DELETE FROM agency_department_parent WHERE department_id = ?`).run(departmentId);
    if (tableExists(db, "agency_work_rules")) db.prepare(`DELETE FROM agency_work_rules WHERE scope = ?`).run(`department:${departmentId}`);
    if (tableExists(db, "agency_kit_record")) db.prepare(`DELETE FROM agency_kit_record WHERE record_kind = 'department' AND record_id = ?`).run(departmentId);
    db.prepare(`DELETE FROM agency_department WHERE id = ?`).run(departmentId);
    db.prepare(`DELETE FROM agency_process_version WHERE department_id = ?`).run(departmentId);
  })();
  return ok(true);
}

/** An employee is deletable when it never had a job, a launch or a lead position. */
export function agentDeleteBlocker(db: SqlDatabase, agentId: string, en: boolean): string | null {
  const lead = db.prepare(`SELECT name FROM agency_department WHERE lead_agent_id = ?`).get(agentId) as { name: string } | undefined;
  if (lead) return en ? `The employee leads «${lead.name}»: choose another lead first.` : `Сотрудник руководит отделом «${lead.name}»: сначала назначьте другого руководителя.`;
  const pattern = `%"${agentId}"%`;
  const history =
    count(db, `SELECT COUNT(*) AS n FROM agency_job WHERE assigned_agent_id = ? OR reviewer_agent_ids LIKE ? OR observer_agent_ids LIKE ?`, agentId, pattern, pattern) +
    count(db, `SELECT COUNT(*) AS n FROM agency_context_snapshot WHERE snapshot_json LIKE ?`, pattern) +
    count(db, `SELECT COUNT(*) AS n FROM agency_activity WHERE actor LIKE ?`, pattern);
  if (history) return en ? "The employee has work history: archive them instead." : "У сотрудника есть история работы: отправьте его в архив.";
  return null;
}

/** Deletes an employee without history, with its versions, memberships and own rules. */
export function deleteAgent(db: SqlDatabase, agentId: string, en: boolean): DomainResult<true> {
  if (!db.prepare(`SELECT 1 FROM agency_agent WHERE id = ?`).get(agentId)) return fail("not_found", `agent ${agentId} not found`);
  const blocker = agentDeleteBlocker(db, agentId, en);
  if (blocker) return fail("agent_has_history", blocker);
  db.transaction(() => {
    db.pragma("defer_foreign_keys = ON");
    db.prepare(`DELETE FROM agency_membership WHERE agent_id = ?`).run(agentId);
    if (tableExists(db, "agency_work_rules")) db.prepare(`DELETE FROM agency_work_rules WHERE scope = ?`).run(`agent:${agentId}`);
    if (tableExists(db, "agency_kit_record")) db.prepare(`DELETE FROM agency_kit_record WHERE record_kind = 'agent' AND record_id = ?`).run(agentId);
    db.prepare(`DELETE FROM agency_agent WHERE id = ?`).run(agentId);
    db.prepare(`DELETE FROM agency_agent_version WHERE agent_id = ?`).run(agentId);
  })();
  return ok(true);
}
