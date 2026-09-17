import type { Job, ProjectBinding, ProjectDepartment } from "../shared/contracts";
import { fail, ok, type DomainResult } from "./result";

export function assertTrustedProject(
  binding: ProjectBinding,
  claimedBbProjectId: string | undefined,
): DomainResult<ProjectBinding> {
  if (claimedBbProjectId !== undefined && claimedBbProjectId !== binding.bbProjectId) {
    return fail("untrusted_project", "payload projectId does not match the stored binding");
  }
  return ok(binding);
}

export function assertJobBelongsToBinding(
  job: Job,
  binding: ProjectBinding,
): DomainResult<Job> {
  if (job.bindingId !== binding.id) {
    return fail("binding_mismatch", `job ${job.id} is not bound to ${binding.id}`);
  }
  return ok(job);
}

export function departmentsForBinding(
  bindingId: string,
  links: readonly ProjectDepartment[],
): readonly string[] {
  return links.filter((row) => row.bindingId === bindingId).map((row) => row.departmentId);
}

/** A department open to all projects takes jobs everywhere; a selected one only where it is linked. */
export function assertDepartmentOnBinding(
  bindingId: string,
  departmentId: string,
  links: readonly ProjectDepartment[],
  availability: "all" | "selected" = "selected",
): DomainResult<string> {
  if (availability === "all") return ok(departmentId);
  if (!links.some((row) => row.bindingId === bindingId && row.departmentId === departmentId)) {
    return fail("department_not_on_binding", `department ${departmentId} is not linked to ${bindingId}`);
  }
  return ok(departmentId);
}

/** A disconnected project keeps its history but takes no new jobs, links or launches. */
export function assertBindingActive(binding: ProjectBinding): DomainResult<ProjectBinding> {
  if (binding.archivedAt) {
    return fail("binding_archived", `project binding ${binding.id} is disconnected from the Agency`);
  }
  return ok(binding);
}
