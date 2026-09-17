import type { Department, Membership } from "../shared/contracts";
import { fail, ok, type DomainResult } from "./result";

function pairKey(row: Membership): string {
  return `${row.departmentId}\0${row.agentId}`;
}

export function assertUniqueMemberships(rows: readonly Membership[]): DomainResult<readonly Membership[]> {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = pairKey(row);
    if (seen.has(key)) {
      return fail("membership_duplicate", `duplicate membership ${row.departmentId}+${row.agentId}`);
    }
    seen.add(key);
  }
  return ok(rows);
}

export function assertLeadInMembership(
  department: Department,
  rows: readonly Membership[],
): DomainResult<Department> {
  const unique = assertUniqueMemberships(rows);
  if (!unique.ok) return unique;
  const departmentRows = rows.filter((row) => row.departmentId === department.id);
  const leadRows = departmentRows.filter((row) => row.role === "lead");
  if (leadRows.length !== 1) {
    return fail("lead_role_conflict", `${department.id} must have exactly one lead membership`);
  }
  if (leadRows[0].agentId !== department.leadAgentId) {
    return fail("lead_role_conflict", `membership lead ${leadRows[0].agentId} != department.leadAgentId`);
  }
  return ok(department);
}

export function departmentsForAgent(
  agentId: string,
  rows: readonly Membership[],
): readonly string[] {
  return rows.filter((row) => row.agentId === agentId).map((row) => row.departmentId);
}

/** An employee can carry a few helpers, not a crowd: their work has to stay readable. */
export const ASSISTANTS_PER_EMPLOYEE = 3;

/**
 * Assistants of a department: each one helps a member of the same department (or nobody in
 * particular), the lead is not a helper, and one employee carries no more than three.
 */
export function assertAssistantLimits(
  candidate: Membership,
  rows: readonly Membership[],
): DomainResult<Membership> {
  const others = rows.filter((row) => row.departmentId === candidate.departmentId && row.agentId !== candidate.agentId);
  if (candidate.role !== "assistant") {
    if (candidate.helpsAgentId) {
      return fail("helps_not_assistant", "helpsAgentId belongs to an assistant membership");
    }
    // Someone else's helper points here: that employee must stay in the department.
    return ok(candidate);
  }
  if (candidate.helpsAgentId === candidate.agentId) {
    return fail("assistant_self_help", "an assistant cannot help themselves");
  }
  if (candidate.helpsAgentId) {
    const helped = others.find((row) => row.agentId === candidate.helpsAgentId);
    if (!helped) {
      return fail("helps_agent_not_in_department", `${candidate.helpsAgentId} is not a member of ${candidate.departmentId}`);
    }
    if (helped.role === "assistant") {
      return fail("assistant_helps_assistant", "an assistant cannot help another assistant");
    }
    const already = others.filter((row) => row.role === "assistant" && row.helpsAgentId === candidate.helpsAgentId).length;
    if (already >= ASSISTANTS_PER_EMPLOYEE) {
      return fail("assistant_limit_reached", `${candidate.helpsAgentId} already has ${ASSISTANTS_PER_EMPLOYEE} assistants`);
    }
  }
  return ok(candidate);
}
