import { describe, expect, it } from "vitest";
import {
  STAGE1_CONTRACT_VERSION,
  acceptArtifactVersionCommandSchema,
  activitySchema,
  agentVersionSchema,
  artifactVersionSchema,
  bbEnvironmentIdSchema,
  changeCommandSchema,
  createActivityCommandSchema,
  createAgentVersionCommandSchema,
  createJobCommandSchema,
  createMembershipCommandSchema,
  createPolicyVersionCommandSchema,
  createProcessVersionCommandSchema,
  createProjectBindingCommandSchema,
  isUtcInstant,
  jobKeySchema,
  jobSchema,
  jobStateSchema,
  jobTransitionCommandSchema,
  membershipSchema,
  catalogSkillIdSchema,
  catalogMcpIdSchema,
  opaqueIdSchema,
  policyVersionSchema,
  processVersionSchema,
  projectBindingSchema,
  projectScopedQuerySchema,
  publishArtifactVersionCommandSchema,
  updateJobCommandSchema,
  utcInstantSchema,
  type ArtifactVersion,
  type Department,
  type Job,
  type JobTransitionCommand,
  type Membership,
  type ProjectBinding,
} from "../src/shared/contracts";
import {
  assertAcceptCurrentVersion,
  assertImmutableArtifactVersion,
  assertJobBelongsToBinding,
  assertJobDependencies,
  assertJobTransition,
  assertLeadInMembership,
  assertTrustedProject,
  assertUniqueMemberships,
  canTransitionJob,
  isJobKey,
  isOpaqueId,
  matchRevision,
  nextArtifactVersion,
  sameEntity,
} from "../src/domain";

const requestId = "11111111-1111-4111-8111-111111111111";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

const department: Department = {
  id: "dep_abcd1234",
  name: "Редактура",
  leadAgentId: "agt_lead0001",
  processVersionId: "prc_00000001",
  revision: 1,
  updatedAt: "2026-09-14T00:00:00Z",
};

const memberships: Membership[] = [
  { departmentId: "dep_abcd1234", agentId: "agt_lead0001", role: "lead" },
  { departmentId: "dep_abcd1234", agentId: "agt_writer01", role: "executor" },
  { departmentId: "dep_other001", agentId: "agt_writer01", role: "executor" },
];

const binding: ProjectBinding = {
  id: "bnd_selfy001",
  bbProjectId: "proj_trusted",
  environmentId: "env_ucx7sb57rs",
  hostId: "host_mini",
  canonicalRoot: "/work/SelfyStudio",
  policyVersionId: "pol_00000001",
  sectionId: null,
  revision: 2,
  updatedAt: "2026-09-14T00:00:00Z",
};

const job: Job = {
  id: "job_brief001",
  key: "AG-102",
  bindingId: "bnd_selfy001",
  departmentId: "dep_abcd1234",
  title: "Бриф посадочной",
  brief: "Собрать бриф",
  acceptance: "Есть принятая версия файла",
  state: "backlog",
  parentJobId: null,
  assignedAgentId: "agt_writer01",
  reviewerAgentIds: [],
  observerAgentIds: [],
  priority: "normal",
  dueAt: null,
  revision: 3,
  updatedAt: "2026-09-14T00:01:00Z",
};

const queuedReady = {
  assignedAgentId: job.assignedAgentId,
  bindingId: job.bindingId,
  brief: job.brief,
  acceptance: job.acceptance,
};

const createBindingCommand = {
  requestId,
  bbProjectId: "proj_trusted",
  environmentId: "custom-environment",
  hostId: "host_mini",
  canonicalRoot: "/work/SelfyStudio",
  policyVersionId: "pol_00000001",
  sectionId: null,
};

const version = (overrides: Partial<ArtifactVersion> = {}): ArtifactVersion => ({
  artifactId: "art_brief001",
  jobId: "job_brief001",
  version: 1,
  hostId: "host_mini",
  relativePath: "briefs/offer.md",
  mime: "text/markdown",
  size: 120,
  hash: hashA,
  author: { kind: "run", runId: "run_00000001" },
  ...overrides,
});

