import { fail, ok, type DomainResult } from "../../domain";
import { bbProjectIdSchema } from "../../shared/contracts";

/** Binding workspace row. Not a BB catalog project. */
const BINDING_PREFIX = "bnd_";

/**
 * Trigger scope is an explicit BB project id.
 * Presence of any EventSource.project_id string is not authorization.
 */
export function assertExplicitBbProjectId(value: unknown): DomainResult<string> {
  if (typeof value !== "string") {
    return fail("untrusted_project", "bbProjectId is required for trigger scope");
  }
  const parsed = bbProjectIdSchema.safeParse(value);
  if (!parsed.success) {
    return fail("untrusted_project", "bbProjectId is required for trigger scope");
  }
  const id = parsed.data;
  if (id.startsWith(BINDING_PREFIX)) {
    return fail("untrusted_project", "binding id is not a BB project scope");
  }
  return ok(id);
}
