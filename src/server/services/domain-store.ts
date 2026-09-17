import { knowledgeBlock } from "../knowledge/store";
import { ISOLATION_PROVEN_PROVIDERS } from "../runtime/isolated-sdk/sdk-isolation-contract";
import { currentAgencyRules } from "../templates/store";
import { handInCommentMissing } from "../runtime/hand-in/service";
import { reworkBlocksReview, resolveRework } from "../runtime/rework/service";
import { foreignRuleKeys, readStoredRules, rulesForDepartment, workRulesView, writeStoredRules } from "../rules/work-rules";
import { saveWorkRulesCommandSchema, workRulesScopeSchema, type SaveWorkRulesCommand, type WorkRulesView } from "../../shared/contracts/work-rules";
import {
  assertAcceptCurrentVersion,
  assertAssigneeInDepartment,
  assertBindingActive,
  assertBindingMoveAllowed,
  assertDepartmentOnBinding,
  assertJobDependencies,
  assertJobTransition,
  assertLeadInMembership,
  effectiveAssignedAgentId,
  isActiveRunState,
  fail,
  matchRevision,
  ok,
  type DomainResult,
} from "../../domain";
import type {
  Activity,
  Agent,
  AgentVersion,
  Artifact,
  ArtifactVersion,
  CreateActivityCommand,
  CreateAgentVersionCommand,
  CreateJobCommand,
  CreateMembershipCommand,
  RemoveMembershipCommand,
  CreatePolicyVersionCommand,
  CreateProcessVersionCommand,
  CreateProjectBindingCommand,
  SaveAgentProfileCommand,
  SaveDepartmentProfileCommand,
  Department,
  Job,
  JobDependency,
  JobTransitionCommand,
  Membership,
  PolicyVersion,
  ProcessVersion,
  ProjectBinding,
  ProjectDepartment,
  PublishArtifactVersionCommand,
  AcceptArtifactVersionCommand,
  UpdateAgentCommand,
  UpdateDepartmentCommand,
  UpdateJobCommand,
  UpdateProjectBindingCommand,
  BindingLifecycleCommand,
  SetDepartmentAvailabilityCommand,
  UnlinkDepartmentCommand,
} from "../../shared/contracts";
import { contractIsEmpty, emptyJobTeamFields } from "../../shared/contracts";
import { assertJobTeamMembership, effectiveJobTeamIds } from "../runtime/job-team";
import { enqueueParentWake } from "../runtime/parent-wake";
import {
  acceptArtifactVersionCommandSchema,
  createActivityCommandSchema,
  createAgentVersionCommandSchema,
  createJobCommandSchema,
  createMembershipCommandSchema,
  removeMembershipCommandSchema,
  createPolicyVersionCommandSchema,
  createProcessVersionCommandSchema,
  createProjectBindingCommandSchema,
  saveAgentProfileCommandSchema,
  saveDepartmentProfileCommandSchema,
  optionalReasoningEffort,
  jobTransitionCommandSchema,
  publishArtifactVersionCommandSchema,
  updateAgentCommandSchema,
  updateDepartmentCommandSchema,
  updateJobCommandSchema,
  updateProjectBindingCommandSchema,
  bindingLifecycleCommandSchema,
  setDepartmentAvailabilityCommandSchema,
  unlinkDepartmentCommandSchema,
} from "../../shared/contracts";
import { commitDomainTransaction } from "../db/domain-txn";
import { newOpaqueId } from "../db/ids";
import { createRepositories, type JobFacts } from "../db/repositories";
import type { SqlDatabase } from "../db/sql";
import { actorToActivity, assertBindingAccess, assertBindingScope, nowUtc, type ServiceContext } from "./context";
import { commitPublishIntent, reservePublishIntent } from "./publish-intent";
import { payloadWithoutRequestId, sameActor, sameCanonical } from "./request-identity";

export type ProvisionAgentInput = {
  requestId: string;
  name: string;
  state: Agent["state"];
  version: Omit<CreateAgentVersionCommand, "requestId" | "agentId">;
};

export type ProvisionDepartmentInput = {
  requestId: string;
  name: string;
  leadAgentId: string;
  process: Omit<CreateProcessVersionCommand, "requestId" | "departmentId">;
};

export type CreateArtifactInput = {
  requestId: string;
  jobId: string;
  claimedBbProjectId?: string;
};

export type SetJobExecutionFactsInput = {
  requestId: string;
  jobId: string;
  claimedBbProjectId?: string;
  threadBound?: boolean;
  confirmedContinuation?: boolean;
  openQuestions?: boolean;
};

export type AddJobDependencyInput = {
  requestId: string;
  jobId: string;
  dependsOnJobId: string;
  claimedBbProjectId?: string;
};

export type LinkDepartmentInput = {
  requestId: string;
  bindingId: string;
  departmentId: string;
  claimedBbProjectId?: string;
};

function withoutClaim<T extends { claimedBbProjectId?: string }>(input: T): Omit<T, "claimedBbProjectId"> {
  const { claimedBbProjectId: _claimed, ...command } = input;
  return command;
}