describe("stage-1 exported schemas", () => {
  it("publishes a fixed contract version", () => {
    expect(STAGE1_CONTRACT_VERSION).toBe("agency.domain.stage1.v1");
  });

  it("accepts opaque ids and job keys, not display names", () => {
    expect(opaqueIdSchema.safeParse("job_brief001").success).toBe(true);
    expect(jobKeySchema.safeParse("AG-102").success).toBe(true);
    expect(opaqueIdSchema.safeParse("Редактура").success).toBe(false);
    expect(opaqueIdSchema.safeParse("AG-102").success).toBe(false);
    expect(jobKeySchema.safeParse("job_brief001").success).toBe(false);
    expect(isOpaqueId("job_brief001")).toBe(true);
    expect(isJobKey("AG-102")).toBe(true);
    expect(sameEntity("Редактура", "Редактура")).toBe(false);
  });

  it("accepts catalog skill_64hex and keeps Agency entity ids opaque", () => {
    const catalogSkill = "skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff";
    expect(catalogSkillIdSchema.safeParse(catalogSkill).success).toBe(true);
    expect(opaqueIdSchema.safeParse(catalogSkill).success).toBe(false);
    expect(catalogSkillIdSchema.safeParse("skl_ru000001").success).toBe(false);
    expect(catalogSkillIdSchema.safeParse("ru-text").success).toBe(false);
    expect(catalogSkillIdSchema.safeParse("skill_6153a163aaaa").success).toBe(false);
    expect(catalogMcpIdSchema.safeParse("mcp_docs0001").success).toBe(false);
    expect(opaqueIdSchema.safeParse("agent_aaaaaaaa").success).toBe(true);
  });

  it("treats BB environmentId as an external id, not an Agency opaque id", () => {
    expect(bbEnvironmentIdSchema.safeParse("custom-environment").success).toBe(true);
    expect(bbEnvironmentIdSchema.safeParse(binding.environmentId).success).toBe(true);
    expect(opaqueIdSchema.safeParse("custom-environment").success).toBe(false);
    expect(createProjectBindingCommandSchema.safeParse(createBindingCommand).success).toBe(true);
  });

  it("rejects impossible UTC dates and non-Z offsets", () => {
    expect(isUtcInstant("2026-09-14T00:00:00Z")).toBe(true);
    expect(utcInstantSchema.safeParse("2026-02-30T00:00:00Z").success).toBe(false);
    expect(utcInstantSchema.safeParse("2026-09-14T25:00:00Z").success).toBe(false);
    expect(utcInstantSchema.safeParse("2026-09-14T00:00:00+02:00").success).toBe(false);
  });

  it("rejects extra fields on command and record schemas", () => {
    expect(changeCommandSchema.safeParse({
      expectedRevision: 3, requestId, extra: true,
    }).success).toBe(false);
    expect(membershipSchema.safeParse({
      departmentId: "dep_abcd1234", agentId: "agt_writer01", role: "executor", name: "Имя",
    }).success).toBe(false);
    expect(createMembershipCommandSchema.safeParse({
      requestId, departmentId: "dep_abcd1234", agentId: "agt_writer01", role: "executor",
    }).success).toBe(true);
    expect(createMembershipCommandSchema.safeParse({
      departmentId: "dep_abcd1234", agentId: "agt_writer01", role: "executor",
    }).success).toBe(false);
    expect(projectBindingSchema.safeParse({ ...binding, projectId: "proj_trusted" }).success).toBe(false);
    expect(jobSchema.safeParse({ ...job, projectId: "proj_trusted" }).success).toBe(false);
    expect(artifactVersionSchema.safeParse({ ...version(), previewPath: "x" }).success).toBe(false);
  });

  it("keeps section optional and forbids path escape in binding roots", () => {
    expect(createProjectBindingCommandSchema.safeParse(createBindingCommand).success).toBe(true);
    expect(createProjectBindingCommandSchema.safeParse({
      ...createBindingCommand, canonicalRoot: "/tmp/../etc",
    }).success).toBe(false);
  });

  it("lists the documented job states and mutation headers", () => {
    expect(jobStateSchema.options).toEqual([
      "backlog", "queued", "running", "review", "waiting_input", "blocked", "done", "canceled",
    ]);
    expect(jobTransitionCommandSchema.safeParse({
      expectedRevision: 3, requestId, jobId: "job_brief001", to: "queued",
    } satisfies JobTransitionCommand).success).toBe(true);
    expect(createJobCommandSchema.safeParse({
      requestId,
      key: "AG-102",
      bindingId: "bnd_selfy001",
      departmentId: "dep_abcd1234",
      title: "Бриф",
      brief: "Собрать бриф",
      acceptance: "Файл принят",
      parentJobId: null,
      assignedAgentId: "agt_writer01",
      priority: "high",
      dueAt: "2026-09-20T12:00:00Z",
    }).success).toBe(true);
    expect(updateJobCommandSchema.safeParse({
      expectedRevision: 3, requestId, jobId: "job_brief001", priority: "urgent",
    }).success).toBe(true);
    expect(acceptArtifactVersionCommandSchema.safeParse({
      expectedRevision: 3, requestId, jobId: "job_brief001", artifactId: "art_brief001", version: 1, hash: hashA,
    }).success).toBe(true);
    expect(projectScopedQuerySchema.safeParse({
      bindingId: "bnd_selfy001", claimedBbProjectId: "proj_other",
    }).success).toBe(true);
  });

  it("exports limited AgentVersion, PolicyVersion, ProcessVersion and Activity schemas", () => {
    expect(agentVersionSchema.safeParse({
      id: "ver_agent001",
      agentId: "agt_writer01",
      version: 1,
      role: "copywriter",
      instructions: "Пиши кратко",
      providerId: "claude",
      model: "opus",
      skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
      mcpIds: [],
      policyVersionId: "pol_00000001",
    }).success).toBe(true);
    expect(policyVersionSchema.safeParse({
      id: "pol_00000001",
      allowedCapabilities: ["files.read"],
      cliHostConstraints: { providerIds: ["claude"], hostIds: ["host_mini"] },
      secretRefs: ["AGENCY_TOKEN"],
    }).success).toBe(true);
    expect(processVersionSchema.safeParse({
      id: "prc_00000001",
      departmentId: "dep_abcd1234",
      instructions: "Сначала бриф",
      acceptance: "Есть файл",
      reviewPolicy: { required: true },
    }).success).toBe(true);
    expect(activitySchema.safeParse({
      id: "act_00000001",
      jobId: "job_brief001",
      actor: { kind: "user", userId: "usr_owner" },
      kind: "artifact_published",
      causationId: null,
      timestamp: "2026-09-14T00:02:00Z",
      references: [{ type: "artifact", id: "art_brief001" }],
    }).success).toBe(true);
    expect(createAgentVersionCommandSchema.safeParse({ requestId, agentId: "agt_writer01" }).success).toBe(false);
    expect(createPolicyVersionCommandSchema.safeParse({
      requestId,
      allowedCapabilities: ["files.read"],
      cliHostConstraints: { providerIds: ["claude"], hostIds: ["host_mini"] },
      secretRefs: ["AGENCY_TOKEN"],
    }).success).toBe(true);
    expect(createProcessVersionCommandSchema.safeParse({
      requestId,
      departmentId: "dep_abcd1234",
      instructions: "Сначала бриф",
      acceptance: "Есть файл",
      reviewPolicy: { required: true },
    }).success).toBe(true);
    expect(createActivityCommandSchema.safeParse({
      requestId,
      jobId: "job_brief001",
      actor: { kind: "system" },
      kind: "state_changed",
      causationId: null,
      references: [],
    }).success).toBe(true);
    expect(activitySchema.safeParse({
      id: "act_00000001",
      jobId: "job_brief001",
      actor: { kind: "user", userId: "usr_owner" },
      kind: "artifact_published",
      causationId: null,
      timestamp: "2026-09-14T00:02:00Z",
      references: [],
      comment: "Вернуть с замечанием.",
    }).success).toBe(true);
    expect(createActivityCommandSchema.safeParse({
      requestId,
      jobId: "job_brief001",
      actor: { kind: "system" },
      kind: "state_changed",
      causationId: null,
      references: [],
      comment: "Вернуть с замечанием.",
    }).success).toBe(true);
    expect(createActivityCommandSchema.safeParse({
      requestId,
      jobId: "job_brief001",
      actor: { kind: "system" },
      kind: "state_changed",
      causationId: null,
      references: [],
      comment: "",
    }).success).toBe(false);
    expect(createActivityCommandSchema.safeParse({
      requestId,
      jobId: "job_brief001",
      actor: { kind: "system" },
      kind: "state_changed",
      causationId: null,
      references: [],
      comment: "x".repeat(8001),
    }).success).toBe(false);
    expect(policyVersionSchema.safeParse({
      id: "pol_00000001",
      allowedCapabilities: ["files.read"],
      cliHostConstraints: { providerIds: ["claude"], hostIds: ["host_mini"] },
      secretRefs: ["AGENCY_TOKEN"],
      secretValues: { AGENCY_TOKEN: "x" },
    }).success).toBe(false);
  });
});

