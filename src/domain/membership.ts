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