export function createDomainStore(db: SqlDatabase) {
  const repos = createRepositories(db);

  function remember<T>(
    ctx: ServiceContext,
    identity: { requestId: string; kind: string; payload: unknown; scopeBindingIds: readonly string[] },
    run: () => DomainResult<T>,
  ): DomainResult<T> {
    const payload = payloadWithoutRequestId(identity.payload);
    const existing = repos.request.get(identity.requestId);
    if (existing) {
      for (const bindingId of existing.scopeBindingIds) {
        const access = assertBindingAccess(ctx, bindingId);
        if (!access.ok) return access;
      }
      if (
        existing.kind !== identity.kind ||
        !sameCanonical(existing.payload, payload) ||
        !sameActor(existing.actor, ctx.actor) ||
        !sameCanonical(existing.scopeBindingIds, identity.scopeBindingIds)
      ) {
        return fail(
          "request_conflict",
          `request ${identity.requestId} already used with a different kind, payload, actor or scope`,
        );
      }
      return existing.result as DomainResult<T>;
    }
    const result = run();
    repos.request.insert(
      identity.requestId,
      identity.kind,
      result,
      payload,
      ctx.actor,
      identity.scopeBindingIds,
      nowUtc(ctx),
    );
    return result;
  }

  function requireAgent(id: string): DomainResult<Agent> {
    const row = repos.agent.get(id);
    return row ? ok(row) : fail("not_found", `agent ${id} not found`);
  }

  function requireDepartment(id: string): DomainResult<Department> {
    const row = repos.department.get(id);
    return row ? ok(row) : fail("not_found", `department ${id} not found`);
  }

  function requireBinding(id: string): DomainResult<ProjectBinding> {
    const row = repos.binding.get(id);
    return row ? ok(row) : fail("not_found", `binding ${id} not found`);
  }

  function departmentAvailability(departmentId: string): "all" | "selected" {
    return repos.department.get(departmentId)?.availability ?? "all";
  }

  /** Jobs that are not closed, per binding, for one department. */
  function openJobsOfDepartment(departmentId: string): Array<{ bindingId: string; n: number }> {
    return (
      db
        .prepare(
          `SELECT binding_id, COUNT(*) AS n FROM agency_job
           WHERE department_id = ? AND state NOT IN ('done', 'canceled')
           GROUP BY binding_id`,
        )
        .all(departmentId) as Array<{ binding_id: string; n: number }>
    ).map((row) => ({ bindingId: row.binding_id, n: row.n }));
  }

  function requireJob(id: string): DomainResult<Job> {
    const row = repos.job.get(id);
    return row ? ok(row) : fail("not_found", `job ${id} not found`);
  }

  function sameTextList(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((item, index) => item === right[index]);
  }

  function nextAgentVersionNumber(agentId: string): number {
    const row = db.prepare(`SELECT MAX(version) AS version FROM agency_agent_version WHERE agent_id = ?`).get(agentId) as
      | { version: number | null }
      | undefined;
    return (row?.version ?? 0) + 1;
  }

  /**
   * A reviewer may not check work they produced. Inputs of a job are versions
   * of source jobs; the conflict is the same agent on both sides. An earlier
   * conclusion of that reviewer is allowed as context for a re-check: it is a
   * source job that itself takes someone else's work as input.
   */
  function assertNotSelfReview(
    target: { departmentId: string; assignedAgentId: string | null },
    sourceJobIds: readonly string[],
  ): DomainResult<true> {
    const agentId = target.assignedAgentId;
    if (!agentId || repos.membership.get(target.departmentId, agentId)?.role !== "reviewer") return ok(true);
    for (const sourceJobId of sourceJobIds) {
      const source = repos.job.get(sourceJobId);
      if (!source || source.assignedAgentId !== agentId) continue;
      const reviewedOthers = inputSourceJobIds(source.id).some((id) => {
        const reviewed = repos.job.get(id);
        return Boolean(reviewed?.assignedAgentId) && reviewed?.assignedAgentId !== agentId;
      });
      if (reviewedOthers) continue;
      return fail(
        "self_review",
        `reviewer ${agentId} cannot check ${source.key}: the same agent did that work; assign another reviewer`,
      );
    }
    return ok(true);
  }

  function memberRole(departmentId: string, agentId: string | null | undefined): string | null {
    if (!agentId) return null;
    return repos.membership.get(departmentId, agentId)?.role ?? null;
  }

  /**
   * Rework rounds under one main job: executor subtasks created after the first
   * review subtask. Past the department limit the lead asks the owner instead of
   * opening another round.
   */
  function assertReworkRoundAllowed(parentJobId: string, departmentId: string, assignedAgentId: string | null): DomainResult<true> {
    if (memberRole(departmentId, assignedAgentId) !== "executor") return ok(true);
    const siblings = db
      .prepare(`SELECT department_id, assigned_agent_id FROM agency_job WHERE parent_job_id = ? ORDER BY rowid`)
      .all(parentJobId) as Array<{ department_id: string; assigned_agent_id: string | null }>;
    const firstReview = siblings.findIndex((row) => memberRole(row.department_id, row.assigned_agent_id) === "reviewer");
    if (firstReview < 0) return ok(true);
    const rounds = siblings.slice(firstReview + 1).filter((row) => memberRole(row.department_id, row.assigned_agent_id) === "executor").length;
    const parent = repos.job.get(parentJobId);
    const limit = rulesForDepartment(db, parent?.departmentId ?? departmentId).reworkLimit;
    if (rounds >= limit) {
      return fail(
        "rework_limit_reached",
        `${rounds} rework round(s) already under this job, the department limit is ${limit}; ask the owner with report-needs-input before another round`,
      );
    }
    return ok(true);
  }

  /** Attempt states with a thread that may still be working. */
  const LIVE_ATTEMPT_STATES = ["prepared", "launching", "running", "waiting_input", "unknown"];

  function liveAttempt(jobId: string): boolean {
    const placeholders = LIVE_ATTEMPT_STATES.map(() => "?").join(", ");
    return Boolean(
      db.prepare(`SELECT 1 FROM agency_run_attempt WHERE job_id = ? AND state IN (${placeholders}) LIMIT 1`).get(jobId, ...LIVE_ATTEMPT_STATES),
    );
  }

  /** Paused or archived employees take no new work. */
  function assertAgentActive(agentId: string | null | undefined): DomainResult<true> {
    if (!agentId) return ok(true);
    const agent = repos.agent.get(agentId);
    if (agent && agent.state !== "active") {
      return fail("agent_inactive", `agent ${agent.name} is ${agent.state}; activate the profile or pick another assignee`);
    }
    return ok(true);
  }

  function assertAssigneeNotReviewer(assignedAgentId: string | null | undefined, reviewerAgentIds: readonly string[]): DomainResult<true> {
    if (assignedAgentId && reviewerAgentIds.includes(assignedAgentId)) {
      return fail("assignee_is_reviewer", "the assignee cannot be a reviewer of the same job");
    }
    return ok(true);
  }

  function inputSourceJobIds(jobId: string): string[] {
    return (
      db.prepare(`SELECT DISTINCT source_job_id FROM agency_job_input_ref WHERE target_job_id = ?`).all(jobId) as Array<{
        source_job_id: string;
      }>
    ).map((row) => row.source_job_id);
  }

  function assertMembershipPlan(department: Department, rows: Membership[]): DomainResult<Membership[]> {
    const leadCheck = assertLeadInMembership(department, rows);
    if (!leadCheck.ok) return leadCheck;
    for (const row of rows) {
      const agent = requireAgent(row.agentId);
      if (!agent.ok) return agent;
    }
    return ok(rows);
  }

  function openJobsOf(departmentId: string, agentId: string): number {
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM agency_job WHERE department_id = ? AND assigned_agent_id = ? AND state NOT IN ('done', 'canceled')`,
        )
        .get(departmentId, agentId) as { n: number }
    ).n;
  }

  function writeMemberships(department: Department, rows: Membership[]): DomainResult<Membership[]> {
    const planned = assertMembershipPlan(department, rows);
    if (!planned.ok) return planned;
    const current = repos.membership.listByDepartment(department.id);
    for (const row of current) {
      if (rows.some((item) => item.agentId === row.agentId)) continue;
      const open = openJobsOf(department.id, row.agentId);
      if (open > 0) {
        return fail("member_has_open_jobs", `agent ${row.agentId} has ${open} open job(s) in this department; reassign or close them first`);
      }
    }
    for (const row of current) {
      if (!rows.some((item) => item.agentId === row.agentId)) {
        repos.membership.remove(department.id, row.agentId);
      }
    }
    try {
      for (const row of rows) {
        const existing = repos.membership.get(department.id, row.agentId);
        if (!existing) {
          repos.membership.insert(row);
          continue;
        }
        if (existing.role !== row.role) {
          repos.membership.remove(department.id, row.agentId);
          repos.membership.insert(row);
        }
      }
    } catch (error) {
      return fail("membership_write_failed", error instanceof Error ? error.message : "membership write failed");
    }
    return ok(repos.membership.listByDepartment(department.id));
  }

  function applyMemberships(department: Department, rows: Membership[]): DomainResult<Membership[]> {
    return writeMemberships(department, rows);
  }

  function scopedJob(ctx: ServiceContext, jobId: string, claimedBbProjectId?: string): DomainResult<{ job: Job; binding: ProjectBinding }> {
    const job = requireJob(jobId);
    if (!job.ok) return job;
    const binding = requireBinding(job.value.bindingId);
    if (!binding.ok) return binding;
    const scope = assertBindingScope(ctx, binding.value, claimedBbProjectId);
    if (!scope.ok) return scope;
    return ok({ job: job.value, binding: binding.value });
  }

  function appendActivity(
    ctx: ServiceContext,
    jobId: string,
    kind: string,
    references: Activity["references"] = [],
    causationId: string | null = null,
    comment?: string,
  ): Activity {
    const id = newOpaqueId("activity");
    const row: Activity = {
      id,
      jobId,
      actor: actorToActivity(ctx.actor),
      kind,
      causationId: causationId ?? (kind === "job_transitioned" ? id : null),
      timestamp: nowUtc(ctx),
      references,
      ...(comment ? { comment } : {}),
    };
    repos.activity.insert(row);
    return row;
  }

  function openBlockers(jobId: string): boolean {
    const edges = repos.dependency.listByJob(jobId);
    return edges.some((edge) => {
      const dep = repos.job.get(edge.dependsOnJobId);
      return !dep || dep.state !== "done";
    });
  }

  function transitionContext(job: Job): DomainResult<Parameters<typeof assertJobTransition>[2]> {
    const facts = repos.facts.get(job.id);
    if (!facts) return fail("not_found", `job facts ${job.id} not found`);
    const department = requireDepartment(job.departmentId);
    if (!department.ok) return department;
    const process = repos.processVersion.get(department.value.processVersionId);
    if (!process) return fail("not_found", `process ${department.value.processVersionId} not found`);
    const artifacts = db
      .prepare(`SELECT id FROM agency_artifact WHERE job_id = ?`)
      .all(job.id) as Array<{ id: string }>;
    let published = false;
    let accepted = false;
    for (const artifact of artifacts) {
      const versions = repos.artifactVersion.listByScope(artifact.id, job.id);
      if (versions.length > 0) published = true;
      const current = versions.at(-1);
      const acceptRow = db
        .prepare(`SELECT version, hash FROM agency_artifact_acceptance WHERE artifact_id = ? AND job_id = ?`)
        .get(artifact.id, job.id) as { version: number; hash: string } | undefined;
      if (current && acceptRow && acceptRow.version === current.version && acceptRow.hash === current.hash) {
        accepted = true;
      }
    }
    return ok({
      assignedAgentId: job.assignedAgentId,
      bindingId: job.bindingId,
      brief: job.brief,
      acceptance: job.acceptance,
      threadBound: facts.threadBound,
      publishedCurrentVersion: published,
      acceptedCurrentVersion: accepted,
      reviewPolicySatisfied: !process.reviewPolicy.required || accepted,
      confirmedContinuation: facts.confirmedContinuation,
      openQuestions: facts.openQuestions,
      openBlockers: openBlockers(job.id),
    });
  }

  const createPolicyVersion = (ctx: ServiceContext, input: CreatePolicyVersionCommand): DomainResult<PolicyVersion> => {
    const parsed = createPolicyVersionCommandSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() =>
      remember(ctx, { requestId: parsed.data.requestId, kind: "createPolicyVersion", payload: parsed.data, scopeBindingIds: [] }, () => {
        const row: PolicyVersion = {
          id: newOpaqueId("policy"),
          allowedCapabilities: parsed.data.allowedCapabilities,
          cliHostConstraints: parsed.data.cliHostConstraints,
          secretRefs: parsed.data.secretRefs,
        };
        repos.policy.insert(row);
        return ok(row);
      }),
    )();
  };

  const provisionAgent = (ctx: ServiceContext, input: ProvisionAgentInput): DomainResult<{ agent: Agent; version: AgentVersion }> => {
    const parsed = createAgentVersionCommandSchema.safeParse({
      requestId: input.requestId,
      agentId: "agt_placeholder1",
      ...input.version,
    });
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() =>
      remember(ctx, { requestId: input.requestId, kind: "provisionAgent", payload: input, scopeBindingIds: [] }, () => {
        if (!repos.policy.get(input.version.policyVersionId)) {
          return fail("not_found", `policy ${input.version.policyVersionId} not found`);
        }
        const agentId = newOpaqueId("agent");
        const versionId = newOpaqueId("agentVersion");
        const updatedAt = nowUtc(ctx);
        const version: AgentVersion = {
          id: versionId,
          agentId,
          version: input.version.version,
          role: input.version.role,
          instructions: input.version.instructions,
          providerId: input.version.providerId,
          model: input.version.model,
          skillIds: input.version.skillIds,
          mcpIds: input.version.mcpIds,
          policyVersionId: input.version.policyVersionId,
          ...optionalReasoningEffort(input.version.reasoningEffort),
        };
        const agent: Agent = {
          id: agentId,
          name: input.name,
          state: input.state,
          currentVersionId: versionId,
          revision: 1,
          updatedAt,
        };
        repos.agent.insert(agent);
        repos.agentVersion.insert(version);
        return ok({ agent, version });
      }),
    )();
  };

  const createAgentVersion = (ctx: ServiceContext, input: CreateAgentVersionCommand): DomainResult<AgentVersion> => {
    const parsed = createAgentVersionCommandSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() =>
      remember(ctx, { requestId: parsed.data.requestId, kind: "createAgentVersion", payload: parsed.data, scopeBindingIds: [] }, () => {
        const agent = requireAgent(parsed.data.agentId);
        if (!agent.ok) return agent;
        if (!repos.policy.get(parsed.data.policyVersionId)) {
          return fail("not_found", `policy ${parsed.data.policyVersionId} not found`);
        }
        const version: AgentVersion = {
          id: newOpaqueId("agentVersion"),
          agentId: parsed.data.agentId,
          version: parsed.data.version,
          role: parsed.data.role,
          instructions: parsed.data.instructions,
          providerId: parsed.data.providerId,
          model: parsed.data.model,
          skillIds: parsed.data.skillIds,
          mcpIds: parsed.data.mcpIds,
          policyVersionId: parsed.data.policyVersionId,
          ...optionalReasoningEffort(parsed.data.reasoningEffort),
        };
        try {
          repos.agentVersion.insert(version);
        } catch (error) {
          return fail("version_immutable", error instanceof Error ? error.message : "agent version insert failed");
        }
        return ok(version);
      }),
    )();
  };

  const updateAgent = (ctx: ServiceContext, input: UpdateAgentCommand): DomainResult<Agent> => {
    const parsed = updateAgentCommandSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() =>
      remember(ctx, { requestId: parsed.data.requestId, kind: "updateAgent", payload: parsed.data, scopeBindingIds: [] }, () => {
        const current = requireAgent(parsed.data.agentId);
        if (!current.ok) return current;
        const revision = matchRevision(current.value.revision, parsed.data);
        if (!revision.ok) return revision;
        if (parsed.data.currentVersionId) {
          const version = repos.agentVersion.get(parsed.data.currentVersionId);
          if (!version || version.agentId !== current.value.id) {
            return fail("version_mismatch", "currentVersionId must belong to this agent");
          }
        }
        const next: Agent = {
          ...current.value,
          name: parsed.data.name ?? current.value.name,
          state: parsed.data.state ?? current.value.state,
          currentVersionId: parsed.data.currentVersionId ?? current.value.currentVersionId,
          revision: revision.value.nextRevision,
          updatedAt: nowUtc(ctx),
        };
        repos.agent.update(next);
        return ok(next);
      }),
    )();
  };

  function getWorkRules(scope: string): DomainResult<WorkRulesView> {
    const parsed = workRulesScopeSchema.safeParse(scope);
    if (!parsed.success) return fail("invalid_command", "scope is agency, department:<id> or agent:<id>");
    const exists = ruleScopeExists(scope);
    if (!exists.ok) return exists;
    return ok(workRulesView(db, scope));
  }

  function ruleScopeExists(scope: string): DomainResult<true> {
    if (scope.startsWith("department:") && !repos.department.get(scope.slice("department:".length))) {
      return fail("not_found", `department ${scope.slice("department:".length)} not found`);
    }
    if (scope.startsWith("agent:") && !repos.agent.get(scope.slice("agent:".length))) {
      return fail("not_found", `agent ${scope.slice("agent:".length)} not found`);
    }
    return ok(true);
  }

  const saveWorkRules = (ctx: ServiceContext, input: SaveWorkRulesCommand): DomainResult<WorkRulesView> => {
    const parsed = saveWorkRulesCommandSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() =>
      remember(ctx, { requestId: parsed.data.requestId, kind: "saveWorkRules", payload: parsed.data, scopeBindingIds: [] }, () => {
        const exists = ruleScopeExists(parsed.data.scope);
        if (!exists.ok) return exists;
        const foreign = foreignRuleKeys(parsed.data.scope, parsed.data.rules);
        if (foreign.length) return fail("rule_not_in_scope", `${parsed.data.scope} cannot set: ${foreign.join(", ")}`);
        const current = readStoredRules(db, parsed.data.scope);
        if (current.revision !== parsed.data.expectedRevision) {
          return fail("revision_conflict", `expected revision ${parsed.data.expectedRevision}, found ${current.revision}`);
        }
        writeStoredRules(db, parsed.data.scope, parsed.data.rules, current.revision + 1, nowUtc(ctx));
        return ok(workRulesView(db, parsed.data.scope));
      }),
    )();
  };

  /** Chat routing names departments; two with one name make the route ambiguous. */
  function assertDepartmentNameFree(name: string, exceptId?: string): DomainResult<true> {
    const wanted = name.trim().toLocaleLowerCase("ru");
    const taken = (db.prepare(`SELECT id, name FROM agency_department`).all() as Array<{ id: string; name: string }>).find(
      (row) => row.id !== exceptId && row.name.trim().toLocaleLowerCase("ru") === wanted,
    );
    return taken ? fail("duplicate_department_name", `department name «${name}» is already used by ${taken.id}`) : ok(true);
  }

  const provisionDepartment = (
    ctx: ServiceContext,
    input: ProvisionDepartmentInput,
  ): DomainResult<{ department: Department; process: ProcessVersion; membership: Membership }> => {
    const parsed = createProcessVersionCommandSchema.safeParse({
      requestId: input.requestId,
      departmentId: "dep_placeholder1",
      ...input.process,
    });
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() =>
      remember(ctx, { requestId: input.requestId, kind: "provisionDepartment", payload: input, scopeBindingIds: [] }, () => {
        const free = assertDepartmentNameFree(input.name);
        if (!free.ok) return free;
        const lead = requireAgent(input.leadAgentId);
        if (!lead.ok) return lead;
        const departmentId = newOpaqueId("department");
        const processId = newOpaqueId("process");
        const department: Department = {
          id: departmentId,
          name: input.name,
          leadAgentId: input.leadAgentId,
          processVersionId: processId,
          revision: 1,
          updatedAt: nowUtc(ctx),
        };
        const process: ProcessVersion = {
          id: processId,
          departmentId,
          instructions: input.process.instructions,
          acceptance: input.process.acceptance,
          reviewPolicy: input.process.reviewPolicy,
        };
        const membership: Membership = { departmentId, agentId: input.leadAgentId, role: "lead" };
        repos.department.insert(department);
        repos.processVersion.insert(process);
        repos.membership.insert(membership);
        const leadCheck = assertLeadInMembership(department, repos.membership.listByDepartment(departmentId));
        if (!leadCheck.ok) return leadCheck;
        return ok({ department, process, membership });
      }),
    )();
  };

  const createProcessVersion = (ctx: ServiceContext, input: CreateProcessVersionCommand): DomainResult<ProcessVersion> => {
    const parsed = createProcessVersionCommandSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() =>
      remember(ctx, { requestId: parsed.data.requestId, kind: "createProcessVersion", payload: parsed.data, scopeBindingIds: [] }, () => {
        const department = requireDepartment(parsed.data.departmentId);
        if (!department.ok) return department;
        const process: ProcessVersion = {
          id: newOpaqueId("process"),
          departmentId: parsed.data.departmentId,
          instructions: parsed.data.instructions,
          acceptance: parsed.data.acceptance,
          reviewPolicy: parsed.data.reviewPolicy,
        };
        try {
          repos.processVersion.insert(process);
        } catch (error) {
          return fail("version_immutable", error instanceof Error ? error.message : "process version insert failed");
        }
        return ok(process);
      }),
    )();
  };

  const saveAgentProfile = (
    ctx: ServiceContext,
    input: SaveAgentProfileCommand,
  ): DomainResult<{ agent: Agent; version: AgentVersion }> => {
    const parsed = saveAgentProfileCommandSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return commitDomainTransaction(db, () =>
      remember(ctx, { requestId: parsed.data.requestId, kind: "saveAgentProfile", payload: parsed.data, scopeBindingIds: [] }, () => {
        const current = requireAgent(parsed.data.agentId);
        if (!current.ok) return current;
        const revision = matchRevision(current.value.revision, parsed.data);
        if (!revision.ok) return revision;
        if (!repos.policy.get(parsed.data.version.policyVersionId)) {
          return fail("not_found", `policy ${parsed.data.version.policyVersionId} not found`);
        }
        const currentVersion = repos.agentVersion.get(current.value.currentVersionId);
        if (!currentVersion) return fail("not_found", `agent version ${current.value.currentVersionId} not found`);
        const draft = parsed.data.version;
        const unchanged =
          currentVersion.role === draft.role &&
          currentVersion.instructions === draft.instructions &&
          currentVersion.providerId === draft.providerId &&
          currentVersion.model === draft.model &&
          currentVersion.policyVersionId === draft.policyVersionId &&
          currentVersion.reasoningEffort === draft.reasoningEffort &&
          sameTextList(currentVersion.skillIds, draft.skillIds) &&
          sameTextList(currentVersion.mcpIds, draft.mcpIds);
        let version = currentVersion;
        if (!unchanged) {
          version = {
            id: newOpaqueId("agentVersion"),
            agentId: current.value.id,
            version: nextAgentVersionNumber(current.value.id),
            role: draft.role,
            instructions: draft.instructions,
            providerId: draft.providerId,
            model: draft.model,
            skillIds: draft.skillIds,
            mcpIds: draft.mcpIds,
            policyVersionId: draft.policyVersionId,
            ...optionalReasoningEffort(draft.reasoningEffort),
          };
          try {
            repos.agentVersion.insert(version);
          } catch (error) {
            return fail("version_immutable", error instanceof Error ? error.message : "agent version insert failed");
          }
        }
        const agent: Agent = {
          ...current.value,
          name: parsed.data.name,
          state: parsed.data.state,
          currentVersionId: version.id,
          revision: revision.value.nextRevision,
          updatedAt: nowUtc(ctx),
        };
        repos.agent.update(agent);
        return ok({ agent, version });
      }),
    );
  };

  const saveDepartmentProfile = (
    ctx: ServiceContext,
    input: SaveDepartmentProfileCommand,
  ): DomainResult<{ department: Department; process: ProcessVersion; memberships: Membership[] }> => {
    const parsed = saveDepartmentProfileCommandSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return commitDomainTransaction(db, () =>
      remember(ctx, { requestId: parsed.data.requestId, kind: "saveDepartmentProfile", payload: parsed.data, scopeBindingIds: [] }, () => {
        const current = requireDepartment(parsed.data.departmentId);
        if (!current.ok) return current;
        const revision = matchRevision(current.value.revision, parsed.data);
        if (!revision.ok) return revision;
        const free = assertDepartmentNameFree(parsed.data.name, current.value.id);
        if (!free.ok) return free;
        const lead = requireAgent(parsed.data.leadAgentId);
        if (!lead.ok) return lead;
        const currentProcess = repos.processVersion.get(current.value.processVersionId);
        if (!currentProcess) return fail("not_found", `process ${current.value.processVersionId} not found`);
        const draft = parsed.data.process;
        const processUnchanged =
          !draft ||
          (currentProcess.instructions === draft.instructions &&
            currentProcess.acceptance === draft.acceptance &&
            currentProcess.reviewPolicy.required === draft.reviewPolicy.required);
        const wanted: Membership[] = parsed.data.memberships
          ? parsed.data.memberships.map((row) => ({
              departmentId: current.value.id,
              agentId: row.agentId,
              role: row.role,
            }))
          : (() => {
              const rows = repos.membership.listByDepartment(current.value.id).map((row) => ({
                ...row,
                role: row.agentId === parsed.data.leadAgentId ? ("lead" as const) : row.role === "lead" ? ("executor" as const) : row.role,
              }));
              if (!rows.some((row) => row.agentId === parsed.data.leadAgentId)) {
                rows.push({ departmentId: current.value.id, agentId: parsed.data.leadAgentId, role: "lead" });
              }
              return rows;
            })();
        const planned: Department = {
          ...current.value,
          name: parsed.data.name,
          leadAgentId: parsed.data.leadAgentId,
          processVersionId: current.value.processVersionId,
        };
        const membershipReady = assertMembershipPlan(planned, wanted);
        if (!membershipReady.ok) return membershipReady;
        let process = currentProcess;
        if (draft && !processUnchanged) {
          process = {
            id: newOpaqueId("process"),
            departmentId: current.value.id,
            instructions: draft.instructions,
            acceptance: draft.acceptance,
            reviewPolicy: draft.reviewPolicy,
          };
          try {
            repos.processVersion.insert(process);
          } catch (error) {
            return fail("version_immutable", error instanceof Error ? error.message : "process version insert failed");
          }
        }
        const department: Department = {
          ...planned,
          processVersionId: process.id,
          revision: revision.value.nextRevision,
          updatedAt: nowUtc(ctx),
        };
        const memberships = writeMemberships(department, wanted);
        if (!memberships.ok) return memberships;
        repos.department.update(department);
        return ok({ department, process, memberships: memberships.value });
      }),
    );
  };

  const updateDepartment = (ctx: ServiceContext, input: UpdateDepartmentCommand): DomainResult<Department> => {
    const parsed = updateDepartmentCommandSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() =>
      remember(ctx, { requestId: parsed.data.requestId, kind: "updateDepartment", payload: parsed.data, scopeBindingIds: [] }, () => {
        const current = requireDepartment(parsed.data.departmentId);
        if (!current.ok) return current;
        const revision = matchRevision(current.value.revision, parsed.data);
        if (!revision.ok) return revision;
        if (parsed.data.processVersionId) {
          const process = repos.processVersion.get(parsed.data.processVersionId);
          if (!process || process.departmentId !== current.value.id) {
            return fail("version_mismatch", "processVersionId must belong to this department");
          }
        }
        const next: Department = {
          ...current.value,
          name: parsed.data.name ?? current.value.name,
          leadAgentId: parsed.data.leadAgentId ?? current.value.leadAgentId,
          processVersionId: parsed.data.processVersionId ?? current.value.processVersionId,
          revision: revision.value.nextRevision,
          updatedAt: nowUtc(ctx),
        };
        repos.department.update(next);
        const leadCheck = assertLeadInMembership(next, repos.membership.listByDepartment(next.id));
        if (!leadCheck.ok) return leadCheck;
        return ok(next);
      }),
    )();
  };

  const addMembership = (ctx: ServiceContext, input: CreateMembershipCommand): DomainResult<Membership> => {
    const parsed = createMembershipCommandSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() =>
      remember(ctx, { requestId: parsed.data.requestId, kind: "addMembership", payload: parsed.data, scopeBindingIds: [] }, () => {
        const department = requireDepartment(parsed.data.departmentId);
        if (!department.ok) return department;
        const agent = requireAgent(parsed.data.agentId);
        if (!agent.ok) return agent;
        const membership: Membership = {
          departmentId: parsed.data.departmentId,
          agentId: parsed.data.agentId,
          role: parsed.data.role,
        };
        try {
          repos.membership.insert(membership);
        } catch {
          return fail("membership_duplicate", `duplicate membership ${membership.departmentId}+${membership.agentId}`);
        }
        const leadCheck = assertLeadInMembership(department.value, repos.membership.listByDepartment(department.value.id));
        if (!leadCheck.ok) return leadCheck;
        return ok(membership);
      }),
    )();
  };

  const removeMembership = (ctx: ServiceContext, input: RemoveMembershipCommand): DomainResult<Membership> => {
    const parsed = removeMembershipCommandSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() =>
      remember(ctx, { requestId: parsed.data.requestId, kind: "removeMembership", payload: parsed.data, scopeBindingIds: [] }, () => {
        const department = requireDepartment(parsed.data.departmentId);
        if (!department.ok) return department;
        const current = repos.membership.get(parsed.data.departmentId, parsed.data.agentId);
        if (!current) return fail("not_found", "membership not found");
        const remaining = repos.membership
          .listByDepartment(department.value.id)
          .filter((row) => row.agentId !== parsed.data.agentId);
        const leadCheck = assertLeadInMembership(department.value, remaining);
        if (!leadCheck.ok) return leadCheck;
        const open = openJobsOf(parsed.data.departmentId, parsed.data.agentId);
        if (open > 0) {
          return fail("member_has_open_jobs", `the agent has ${open} open job(s) in this department; reassign or close them first`);
        }
        repos.membership.remove(parsed.data.departmentId, parsed.data.agentId);
        return ok(current);
      }),
    )();
  };

  const createProjectBinding = (ctx: ServiceContext, input: CreateProjectBindingCommand): DomainResult<ProjectBinding> => {
    const parsed = createProjectBindingCommandSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() =>
      remember(ctx, { requestId: parsed.data.requestId, kind: "createProjectBinding", payload: parsed.data, scopeBindingIds: [] }, () => {
        if (!repos.policy.get(parsed.data.policyVersionId)) {
          return fail("not_found", `policy ${parsed.data.policyVersionId} not found`);
        }
        const existing = repos.binding.findActiveByPlacement(parsed.data.environmentId, parsed.data.canonicalRoot);
        if (existing) {
          return fail("binding_duplicate", `folder ${parsed.data.canonicalRoot} is already connected as ${existing.id}`);
        }
        const row: ProjectBinding = {
          id: newOpaqueId("binding"),
          bbProjectId: parsed.data.bbProjectId,
          environmentId: parsed.data.environmentId,
          hostId: parsed.data.hostId,
          canonicalRoot: parsed.data.canonicalRoot,
          policyVersionId: parsed.data.policyVersionId,
          sectionId: parsed.data.sectionId,
          revision: 1,
          updatedAt: nowUtc(ctx),
        };
        repos.binding.insert(row);
        return ok(row);
      }),
    )();
  };

  const updateProjectBinding = (ctx: ServiceContext, input: UpdateProjectBindingCommand & { claimedBbProjectId?: string }): DomainResult<ProjectBinding> => {
    const parsed = updateProjectBindingCommandSchema.safeParse(withoutClaim(input));
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() => {
      const current = requireBinding(parsed.data.bindingId);
      if (!current.ok) return current;
      const scope = assertBindingScope(ctx, current.value, input.claimedBbProjectId);
      if (!scope.ok) return scope;
      return remember(ctx, {
        requestId: parsed.data.requestId,
        kind: "updateProjectBinding",
        payload: parsed.data,
        scopeBindingIds: [current.value.id],
      }, () => {
        const revision = matchRevision(current.value.revision, parsed.data);
        if (!revision.ok) return revision;
        if (parsed.data.policyVersionId && !repos.policy.get(parsed.data.policyVersionId)) {
          return fail("not_found", `policy ${parsed.data.policyVersionId} not found`);
        }
        const next: ProjectBinding = {
          ...current.value,
          sectionId: parsed.data.sectionId === undefined ? current.value.sectionId : parsed.data.sectionId,
          policyVersionId: parsed.data.policyVersionId ?? current.value.policyVersionId,
          revision: revision.value.nextRevision,
          updatedAt: nowUtc(ctx),
        };
        repos.binding.update(next);
        return ok(next);
      });
    })();
  };

  const changeBindingConnection = (
    kind: "archiveProjectBinding" | "restoreProjectBinding",
    archived: boolean,
  ) => (ctx: ServiceContext, input: BindingLifecycleCommand & { claimedBbProjectId?: string }): DomainResult<ProjectBinding> => {
    const parsed = bindingLifecycleCommandSchema.safeParse(withoutClaim(input));
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() => {
      const current = requireBinding(parsed.data.bindingId);
      if (!current.ok) return current;
      const scope = assertBindingScope(ctx, current.value, input.claimedBbProjectId);
      if (!scope.ok) return scope;
      return remember(ctx, { requestId: parsed.data.requestId, kind, payload: parsed.data, scopeBindingIds: [current.value.id] }, () => {
        const revision = matchRevision(current.value.revision, parsed.data);
        if (!revision.ok) return revision;
        if (Boolean(current.value.archivedAt) === archived) return ok(current.value);
        if (!archived) {
          const existing = repos.binding.findActiveByPlacement(current.value.environmentId, current.value.canonicalRoot);
          if (existing && existing.id !== current.value.id) {
            return fail("binding_duplicate", `folder ${current.value.canonicalRoot} is already connected as ${existing.id}`);
          }
        }
        const now = nowUtc(ctx);
        const next: ProjectBinding = {
          ...current.value,
          archivedAt: archived ? now : null,
          revision: revision.value.nextRevision,
          updatedAt: now,
        };
        repos.binding.update(next);
        const { archivedAt, ...rest } = next;
        return ok(archivedAt ? next : rest);
      });
    })();
  };

  /** Disconnect: history stays, new jobs, department links and launches stop. */
  const archiveProjectBinding = changeBindingConnection("archiveProjectBinding", true);
  const restoreProjectBinding = changeBindingConnection("restoreProjectBinding", false);

  /** Delete only an unused connection. A project with jobs is disconnected instead. */
  const deleteProjectBinding = (
    ctx: ServiceContext,
    input: BindingLifecycleCommand & { claimedBbProjectId?: string },
  ): DomainResult<{ bindingId: string }> => {
    const parsed = bindingLifecycleCommandSchema.safeParse(withoutClaim(input));
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() => {
      const current = requireBinding(parsed.data.bindingId);
      if (!current.ok) return current;
      const scope = assertBindingScope(ctx, current.value, input.claimedBbProjectId);
      if (!scope.ok) return scope;
      return remember(ctx, { requestId: parsed.data.requestId, kind: "deleteProjectBinding", payload: parsed.data, scopeBindingIds: [current.value.id] }, () => {
        const revision = matchRevision(current.value.revision, parsed.data);
        if (!revision.ok) return revision;
        const usage = repos.binding.usage(current.value.id);
        if (usage.jobs > 0 || usage.publishIntents > 0) {
          return fail(
            "binding_in_use",
            `binding ${current.value.id} has ${usage.jobs} jobs and ${usage.publishIntents} file records; disconnect it instead`,
          );
        }
        repos.binding.delete(current.value.id);
        return ok({ bindingId: current.value.id });
      });
    })();
  };

  const unlinkDepartment = (
    ctx: ServiceContext,
    input: UnlinkDepartmentCommand & { claimedBbProjectId?: string },
  ): DomainResult<ProjectDepartment> => {
    const parsed = unlinkDepartmentCommandSchema.safeParse(withoutClaim(input));
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() => {
      const binding = requireBinding(parsed.data.bindingId);
      if (!binding.ok) return binding;
      const scope = assertBindingScope(ctx, binding.value, input.claimedBbProjectId);
      if (!scope.ok) return scope;
      return remember(ctx, { requestId: parsed.data.requestId, kind: "unlinkDepartment", payload: parsed.data, scopeBindingIds: [binding.value.id] }, () => {
        const department = requireDepartment(parsed.data.departmentId);
        if (!department.ok) return department;
        if (departmentAvailability(department.value.id) === "selected") {
          const open = openJobsOfDepartment(department.value.id).find((row) => row.bindingId === binding.value.id);
          if (open) {
            return fail("department_in_use", `department has ${open.n} open jobs in this project; close or move them first`);
          }
        }
        if (!repos.projectDepartment.remove(binding.value.id, department.value.id)) {
          return fail("not_found", `department ${department.value.id} is not linked to ${binding.value.id}`);
        }
        return ok({ bindingId: binding.value.id, departmentId: department.value.id });
      });
    })();
  };

  const setDepartmentAvailability = (ctx: ServiceContext, input: SetDepartmentAvailabilityCommand): DomainResult<Department> => {
    const parsed = setDepartmentAvailabilityCommandSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() =>
      remember(ctx, { requestId: parsed.data.requestId, kind: "setDepartmentAvailability", payload: parsed.data, scopeBindingIds: [] }, () => {
        const current = requireDepartment(parsed.data.departmentId);
        if (!current.ok) return current;
        const revision = matchRevision(current.value.revision, parsed.data);
        if (!revision.ok) return revision;
        if (parsed.data.availability === "selected") {
          const linked = new Set(repos.projectDepartment.listByDepartment(current.value.id).map((row) => row.bindingId));
          const stranded = openJobsOfDepartment(current.value.id).filter((row) => !linked.has(row.bindingId));
          if (stranded.length) {
            const jobs = stranded.reduce((sum, row) => sum + row.n, 0);
            return fail(
              "department_in_use",
              `department has ${jobs} open jobs in ${stranded.length} projects it is not linked to; link those projects first`,
            );
          }
        }
        const { availability: _previous, ...base } = current.value;
        const next: Department = {
          ...base,
          ...(parsed.data.availability === "selected" ? { availability: "selected" as const } : {}),
          revision: revision.value.nextRevision,
          updatedAt: nowUtc(ctx),
        };
        repos.department.update(next);
        return ok(next);
      }),
    )();
  };

  const linkDepartment = (ctx: ServiceContext, input: LinkDepartmentInput): DomainResult<ProjectDepartment> => {
    return db.transaction(() => {
      const binding = requireBinding(input.bindingId);
      if (!binding.ok) return binding;
      const scope = assertBindingScope(ctx, binding.value, input.claimedBbProjectId);
      if (!scope.ok) return scope;
      return remember(ctx, {
        requestId: input.requestId,
        kind: "linkDepartment",
        payload: input,
        scopeBindingIds: [binding.value.id],
      }, () => {
        const active = assertBindingActive(binding.value);
        if (!active.ok) return active;
        const department = requireDepartment(input.departmentId);
        if (!department.ok) return department;
        const link: ProjectDepartment = { bindingId: input.bindingId, departmentId: input.departmentId };
        try {
          repos.projectDepartment.insert(link);
        } catch {
          return fail("duplicate_link", `department ${input.departmentId} already linked to ${input.bindingId}`);
        }
        return ok(link);
      });
    })();
  };

  const createJob = (ctx: ServiceContext, input: CreateJobCommand & { claimedBbProjectId?: string }): DomainResult<Job> => {
    const parsed = createJobCommandSchema.safeParse(withoutClaim(input));
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() => {
      const binding = requireBinding(parsed.data.bindingId);
      if (!binding.ok) return binding;
      const scope = assertBindingScope(ctx, binding.value, input.claimedBbProjectId);
      if (!scope.ok) return scope;
      return remember(ctx, {
        requestId: parsed.data.requestId,
        kind: "createJob",
        payload: parsed.data,
        scopeBindingIds: [binding.value.id],
      }, () => {
        const active = assertBindingActive(binding.value);
        if (!active.ok) return active;
        const linked = assertDepartmentOnBinding(
          parsed.data.bindingId,
          parsed.data.departmentId,
          repos.projectDepartment.listByBinding(parsed.data.bindingId),
          departmentAvailability(parsed.data.departmentId),
        );
        if (!linked.ok) return linked;
        const picked = parsed.data.assignedAgentId
          ? ok(parsed.data.assignedAgentId)
          : parsed.data.assignment
            ? pickAssignee(parsed.data.departmentId, parsed.data.assignment, parsed.data.reviewerAgentIds ?? [])
            : ok(null);
        if (!picked.ok) return picked;
        const assignedAgentId = picked.value;
        if (parsed.data.parentJobId) {
          const parent = requireJob(parsed.data.parentJobId);
          if (!parent.ok) return parent;
          if (parent.value.bindingId !== parsed.data.bindingId) {
            return fail("binding_mismatch", "parent job belongs to another binding");
          }
        }
        if (assignedAgentId) {
          const membership = repos.membership.get(parsed.data.departmentId, assignedAgentId);
          if (!membership) {
            return fail("assignee_not_member", "assigned agent must belong to the job department");
          }
        }
        const assigneeActive = assertAgentActive(assignedAgentId);
        if (!assigneeActive.ok) return assigneeActive;
        if (parsed.data.parentJobId) {
          const round = assertReworkRoundAllowed(parsed.data.parentJobId, parsed.data.departmentId, assignedAgentId);
          if (!round.ok) return round;
        }
        const team = assertJobTeamMembership({
          departmentId: parsed.data.departmentId,
          reviewerAgentIds: parsed.data.reviewerAgentIds ?? emptyJobTeamFields().reviewerAgentIds,
          observerAgentIds: parsed.data.observerAgentIds ?? emptyJobTeamFields().observerAgentIds,
          isMember: (departmentId, agentId) => Boolean(repos.membership.get(departmentId, agentId)),
        });
        if (!team.ok) return team;
        const notReviewer = assertAssigneeNotReviewer(assignedAgentId, team.value.reviewerAgentIds);
        if (!notReviewer.ok) return notReviewer;
        const job: Job = {
          id: newOpaqueId("job"),
          key: parsed.data.key ?? repos.job.nextKey(),
          bindingId: parsed.data.bindingId,
          departmentId: parsed.data.departmentId,
          title: parsed.data.title,
          brief: parsed.data.brief,
          acceptance: parsed.data.acceptance,
          state: "backlog",
          parentJobId: parsed.data.parentJobId,
          assignedAgentId,
          reviewerAgentIds: team.value.reviewerAgentIds,
          observerAgentIds: team.value.observerAgentIds,
          priority: parsed.data.priority,
          dueAt: parsed.data.dueAt,
          ...(parsed.data.contract && !contractIsEmpty(parsed.data.contract) ? { contract: parsed.data.contract } : {}),
          revision: 1,
          updatedAt: nowUtc(ctx),
        };
        try {
          repos.job.insert(job);
        } catch {
          return fail("duplicate_job_key", `job key ${job.key} already exists`);
        }
        repos.facts.insert(job.id);
        appendActivity(ctx, job.id, "job_created", [{ type: "job", id: job.id }]);
        return ok(job);
      });
    })();
  };

  const updateJob = (ctx: ServiceContext, input: UpdateJobCommand & { claimedBbProjectId?: string }): DomainResult<Job> => {
    const parsed = updateJobCommandSchema.safeParse(withoutClaim(input));
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() => {
      const scoped = scopedJob(ctx, parsed.data.jobId, input.claimedBbProjectId);
      if (!scoped.ok) return scoped;
      return remember(ctx, {
        requestId: parsed.data.requestId,
        kind: "updateJob",
        payload: parsed.data,
        scopeBindingIds: [scoped.value.binding.id],
      }, () => {
        const revision = matchRevision(scoped.value.job.revision, parsed.data);
        if (!revision.ok) return revision;
        const bindingId = parsed.data.bindingId ?? scoped.value.job.bindingId;
        const departmentId = parsed.data.departmentId ?? scoped.value.job.departmentId;
        const nextBinding = bindingId === scoped.value.binding.id ? ok(scoped.value.binding) : requireBinding(bindingId);
        if (!nextBinding.ok) return nextBinding;
        const scope = assertBindingScope(ctx, nextBinding.value, input.claimedBbProjectId);
        if (!scope.ok) return scope;
        if (nextBinding.value.id !== scoped.value.binding.id) {
          const active = assertBindingActive(nextBinding.value);
          if (!active.ok) return active;
        }
        const linked = assertDepartmentOnBinding(
          nextBinding.value.id,
          departmentId,
          repos.projectDepartment.listByBinding(nextBinding.value.id),
          departmentAvailability(departmentId),
        );
        if (!linked.ok) return linked;
        const assignedAgentId = effectiveAssignedAgentId(scoped.value.job.assignedAgentId, parsed.data.assignedAgentId);
        const assignee = assertAssigneeInDepartment(
          departmentId,
          assignedAgentId,
          assignedAgentId ? Boolean(repos.membership.get(departmentId, assignedAgentId)) : true,
        );
        if (!assignee.ok) return assignee;
        if (assignedAgentId !== scoped.value.job.assignedAgentId) {
          const active = assertAgentActive(assignedAgentId);
          if (!active.ok) return active;
        }
        // The card must name who actually works: no reassignment or department move under a live thread.
        if (
          (assignedAgentId !== scoped.value.job.assignedAgentId || departmentId !== scoped.value.job.departmentId) &&
          liveAttempt(scoped.value.job.id)
        ) {
          return fail("job_has_live_run", "stop the running attempt before changing the assignee or department");
        }
        const ownWork = assertNotSelfReview({ departmentId, assignedAgentId }, inputSourceJobIds(scoped.value.job.id));
        if (!ownWork.ok) return ownWork;
        const team = assertJobTeamMembership({
          departmentId,
          reviewerAgentIds: effectiveJobTeamIds(scoped.value.job.reviewerAgentIds ?? [], parsed.data.reviewerAgentIds),
          observerAgentIds: effectiveJobTeamIds(scoped.value.job.observerAgentIds ?? [], parsed.data.observerAgentIds),
          isMember: (deptId, agentId) => Boolean(repos.membership.get(deptId, agentId)),
        });
        if (!team.ok) return team;
        const notReviewer = assertAssigneeNotReviewer(assignedAgentId, team.value.reviewerAgentIds);
        if (!notReviewer.ok) return notReviewer;
        const moving = nextBinding.value.id !== scoped.value.job.bindingId;
        const children = (
          db.prepare(`SELECT id FROM agency_job WHERE parent_job_id = ?`).all(scoped.value.job.id) as Array<{ id: string }>
        ).length;
        const dependencies = (
          db
            .prepare(`SELECT job_id FROM agency_job_dependency WHERE job_id = ? OR depends_on_job_id = ?`)
            .all(scoped.value.job.id, scoped.value.job.id) as Array<{ job_id: string }>
        ).length;
        const artifacts = (
          db.prepare(`SELECT id FROM agency_artifact WHERE job_id = ?`).all(scoped.value.job.id) as Array<{ id: string }>
        ).length;
        const facts = repos.facts.get(scoped.value.job.id);
        const blocked = assertBindingMoveAllowed({
          moving,
          isChild: Boolean(scoped.value.job.parentJobId),
          hasChildren: children > 0,
          hasDependencies: dependencies > 0,
          hasArtifacts: artifacts > 0,
          hasRun: isActiveRunState(scoped.value.job.state, facts?.threadBound === true),
        });
        if (!blocked.ok) return blocked;
        const { contract: _previousContract, ...current } = scoped.value.job;
        const contract = parsed.data.contract === undefined ? scoped.value.job.contract : parsed.data.contract;
        const next: Job = {
          ...current,
          ...(contract && !contractIsEmpty(contract) ? { contract } : {}),
          title: parsed.data.title ?? scoped.value.job.title,
          brief: parsed.data.brief ?? scoped.value.job.brief,
          acceptance: parsed.data.acceptance ?? scoped.value.job.acceptance,
          bindingId: nextBinding.value.id,
          departmentId,
          assignedAgentId,
          reviewerAgentIds: team.value.reviewerAgentIds,
          observerAgentIds: team.value.observerAgentIds,
          priority: parsed.data.priority ?? scoped.value.job.priority,
          dueAt: parsed.data.dueAt === undefined ? scoped.value.job.dueAt : parsed.data.dueAt,
          revision: revision.value.nextRevision,
          updatedAt: nowUtc(ctx),
        };
        repos.job.update(next);
        appendActivity(ctx, next.id, "job_updated");
        return ok(next);
      });
    })();
  };

  const addJobDependency = (ctx: ServiceContext, input: AddJobDependencyInput): DomainResult<JobDependency> => {
    return db.transaction(() => {
      const scoped = scopedJob(ctx, input.jobId, input.claimedBbProjectId);
      if (!scoped.ok) return scoped;
      return remember(ctx, {
        requestId: input.requestId,
        kind: "addJobDependency",
        payload: input,
        scopeBindingIds: [scoped.value.binding.id],
      }, () => {
        const dependsOn = requireJob(input.dependsOnJobId);
        if (!dependsOn.ok) return dependsOn;
        if (dependsOn.value.bindingId !== scoped.value.job.bindingId) {
          return fail("binding_mismatch", "dependency must stay inside the same binding");
        }
        const edge: JobDependency = { jobId: input.jobId, dependsOnJobId: input.dependsOnJobId };
        const all = [...repos.dependency.listAll(), edge];
        const cyclic = assertJobDependencies(all);
        if (!cyclic.ok) return cyclic;
        try {
          repos.dependency.insert(edge);
        } catch {
          return fail("duplicate_dependency", "dependency already exists");
        }
        appendActivity(ctx, input.jobId, "job_dependency_added", [{ type: "job", id: input.dependsOnJobId }]);
        return ok(edge);
      });
    })();
  };

  const setJobExecutionFacts = (ctx: ServiceContext, input: SetJobExecutionFactsInput): DomainResult<JobFacts> => {
    return db.transaction(() => {
      const scoped = scopedJob(ctx, input.jobId, input.claimedBbProjectId);
      if (!scoped.ok) return scoped;
      return remember(ctx, {
        requestId: input.requestId,
        kind: "setJobExecutionFacts",
        payload: input,
        scopeBindingIds: [scoped.value.binding.id],
      }, () => {
        const current = repos.facts.get(input.jobId);
        if (!current) return fail("not_found", `job facts ${input.jobId} not found`);
        const next: JobFacts = {
          ...current,
          threadBound: input.threadBound ?? current.threadBound,
          confirmedContinuation: input.confirmedContinuation ?? current.confirmedContinuation,
          openQuestions: input.openQuestions ?? current.openQuestions,
        };
        repos.facts.update(next);
        return ok(next);
      });
    })();
  };

  const transitionJob = (
    ctx: ServiceContext,
    input: JobTransitionCommand & { claimedBbProjectId?: string },
  ): DomainResult<Job> => {
    const parsed = jobTransitionCommandSchema.safeParse(withoutClaim(input));
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() => {
      const scoped = scopedJob(ctx, parsed.data.jobId, input.claimedBbProjectId);
      if (!scoped.ok) return scoped;
      return remember(ctx, {
        requestId: parsed.data.requestId,
        kind: "transitionJob",
        payload: parsed.data,
        scopeBindingIds: [scoped.value.binding.id],
      }, () => {
        const revision = matchRevision(scoped.value.job.revision, parsed.data);
        if (!revision.ok) return revision;
        const stored = transitionContext(scoped.value.job);
        if (!stored.ok) return stored;
        if ((parsed.data.to === "queued" || parsed.data.to === "running") && stored.value && stored.value.openBlockers === true) {
          return fail("open_blockers", "queued/running cannot bypass open blockers, including via blocked");
        }
        const allowed = assertJobTransition(scoped.value.job.state, parsed.data.to, {
          ...stored.value,
          reworkComment: parsed.data.reworkComment,
        });
        if (!allowed.ok) return allowed;
        // Canceling a job does not stop its thread; launch cancel does, then the job may be canceled.
        if (parsed.data.to === "canceled" && ctx.actor.kind !== "system" && liveAttempt(scoped.value.job.id)) {
          return fail("job_has_live_run", "stop the running attempt (launch cancel) before canceling the job");
        }
        const next: Job = {
          ...scoped.value.job,
          state: parsed.data.to,
          revision: revision.value.nextRevision,
          updatedAt: nowUtc(ctx),
        };
        repos.job.update(next);
        const activity = appendActivity(ctx, next.id, "job_transitioned", [{ type: "job_state", id: parsed.data.to }]);
        enqueueParentWake(db, next, { ...activity, causationId: activity.causationId ?? activity.id }, next.updatedAt);
        return ok(next);
      });
    })();
  };

  const createArtifact = (ctx: ServiceContext, input: CreateArtifactInput): DomainResult<Artifact> => {
    return db.transaction(() => {
      const scoped = scopedJob(ctx, input.jobId, input.claimedBbProjectId);
      if (!scoped.ok) return scoped;
      return remember(ctx, {
        requestId: input.requestId,
        kind: "createArtifact",
        payload: input,
        scopeBindingIds: [scoped.value.binding.id],
      }, () => {
        const artifact: Artifact = { id: newOpaqueId("artifact"), jobId: input.jobId };
        repos.artifact.insert(artifact);
        return ok(artifact);
      });
    })();
  };

  const publishArtifactVersion = (
    ctx: ServiceContext,
    input: PublishArtifactVersionCommand & { claimedBbProjectId?: string },
  ): DomainResult<ArtifactVersion> => {
    const parsed = publishArtifactVersionCommandSchema.safeParse(withoutClaim(input));
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() => {
      const scoped = scopedJob(ctx, parsed.data.jobId, input.claimedBbProjectId);
      if (!scoped.ok) return scoped;
      // A closed job keeps its accepted result: a new version would leave «Готово» with an unaccepted file.
      if (scoped.value.job.state === "done" || scoped.value.job.state === "canceled") {
        return fail("job_closed", `job ${scoped.value.job.key} is ${scoped.value.job.state}; new versions are not accepted`);
      }
      const artifact = repos.artifact.get(parsed.data.artifactId);
      if (!artifact || artifact.jobId !== parsed.data.jobId) {
        return fail("artifact_scope_mismatch", "artifact does not belong to this job");
      }
      const reserved = reservePublishIntent(
        repos,
        ctx,
        {
          requestId: parsed.data.requestId,
          artifactId: artifact.id,
          jobId: artifact.jobId,
          bindingId: scoped.value.binding.id,
          hostId: parsed.data.hostId,
          canonicalRoot: scoped.value.binding.canonicalRoot,
          bindingRevision: scoped.value.binding.revision,
          relativePath: parsed.data.relativePath,
          mime: parsed.data.mime,
          size: parsed.data.size,
          hash: parsed.data.hash,
          author: parsed.data.author,
        },
        scoped.value.binding,
      );
      if (!reserved.ok) return reserved;
      const version: ArtifactVersion = {
        artifactId: artifact.id,
        jobId: artifact.jobId,
        version: reserved.value.version,
        hostId: reserved.value.hostId,
        relativePath: parsed.data.relativePath,
        mime: parsed.data.mime,
        size: parsed.data.size,
        hash: parsed.data.hash,
        author: parsed.data.author,
      };
      const committed = commitPublishIntent(repos, reserved.value, version);
      if (!committed.ok) return committed;
      appendActivity(ctx, artifact.jobId, "artifact_published", [{ type: "artifact", id: artifact.id }]);
      return committed;
    })();
  };

  /**
   * Automatic assignment: the lead, or the active member of a role type on a
   * launchable CLI with the fewest open jobs (ties by name). Team reviewers of
   * the job are skipped for an executor pick.
   */
  function pickAssignee(departmentId: string, role: "lead" | "executor" | "reviewer", reviewerIds: readonly string[]): DomainResult<string> {
    if (role === "lead") {
      const department = repos.department.get(departmentId);
      return department ? ok(department.leadAgentId) : fail("not_found", `department ${departmentId} not found`);
    }
    const rows = db
      .prepare(
        `SELECT m.agent_id, v.provider_id,
                (SELECT COUNT(*) FROM agency_job j WHERE j.assigned_agent_id = m.agent_id AND j.state NOT IN ('done', 'canceled')) AS open_jobs
         FROM agency_membership m
         JOIN agency_agent a ON a.id = m.agent_id
         LEFT JOIN agency_agent_version v ON v.id = a.current_version_id
         WHERE m.department_id = ? AND m.role = ? AND a.state = 'active'
         ORDER BY open_jobs ASC, a.name ASC`,
      )
      .all(departmentId, role) as { agent_id: string; provider_id: string | null; open_jobs: number }[];
    const pick = rows.find(
      (row) => (ISOLATION_PROVEN_PROVIDERS as readonly string[]).includes(row.provider_id ?? "") && !(role === "executor" && reviewerIds.includes(row.agent_id)),
    );
    if (!pick) {
      return fail(
        "no_member_for_assignment",
        role === "reviewer"
          ? "В отделе нет активного проверяющего, которого Агентство может запустить. Добавьте его в «Составе» отдела или назначьте вручную."
          : "В отделе нет активного исполнителя, которого Агентство может запустить. Добавьте его в «Составе» отдела или назначьте вручную.",
      );
    }
    return ok(pick.agent_id);
  }

  /**
   * The owner accepts anything. An employee accepts only a version of a job its
   * own attempt delegated (the parent job), and never a version it authored.
   */
  function assertMayAccept(ctx: ServiceContext, job: Job, version: ArtifactVersion): DomainResult<true> {
    const caller = ctx.caller;
    if (!caller) return ok(true);
    if (caller.jobId === job.id) {
      return fail("self_acceptance", `Результат ${job.key} принимает руководитель родительской задачи или владелец, а не исполнитель этой задачи.`);
    }
    if (version.author.kind === "run") {
      const author = db
        .prepare(`SELECT j.assigned_agent_id AS agent_id FROM agency_run_attempt a JOIN agency_job j ON j.id = a.job_id WHERE a.id = ?`)
        .get(version.author.runId) as { agent_id: string | null } | undefined;
      if (author?.agent_id && author.agent_id === caller.agentId) {
        return fail("self_acceptance", `Версия ${job.key} создана этим же сотрудником: свою работу он не принимает.`);
      }
    }
    if (job.parentJobId !== caller.jobId) {
      return fail("accept_not_lead", `Версию ${job.key} принимает тот, кто поручил задачу (попытка родительской задачи), или владелец.`);
    }
    return ok(true);
  }

  const acceptArtifactVersion = (
    ctx: ServiceContext,
    input: AcceptArtifactVersionCommand & { claimedBbProjectId?: string },
  ): DomainResult<ArtifactVersion> => {
    const parsed = acceptArtifactVersionCommandSchema.safeParse(withoutClaim(input));
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() => {
      const scoped = scopedJob(ctx, parsed.data.jobId, input.claimedBbProjectId);
      if (!scoped.ok) return scoped;
      return remember(ctx, {
        requestId: parsed.data.requestId,
        kind: "acceptArtifactVersion",
        payload: parsed.data,
        scopeBindingIds: [scoped.value.binding.id],
      }, () => {
        const revision = matchRevision(scoped.value.job.revision, parsed.data);
        if (!revision.ok) return revision;
        const versions = repos.artifactVersion.listByScope(parsed.data.artifactId, parsed.data.jobId);
        const accepted = assertAcceptCurrentVersion(versions, parsed.data);
        if (!accepted.ok) return accepted;
        const acceptor = assertMayAccept(ctx, scoped.value.job, accepted.value);
        if (!acceptor.ok) return acceptor;
        db.prepare(
          `INSERT INTO agency_artifact_acceptance (artifact_id, job_id, version, hash, accepted_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(artifact_id, job_id) DO UPDATE SET version = excluded.version, hash = excluded.hash, accepted_at = excluded.accepted_at`,
        ).run(parsed.data.artifactId, parsed.data.jobId, parsed.data.version, parsed.data.hash, nowUtc(ctx));
        repos.job.update({
          ...scoped.value.job,
          revision: revision.value.nextRevision,
          updatedAt: nowUtc(ctx),
        });
        appendActivity(ctx, parsed.data.jobId, "artifact_accepted", [{ type: "artifact", id: parsed.data.artifactId }]);
        return ok(accepted.value);
      });
    })();
  };

  const createActivity = (ctx: ServiceContext, input: CreateActivityCommand): DomainResult<Activity> => {
    const parsed = createActivityCommandSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_command", parsed.error.message);
    return db.transaction(() => {
      const scoped = scopedJob(ctx, parsed.data.jobId);
      if (!scoped.ok) return scoped;
      return remember(ctx, {
        requestId: parsed.data.requestId,
        kind: "createActivity",
        payload: parsed.data,
        scopeBindingIds: [scoped.value.binding.id],
      }, () => ok(appendActivity(
        ctx,
        parsed.data.jobId,
        parsed.data.kind,
        parsed.data.references,
        parsed.data.causationId,
        parsed.data.comment,
      )));
    })();
  };

  return {
    createPolicyVersion,
    provisionAgent,
    createAgentVersion,
    saveAgentProfile,
    updateAgent,
    provisionDepartment,
    createProcessVersion,
    saveDepartmentProfile,
    updateDepartment,
    addMembership,
    removeMembership,
    createProjectBinding,
    updateProjectBinding,
    archiveProjectBinding,
    restoreProjectBinding,
    deleteProjectBinding,
    linkDepartment,
    unlinkDepartment,
    setDepartmentAvailability,
    createJob,
    updateJob,
    addJobDependency,
    setJobExecutionFacts,
    transitionJob,
    createArtifact,
    publishArtifactVersion,
    acceptArtifactVersion,
    createActivity,
    getAgent: (id: string) => repos.agent.get(id),
    getAgentVersion: (id: string) => repos.agentVersion.get(id),
    getPolicyVersion: (id: string) => repos.policy.get(id),
    getDepartment: (id: string) => repos.department.get(id),
    getProcessVersion: (id: string) => repos.processVersion.get(id),
    listMemberships: (departmentId: string) => repos.membership.listByDepartment(departmentId),
    getBinding: (id: string) => repos.binding.get(id),
    listProjectDepartments: (bindingId: string) => repos.projectDepartment.listByBinding(bindingId),
    getJob: (id: string) => repos.job.get(id),
    getJobByKey: (key: string) => repos.job.getByKey(key),
    listDependencies: (jobId: string) => repos.dependency.listByJob(jobId),
    getArtifact: (id: string) => repos.artifact.get(id),
    listArtifactVersions: (artifactId: string, jobId: string) => repos.artifactVersion.listByScope(artifactId, jobId),
    getArtifactVersion: (artifactId: string, jobId: string, version: number) =>
      repos.artifactVersion.get(artifactId, jobId, version),
    listActivity: (jobId: string) => repos.activity.listByJob(jobId),
    inboxCount: () => repos.inbox.count(),
    assertBindingAccess,
    assertNotSelfReview,
    reworkBlocksReview: (jobId: string, publishedHash: string | null) => reworkBlocksReview(db, jobId, publishedHash),
    handInCommentMissing: (jobId: string) => handInCommentMissing(db, jobId),
    currentAgencyRules: () => currentAgencyRules(db),
    knowledgeForLaunch: (departmentId: string, bindingId: string) => {
      const agency = knowledgeBlock(db, "agency", null);
      const project = knowledgeBlock(db, "project", bindingId);
      const department = knowledgeBlock(db, "department", departmentId);
      const ids = [...agency.ids, ...project.ids, ...department.ids];
      return ids.length ? { agency: agency.text, project: project.text, department: department.text, ids } : null;
    },
    getWorkRules,
    memberRole,
    saveWorkRules,
    rulesForDepartment: (departmentId: string) => rulesForDepartment(db, departmentId),
    resolveRework: (jobId: string) => resolveRework(db, jobId, new Date().toISOString()),
    scopedJob,
  };
}

export type DomainStore = ReturnType<typeof createDomainStore>;