describe("revision", () => {
  it("advances only when expectedRevision matches", () => {
    expect(matchRevision(3, { expectedRevision: 3, requestId })).toEqual({
      ok: true, value: { nextRevision: 4 },
    });
    expect(matchRevision(3, { expectedRevision: 2, requestId })).toMatchObject({
      ok: false, error: { code: "revision_conflict" },
    });
  });
});

describe("membership", () => {
  it("allows one agent in several departments and requires a unique pair", () => {
    expect(assertUniqueMemberships(memberships).ok).toBe(true);
    expect(assertUniqueMemberships([
      ...memberships,
      { departmentId: "dep_abcd1234", agentId: "agt_writer01", role: "executor" },
    ]).ok).toBe(false);
  });

  it("requires exactly one lead membership matching department.leadAgentId", () => {
    expect(assertLeadInMembership(department, memberships).ok).toBe(true);
    expect(assertLeadInMembership(department, memberships.filter((row) => row.role !== "lead")).ok).toBe(false);
    expect(assertLeadInMembership(department, [
      { departmentId: "dep_abcd1234", agentId: "agt_lead0001", role: "executor" },
      { departmentId: "dep_abcd1234", agentId: "agt_writer01", role: "executor" },
    ])).toMatchObject({ ok: false, error: { code: "lead_role_conflict" } });
    expect(assertLeadInMembership(department, [
      ...memberships,
      { departmentId: "dep_abcd1234", agentId: "agt_second01", role: "lead" },
    ])).toMatchObject({ ok: false, error: { code: "lead_role_conflict" } });
    expect(assertLeadInMembership(department, [
      { departmentId: "dep_abcd1234", agentId: "agt_writer01", role: "lead" },
    ])).toMatchObject({ ok: false, error: { code: "lead_role_conflict" } });
  });
});

