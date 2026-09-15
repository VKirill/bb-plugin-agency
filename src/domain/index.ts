export {
  DomainTxnAbort,
  domainAbortResult,
  fail,
  isDomainTxnAbort,
  ok,
  type DomainError,
  type DomainResult,
} from "./result";
export { isDisplayName, isJobKey, isOpaqueId, sameEntity } from "./ids";
export { matchRevision, nextRevision } from "./revision";
export { assertLeadInMembership, assertUniqueMemberships, departmentsForAgent } from "./membership";
export {
  assertDepartmentOnBinding,
  assertJobBelongsToBinding,
  assertTrustedProject,
  departmentsForBinding,
} from "./project-binding";
export {
  assertAssigneeInDepartment,
  assertBindingMoveAllowed,
  effectiveAssignedAgentId,
  isActiveRunState,
} from "./job-placement";
export {
  JOB_TRANSITIONS,
  assertJobDependencies,
  assertJobTransition,
  canTransitionJob,
  type JobTransitionContext,
} from "./job-state";
export {
  assertAcceptCurrentVersion,
  assertArtifactScope,
  assertImmutableArtifactVersion,
  currentArtifactVersion,
  nextArtifactVersion,
  type ArtifactAcceptance,
  type ArtifactScope,
} from "./artifact-version";
export type { AgentProfile, RunSnapshot, Rule, Trigger } from "./models";
