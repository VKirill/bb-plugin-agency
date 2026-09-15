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

export function assertDepartmentOnBinding(
  bindingId: string,
  departmentId: string,
  links: readonly ProjectDepartment[],
): DomainResult<string> {
  if (!links.some((row) => row.bindingId === bindingId && row.departmentId === departmentId)) {
    return fail("department_not_on_binding", `department ${departmentId} is not linked to ${bindingId}`);
  }
  return ok(departmentId);
}