describe("project binding", () => {
  it("does not trust a payload projectId that differs from the stored binding", () => {
    expect(assertTrustedProject(binding, undefined).ok).toBe(true);
    expect(assertTrustedProject(binding, "proj_trusted").ok).toBe(true);
    expect(assertTrustedProject(binding, "proj_other")).toMatchObject({
      ok: false, error: { code: "untrusted_project" },
    });
    expect(assertJobBelongsToBinding(job, binding).ok).toBe(true);
    expect(assertJobBelongsToBinding({ ...job, bindingId: "bnd_other001" }, binding).ok).toBe(false);
  });
});

describe("job state", () => {
  it("follows the documented happy path and side states", () => {
    expect(canTransitionJob("backlog", "queued")).toBe(true);
    expect(canTransitionJob("queued", "running")).toBe(true);
    expect(canTransitionJob("running", "review")).toBe(true);
    expect(canTransitionJob("review", "done")).toBe(true);
    expect(canTransitionJob("running", "waiting_input")).toBe(true);
    expect(canTransitionJob("queued", "blocked")).toBe(true);
    expect(canTransitionJob("done", "canceled")).toBe(false);
    expect(assertJobTransition("backlog", "done").ok).toBe(false);
  });

  it("applies target-state guards, including returns to running", () => {
    expect(assertJobTransition("backlog", "queued", queuedReady).ok).toBe(true);
    expect(assertJobTransition("backlog", "queued", { brief: job.brief }).ok).toBe(false);
    expect(assertJobTransition("blocked", "queued", queuedReady).ok).toBe(true);
    expect(assertJobTransition("blocked", "queued").ok).toBe(false);
    expect(assertJobTransition("queued", "running", { ...queuedReady, threadBound: true }).ok).toBe(true);
    expect(assertJobTransition("queued", "running", queuedReady).ok).toBe(false);
    expect(assertJobTransition("blocked", "running", { ...queuedReady, threadBound: true }).ok).toBe(true);
    expect(assertJobTransition("blocked", "running", queuedReady).ok).toBe(false);
    expect(assertJobTransition("waiting_input", "running", {
      ...queuedReady, threadBound: true, confirmedContinuation: true, openQuestions: false, openBlockers: false,
    }).ok).toBe(true);
    expect(assertJobTransition("waiting_input", "running", {
      ...queuedReady, threadBound: true, confirmedContinuation: true, openQuestions: true, openBlockers: false,
    }).ok).toBe(false);
    expect(assertJobTransition("waiting_input", "running", {
      ...queuedReady, threadBound: true,
    }).ok).toBe(false);
    expect(assertJobTransition("review", "running", {
      ...queuedReady, threadBound: true, reworkComment: "Нужна правка заголовка",
    }).ok).toBe(true);
    expect(assertJobTransition("review", "running", {
      ...queuedReady, reworkComment: "Нужна правка заголовка",
    }).ok).toBe(false);
    expect(assertJobTransition("review", "running", { ...queuedReady, threadBound: true }).ok).toBe(false);
    expect(assertJobTransition("running", "review", { publishedCurrentVersion: true }).ok).toBe(true);
    expect(assertJobTransition("review", "done", {
      acceptedCurrentVersion: true, reviewPolicySatisfied: true,
    }).ok).toBe(true);
    expect(assertJobTransition("done", "review", { publishedCurrentVersion: true }).ok).toBe(true);
  });

  it("rejects self-links and cycles", () => {
    expect(assertJobDependencies([{ jobId: "job_brief001", dependsOnJobId: "job_brief001" }]).ok).toBe(false);
    expect(assertJobDependencies([
      { jobId: "job_brief001", dependsOnJobId: "job_parent01" },
      { jobId: "job_parent01", dependsOnJobId: "job_brief001" },
    ]).ok).toBe(false);
    expect(assertJobDependencies([
      { jobId: "job_brief001", dependsOnJobId: "job_parent01" },
    ]).ok).toBe(true);
  });
});

