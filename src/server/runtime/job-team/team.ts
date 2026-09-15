import { fail, ok, type DomainResult } from "../../../domain";
import { emptyJobTeamFields, jobTeamAgentIdsSchema, type JobTeamFields } from "../../../shared/contracts/job-team";

export function normalizeJobTeamIds(raw: unknown): DomainResult<string[]> {
  const parsed = jobTeamAgentIdsSchema.safeParse(raw ?? []);
  if (!parsed.success) return fail("invalid_command", parsed.error.message);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of parsed.data) {
    if (seen.has(id)) return fail("duplicate_team_agent", "job team agent ids must be unique in one role list");
    seen.add(id);
    ids.push(id);
  }
  return ok(ids);
}

export function effectiveJobTeamIds(
  current: readonly string[],
  patch: readonly string[] | undefined,
): readonly string[] {
  return patch === undefined ? current : patch;
}

export function assertJobTeamMembership(input: {
  departmentId: string;
  reviewerAgentIds: readonly string[];
  observerAgentIds: readonly string[];
  isMember: (departmentId: string, agentId: string) => boolean;
}): DomainResult<JobTeamFields> {
  const reviewers = normalizeJobTeamIds(input.reviewerAgentIds);
  if (!reviewers.ok) return reviewers;
  const observers = normalizeJobTeamIds(input.observerAgentIds);
  if (!observers.ok) return observers;
  for (const id of [...reviewers.value, ...observers.value]) {
    if (!input.isMember(input.departmentId, id)) {
      return fail("team_agent_not_member", "reviewer and observer agents must belong to the job department");
    }
  }
  return ok({ reviewerAgentIds: reviewers.value, observerAgentIds: observers.value });
}

export function jobTeamFromStored(row: {
  reviewerAgentIds?: readonly string[] | null;
  observerAgentIds?: readonly string[] | null;
}): JobTeamFields {
  const empty = emptyJobTeamFields();
  const reviewers = normalizeJobTeamIds(row.reviewerAgentIds ?? empty.reviewerAgentIds);
  const observers = normalizeJobTeamIds(row.observerAgentIds ?? empty.observerAgentIds);
  if (!reviewers.ok || !observers.ok) return empty;
  return { reviewerAgentIds: reviewers.value, observerAgentIds: observers.value };
}