describe("artifact version", () => {
  it("keeps user/run/system provenance without a fake user id", () => {
    const userVersion = version({ author: { kind: "user", userId: "usr_owner" } });
    expect(artifactVersionSchema.safeParse(userVersion).success).toBe(true);
    expect(artifactVersionSchema.safeParse(version({ author: { kind: "system" } })).success).toBe(true);
    expect(artifactVersionSchema.safeParse({ ...userVersion, authorRunId: "run_00000001" }).success).toBe(false);
    expect(publishArtifactVersionCommandSchema.safeParse({
      requestId,
      artifactId: "art_brief001",
      jobId: "job_brief001",
      hostId: "host_mini",
      relativePath: "briefs/offer.md",
      mime: "text/markdown",
      size: 120,
      hash: hashA,
      author: { kind: "user", userId: "usr_owner" },
    }).success).toBe(true);
  });

  it("treats versions as immutable and accepts only the current scoped hash", () => {
    const first = version();
    const second = version({ version: 2, hash: hashB });
    const scope = { artifactId: "art_brief001", jobId: "job_brief001" };
    expect(nextArtifactVersion([first], scope)).toEqual({ ok: true, value: 2 });
    expect(assertImmutableArtifactVersion(first, first).ok).toBe(true);
    expect(assertImmutableArtifactVersion(first, { ...first, hash: hashB })).toMatchObject({
      ok: false, error: { code: "artifact_immutable" },
    });
    expect(assertAcceptCurrentVersion([first, second], { ...scope, version: 2, hash: hashB }).ok).toBe(true);
    expect(assertAcceptCurrentVersion([first, second], { ...scope, version: 1, hash: hashA })).toMatchObject({
      ok: false, error: { code: "stale_artifact_version" },
    });
  });

  it("rejects mixed artifact or job versions even when the hash matches", () => {
    const own = version({ version: 2, hash: hashB });
    const otherFile = version({ artifactId: "art_other001", version: 2, hash: hashB });
    const otherJob = version({ jobId: "job_other001", version: 2, hash: hashB });
    const accepted = { artifactId: "art_brief001", jobId: "job_brief001", version: 2, hash: hashB };
    expect(assertAcceptCurrentVersion([own, otherFile], accepted)).toMatchObject({
      ok: false, error: { code: "artifact_scope_mismatch" },
    });
    expect(assertAcceptCurrentVersion([own, otherJob], accepted)).toMatchObject({
      ok: false, error: { code: "artifact_scope_mismatch" },
    });
    expect(nextArtifactVersion([own, otherFile], accepted)).toMatchObject({
      ok: false, error: { code: "artifact_scope_mismatch" },
    });
  });
});
