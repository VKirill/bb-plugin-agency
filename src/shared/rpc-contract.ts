import { TEMPLATE_KEYS } from "./templates";
import { saveWorkRulesCommandSchema, workRulesScopeSchema, workRulesViewSchema } from "./contracts/work-rules";
import { listDashboardUsageInputSchema, listDashboardUsageOutputSchema } from "./contracts/dashboard-usage";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { notificationSchema, receiptSchema, statusSchema } from "./schemas";
import { machineSchema, machineInventorySchema, cliPolicySchema } from "./machine-contract";
import { telegramInfoSchema, telegramPreferenceSchema } from "./telegram-contract";
import { documentInput } from "./document-contract";
import {
  STAGE1_CONTRACT_VERSION,
  acceptArtifactVersionCommandSchema,
  attachJobInputCommandSchema,
  attachedJobInputSchema,
  activitySchema,
  agentSchema,
  agentVersionSchema,
  artifactSchema,
  artifactVersionSchema,
  bbProjectIdSchema,
  contentHashSchema,
  createActivityCommandSchema,
  createAgentVersionCommandSchema,
  createJobCommandSchema,
  createMembershipCommandSchema,
  removeMembershipCommandSchema,
  createPolicyVersionCommandSchema,
  createProcessVersionCommandSchema,
  createProjectBindingCommandSchema,
  agentVersionDraftSchema,
  saveAgentProfileCommandSchema,
  saveDepartmentProfileCommandSchema,
  departmentSchema,
  hostIdSchema,
  jobDependencySchema,
  boardPolicySchema,
  jobSchema,
  jobStateSchema,
  jobTransitionCommandSchema,
  actionIntentRecordSchema,
  catalogRuleRecordSchema,
  listedActionIntentSchema,
  listDispatcherCatalogCommandSchema,
  answerNeedsInputRecordSchema,
  answerNeedsInputRpcSchema,
  approveActionIntentCommandSchema,
  claimActionIntentCommandSchema,
  completeActionIntentCommandSchema,
  dispatchTickCommandSchema,
  dispatchTickRecordSchema,
  eventDefinitionRecordSchema,
  eventSourceRecordSchema,
  inboxEventRecordSchema,
  ingestInboxEventCommandSchema,
  listActionIntentsCommandSchema,
  needsInputRecordSchema,
  reportNeedsInputRpcSchema,
  ruleVersionRecordSchema,
  saveEventDefinitionCommandSchema,
  saveEventSourceCommandSchema,
  saveRuleVersionCommandSchema,
  membershipSchema,
  opaqueIdSchema,
  policyVersionSchema,
  processVersionSchema,
  projectBindingSchema,
  projectDepartmentSchema,
  relativePathSchema,
  requestIdSchema,
  updateAgentCommandSchema,
  updateDepartmentCommandSchema,
  updateJobCommandSchema,
  updateProjectBindingCommandSchema,
  bindingLifecycleCommandSchema,
  setDepartmentAvailabilityCommandSchema,
  unlinkDepartmentCommandSchema,
} from "./contracts";

export {
  answerNeedsInputRpcSchema,
  approveActionIntentCommandSchema,
  claimActionIntentCommandSchema,
  completeActionIntentCommandSchema,
  dispatchTickCommandSchema,
  ingestInboxEventCommandSchema,
  listActionIntentsCommandSchema,
  listDispatcherCatalogCommandSchema,
  reportNeedsInputRpcSchema,
  saveEventDefinitionCommandSchema,
  saveEventSourceCommandSchema,
  saveRuleVersionCommandSchema,
};

export const domainErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export function domainResultSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }).strict(),
    z.object({ ok: z.literal(false), error: domainErrorSchema }).strict(),
  ]);
}

export const catalogIsolationSchema = z
  .object({
    catalogSkillsIsolated: z.literal(false),
    catalogMcpIsolated: z.literal(false),
    execution: z.literal("unavailable"),
    reason: z.string(),
  })
  .strict();

export const claimedScopeSchema = z
  .object({
    claimedBbProjectId: bbProjectIdSchema.optional(),
  })
  .strict();

export const listWorkspaceInputSchema = z
  .object({
    bindingId: opaqueIdSchema.optional(),
    claimedBbProjectId: bbProjectIdSchema.optional(),
  })
  .strict();

export const jobCountsSchema = z.record(jobStateSchema, z.number().int().nonnegative());

export const workspaceBindingSchema = projectBindingSchema
  .extend({
    bbProjectName: z.string().min(1),
    environmentName: z.string().nullable(),
    hostName: z.string().nullable(),
    /** Project Folders sections of the binding folder, «Реклама / Telegram». */
    sectionPath: z.string().nullable().optional(),
  })
  .strict();

export const launchQueueEntrySchema = z
  .object({ jobId: z.string(), position: z.number().int().positive(), requestedAt: z.string(), waitingReason: z.string().nullable() })
  .strict();

export const workspaceSnapshotSchema = z
  .object({
    contractVersion: z.literal(STAGE1_CONTRACT_VERSION),
    isolation: catalogIsolationSchema,
    bindings: z.array(workspaceBindingSchema),
    jobs: z.array(jobSchema),
    counts: jobCountsSchema,
    agents: z.array(agentSchema),
    departments: z.array(departmentSchema),
    memberships: z.array(membershipSchema),
    agentVersions: z.array(agentVersionSchema),
    processVersions: z.array(processVersionSchema),
    projectDepartments: z.array(projectDepartmentSchema),
    policies: z.array(policyVersionSchema),
    board: boardPolicySchema.optional(),
    /** Hours before a due date the job reads as «due soon», by department id (work rules). */
    dueReminderHours: z.record(z.string(), z.number()).optional(),
    /** Jobs waiting in the launch queue, by job id. */
    launchQueue: z.record(z.string(), launchQueueEntrySchema).optional(),
    /** Jobs of archived trees, left out of `jobs`. */
    archivedCount: z.number().int().min(0).optional(),
    /** Goal of each main job that has one, by job id. */
    jobGoals: z.record(z.string(), z.string()).optional(),
    /** Parent department of each subordinate department, by department id. */
    departmentParents: z.record(z.string(), z.string()).optional(),
    /** Open escalations: department a job was escalated to, by job id. */
    escalations: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const capabilityRowSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    source: z.string().min(1),
  })
  .strict();

export const capabilityCatalogSchema = z
  .object({
    skills: z.array(capabilityRowSchema),
    mcps: z.array(capabilityRowSchema),
    skillDiscovery: z.enum(["sdk", "unavailable"]),
    mcpDiscovery: z.literal("unavailable"),
    isolation: catalogIsolationSchema,
  })
  .strict();

export const capabilityCatalogInputSchema = z
  .object({
    bindingId: opaqueIdSchema.optional(),
    projectId: z.string().trim().min(1).max(160).optional(),
    environmentId: z.string().trim().min(1).max(160).nullable().optional(),
  })
  .strict();

export const bbCatalogSchema = z
  .object({
    projects: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }).strict()),
    environments: z.array(
      z
        .object({
          id: z.string().min(1),
          projectId: z.string().min(1),
          hostId: z.string().min(1),
          hostName: z.string().min(1),
          path: z.string().min(1),
          label: z.string().min(1),
        })
        .strict(),
    ),
    policies: z.array(z.object({ id: opaqueIdSchema, label: z.string().min(1) }).strict()),
    skills: z.array(capabilityRowSchema),
    mcps: z.array(capabilityRowSchema),
    skillDiscovery: z.enum(["sdk", "unavailable"]),
    mcpDiscovery: z.literal("unavailable"),
  })
  .strict();

export const getJobInputSchema = z
  .object({
    jobId: opaqueIdSchema.optional(),
    key: z.string().regex(/^AG-\d{1,8}$/).optional(),
    claimedBbProjectId: bbProjectIdSchema.optional(),
  })
  .strict()
  .refine((value) => Boolean(value.jobId || value.key), "jobId or key is required");

export const jobDetailSchema = z
  .object({
    job: jobSchema,
    binding: projectBindingSchema,
    activity: z.array(activitySchema),
    dependencies: z.array(jobDependencySchema),
    artifacts: z.array(
      z
        .object({
          artifact: artifactSchema,
          versions: z.array(artifactVersionSchema),
        })
        .strict(),
    ),
    needsInput: needsInputRecordSchema.nullable(),
  })
  .strict();

export const getAgentInputSchema = z.object({ agentId: opaqueIdSchema }).strict();
export const agentDetailSchema = z
  .object({
    agent: agentSchema,
    version: agentVersionSchema.optional(),
    isolation: catalogIsolationSchema,
  })
  .strict();

export const getDepartmentInputSchema = z.object({ departmentId: opaqueIdSchema }).strict();
export const departmentDetailSchema = z
  .object({
    department: departmentSchema,
    process: processVersionSchema.optional(),
    memberships: z.array(membershipSchema),
  })
  .strict();

export const listActivityInputSchema = z
  .object({
    jobId: opaqueIdSchema,
    claimedBbProjectId: bbProjectIdSchema.optional(),
  })
  .strict();

export const listArtifactVersionsInputSchema = z
  .object({
    artifactId: opaqueIdSchema,
    jobId: opaqueIdSchema,
    claimedBbProjectId: bbProjectIdSchema.optional(),
  })
  .strict();

const claimed = { claimedBbProjectId: bbProjectIdSchema.optional() };

export const createJobRpcSchema = createJobCommandSchema.extend(claimed).strict();
export const updateJobRpcSchema = updateJobCommandSchema.extend(claimed).strict();
export const transitionJobRpcSchema = jobTransitionCommandSchema.extend(claimed).strict();
export const updateBindingRpcSchema = updateProjectBindingCommandSchema.extend(claimed).strict();
export const bindingLifecycleRpcSchema = bindingLifecycleCommandSchema.extend(claimed).strict();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const readProjectRulesInputSchema = z.object({ bindingId: opaqueIdSchema }).strict();
export const projectRulesRecordSchema = z
  .object({
    bindingId: opaqueIdSchema,
    relativePath: z.string().min(1),
    exists: z.boolean(),
    text: z.string().nullable(),
    hash: sha256Schema.nullable(),
    size: z.number().int().nonnegative().nullable(),
    /** project-folders template block is present in the file. */
    managedBlock: z.boolean(),
  })
  .strict();
export const saveProjectRulesInputSchema = z
  .object({
    requestId: requestIdSchema,
    bindingId: opaqueIdSchema,
    /** Hash the editor opened; null when the file did not exist. */
    expectedHash: sha256Schema.nullable(),
    text: z.string().max(256 * 1024),
  })
  .strict();
export const unlinkDepartmentRpcSchema = unlinkDepartmentCommandSchema.extend(claimed).strict();
export const createActivityRpcSchema = createActivityCommandSchema
  .omit({ actor: true })
  .extend(claimed)
  .strict();
export const createArtifactRpcSchema = z
  .object({
    requestId: requestIdSchema,
    jobId: opaqueIdSchema,
    claimedBbProjectId: bbProjectIdSchema.optional(),
  })
  .strict();
export const ARTIFACT_UPLOAD_MAX_BASE64 = 8 * 1024 * 1024;

export const publishArtifactRpcSchema = z
  .object({
    requestId: requestIdSchema,
    artifactId: opaqueIdSchema,
    jobId: opaqueIdSchema,
    relativePath: relativePathSchema,
    mime: z.string().trim().min(1).max(180),
    size: z.number().int().nonnegative(),
    hash: contentHashSchema,
    bytesBase64: z.string().min(1).max(ARTIFACT_UPLOAD_MAX_BASE64),
    claimedBbProjectId: bbProjectIdSchema.optional(),
  })
  .strict();
export const acceptArtifactRpcSchema = acceptArtifactVersionCommandSchema.extend(claimed).strict();
export const openArtifactRpcSchema = z
  .object({
    artifactId: opaqueIdSchema,
    jobId: opaqueIdSchema,
    version: z.number().int().positive(),
    claimedBbProjectId: bbProjectIdSchema.optional(),
  })
  .strict();
export const openArtifactOutputSchema = z
  .object({
    hostId: z.string().min(1),
    size: z.number().int().nonnegative(),
    hash: z.string(),
    bytesBase64: z.string(),
    target: z.object({ hostId: z.string().min(1), path: z.string().min(1) }).strict(),
  })
  .strict();
export const resolveArtifactPreviewInputSchema = z
  .object({
    hostId: hostIdSchema,
    path: z.string().trim().min(1).max(2048),
  })
  .strict();
export const resolveArtifactPreviewOutputSchema = z
  .object({
    artifactId: opaqueIdSchema,
    jobId: opaqueIdSchema,
    version: z.number().int().positive(),
    hash: contentHashSchema,
    mime: z.string().trim().min(1).max(180),
    size: z.number().int().nonnegative(),
    relativePath: relativePathSchema,
    bindingId: opaqueIdSchema,
    target: z.object({ hostId: hostIdSchema, path: z.string().min(1) }).strict(),
  })
  .strict();
export const linkDepartmentRpcSchema = z
  .object({
    requestId: requestIdSchema,
    bindingId: opaqueIdSchema,
    departmentId: opaqueIdSchema,
    claimedBbProjectId: bbProjectIdSchema.optional(),
  })
  .strict();
export const provisionAgentRpcSchema = z
  .object({
    requestId: requestIdSchema,
    name: z.string().trim().min(1).max(180),
    state: z.enum(["active", "paused", "archived"]),
    version: agentVersionDraftSchema,
  })
  .strict();
export const provisionDepartmentRpcSchema = z
  .object({
    requestId: requestIdSchema,
    name: z.string().trim().min(1).max(180),
    leadAgentId: opaqueIdSchema,
    process: z
      .object({
        instructions: z.string().trim().min(1).max(40_000),
        acceptance: z.string().trim().min(1).max(20_000),
        reviewPolicy: z.object({ required: z.boolean() }).strict(),
      })
      .strict(),
  })
  .strict();

export const attachJobInputRpcSchema = attachJobInputCommandSchema;

export const prepareLaunchRpcSchema = z
  .object({
    requestId: requestIdSchema,
    jobId: opaqueIdSchema,
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export const enqueueLaunchRpcSchema = z
  .object({
    requestId: requestIdSchema,
    jobId: opaqueIdSchema,
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export const dequeueLaunchRpcSchema = z.object({ jobId: opaqueIdSchema }).strict();
export const getLaunchRpcSchema = z
  .object({
    requestId: requestIdSchema.optional(),
    launchId: z.string().uuid().optional(),
    attemptId: opaqueIdSchema.optional(),
  })
  .strict()
  .refine((value) => Boolean(value.launchId || value.attemptId), {
    message: "getLaunch needs launchId or attemptId",
  });
export const reconcileLaunchRpcSchema = z
  .object({
    requestId: requestIdSchema,
    attemptId: opaqueIdSchema,
    launchId: z.string().uuid(),
  })
  .strict();
export const cancelLaunchCommandSchema = z
  .object({
    requestId: requestIdSchema,
    jobId: opaqueIdSchema,
    attemptId: opaqueIdSchema,
    expectedJobRevision: z.number().int().positive(),
    expectedAttemptRevision: z.number().int().positive(),
    launchId: z.string().uuid(),
    threadId: z.string().trim().min(8).max(160),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
/** Owner returns a version in review for rework; the same worker thread continues. */
export const getWorkRulesInputSchema = z.object({ scope: workRulesScopeSchema }).strict();

/** Spend of one budgeted scope this calendar month (UTC), estimated at API prices. */
export const budgetStatusSchema = z
  .object({
    scope: workRulesScopeSchema,
    label: z.string(),
    monthStart: z.string(),
    limitUsd: z.number(),
    spendUsdCents: z.number(),
    percent: z.number(),
    warnPercent: z.number(),
  })
  .strict();

export type BudgetStatusView = z.infer<typeof budgetStatusSchema>;

export const templateKeySchema = z.enum(TEMPLATE_KEYS);
export const templateViewSchema = z
  .object({ key: templateKeySchema, text: z.string(), custom: z.boolean(), revision: z.number().int().min(0) })
  .strict();
export const saveTemplateInputSchema = z
  .object({ key: templateKeySchema, expectedRevision: z.number().int().min(0), text: z.string().max(40_000).nullable() })
  .strict();
export type TemplateView = z.infer<typeof templateViewSchema>;

export const agencyRulesVersionSchema = z
  .object({ id: z.string(), version: z.number().int().positive(), text: z.string(), hash: z.string(), createdAt: z.string() })
  .strict();
export const agencyRulesViewSchema = z
  .object({
    /** Rules in force; null when there are none. */
    current: agencyRulesVersionSchema.nullable(),
    /** Latest version number, including an empty one; pass it back as expectedVersion. */
    latestVersion: z.number().int().min(0),
    versions: z.array(agencyRulesVersionSchema),
  })
  .strict();
export const saveAgencyRulesInputSchema = z.object({ expectedVersion: z.number().int().min(0), text: z.string().max(20_000) }).strict();
export type AgencyRulesView = z.infer<typeof agencyRulesViewSchema>;

export const skillPinStatusSchema = z
  .object({
    origin: z.enum(["settings", "env-file", "data-dir-file", "none"]),
    editable: z.boolean(),
    hostIds: z.array(z.string()),
    rows: z.array(
      z
        .object({
          role: z.enum(["core", "helper"]),
          id: z.string(),
          name: z.string().nullable(),
          source: z.string(),
          pinnedHash: z.string(),
          currentHash: z.string().nullable(),
          problem: z.string().nullable(),
        })
        .strict(),
    ),
    inSync: z.boolean(),
    note: z.string().nullable(),
  })
  .strict();
export type SkillPinStatusView = z.infer<typeof skillPinStatusSchema>;

export const ruleScheduleSchema = z
  .object({
    ruleId: z.string().trim().min(8).max(80),
    expression: z.string().trim().min(9).max(120),
    timezone: z.string().trim().min(1).max(64),
    misfire: z.enum(["skip", "last", "catch_up"]),
  })
  .strict();
export const previewScheduleInputSchema = z.object({ expression: z.string().trim().min(1).max(120), timezone: z.string().trim().min(1).max(64) }).strict();
export const webhookSourceViewSchema = z
  .object({ sourceId: z.string(), url: z.string(), issuedAt: z.string().nullable(), topics: z.array(z.string()) })
  .strict();
export const rotatedWebhookSecretSchema = webhookSourceViewSchema.extend({ secret: z.string() }).strict();
export type RuleScheduleView = z.infer<typeof ruleScheduleSchema>;

export const knowledgeScopeKindSchema = z.enum(["agency", "department", "project"]);
export const knowledgeItemSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    body: z.string(),
    source: z.string(),
    scopeKind: knowledgeScopeKindSchema,
    scopeId: z.string().nullable(),
    status: z.enum(["proposal", "accepted", "archived"]),
    proposedBy: z.string().nullable(),
    revision: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export const saveKnowledgeInputSchema = z
  .object({
    id: z.string().optional(),
    expectedRevision: z.number().int().min(0),
    title: z.string().max(200),
    body: z.string().max(20_000),
    source: z.string().max(500),
    scopeKind: knowledgeScopeKindSchema,
    scopeId: z.string().nullable(),
  })
  .strict();
export const goalViewSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    status: z.enum(["active", "done", "dropped"]),
    dueAt: z.string().nullable(),
    revision: z.number().int(),
    jobIds: z.array(z.string()),
    progress: z.object({ total: z.number().int(), done: z.number().int(), open: z.number().int() }).strict(),
  })
  .strict();
export const saveGoalInputSchema = z
  .object({ id: z.string().optional(), expectedRevision: z.number().int().min(0), title: z.string().max(200), description: z.string().max(4_000), status: z.enum(["active", "done", "dropped"]), dueAt: z.string().nullable() })
  .strict();
export const agentMetricsSchema = z
  .object({
    agentId: z.string(),
    open: z.number(),
    blocked: z.number(),
    inReview: z.number(),
    done30d: z.number(),
    canceled30d: z.number(),
    medianLeadHours: z.number().nullable(),
    firstPassPercent: z.number().nullable(),
    reworkReturns90d: z.number(),
    attempts30d: z.number(),
    failedAttempts30d: z.number(),
    lastActivityAt: z.string().nullable(),
    spendUsdCents30d: z.number().nullable(),
  })
  .strict();
export const jobSearchHitSchema = z
  .object({ jobId: z.string(), key: z.string(), title: z.string(), state: z.string(), archived: z.boolean(), field: z.enum(["key", "title", "brief", "comment"]), snippet: z.string() })
  .strict();
export const savedViewSchema = z.object({ id: z.string(), name: z.string(), filters: z.record(z.string(), z.string()), updatedAt: z.string() }).strict();
export type KnowledgeItemView = z.infer<typeof knowledgeItemSchema>;
export const backupFileSchema = z.object({ name: z.string(), size: z.number().int(), createdAt: z.string() }).strict();
export type BackupFileView = z.infer<typeof backupFileSchema>;
export type GoalViewRecord = z.infer<typeof goalViewSchema>;
export type AgentMetricsView = z.infer<typeof agentMetricsSchema>;
export type JobSearchHitView = z.infer<typeof jobSearchHitSchema>;
export type SavedViewRecord = z.infer<typeof savedViewSchema>;
export type WebhookSourceView = z.infer<typeof webhookSourceViewSchema>;

export const returnJobForReworkCommandSchema = z
  .object({
    requestId: requestIdSchema,
    jobId: opaqueIdSchema,
    expectedRevision: z.number().int().positive(),
    comment: z.string().trim().min(1).max(8_000),
  })
  .strict();
export type ReturnJobForReworkCommand = z.infer<typeof returnJobForReworkCommandSchema>;
export const cancelLaunchRecordSchema = z
  .object({
    jobId: opaqueIdSchema,
    jobState: z.literal("blocked"),
    jobRevision: z.number().int().positive(),
    attemptId: opaqueIdSchema,
    attemptState: z.literal("canceled"),
    attemptRevision: z.number().int().positive(),
    launchId: z.string().uuid(),
    threadId: z.string(),
    reason: z.string(),
    observedStop: z
      .object({
        stopAck: z.literal(true),
        getStatus: z.enum(["idle", "error"]),
        listRunningPresent: z.literal(false),
      })
      .strict(),
    writerDeadClaimed: z.literal(false),
    replay: z.boolean(),
  })
  .strict();
export type CancelLaunchRecord = z.infer<typeof cancelLaunchRecordSchema>;
export const interpretWorkerCompletionRpcSchema = z
  .object({
    jobId: opaqueIdSchema,
    launchId: z.string().uuid().optional(),
  })
  .strict();

export const sidebarExecutingJobCountSchema = z.discriminatedUnion("available", [
  z
    .object({
      available: z.literal(true),
      executingJobCount: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ available: z.literal(false) }).strict(),
]);

export const sidebarInProgressJobCountSchema = z.discriminatedUnion("available", [
  z
    .object({
      available: z.literal(true),
      inProgressJobCount: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ available: z.literal(false) }).strict(),
]);

export const listJobAttemptsRpcSchema = z
  .object({
    jobId: opaqueIdSchema,
    claimedBbProjectId: bbProjectIdSchema.optional(),
  })
  .strict();

/** Public attempt states including `awaiting_review`. UI: see awaiting-review-contract.md */
export const RUN_ATTEMPT_STATE_VALUES = [
  "prepared",
  "launching",
  "running",
  "waiting_input",
  "awaiting_review",
  "succeeded",
  "failed",
  "canceled",
  "unknown",
] as const;

export const runAttemptStateSchema = z.enum(RUN_ATTEMPT_STATE_VALUES);

export const publicRunAttemptSchema = z
  .object({
    attemptId: opaqueIdSchema,
    jobId: opaqueIdSchema,
    attemptNo: z.number().int().positive(),
    snapshotId: opaqueIdSchema,
    digest: contentHashSchema,
    threadId: z.string().nullable(),
    launchId: z.string().uuid().nullable(),
    state: runAttemptStateSchema,
    revision: z.number().int().positive(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const listJobAttemptsOutputSchema = z
  .object({
    jobId: opaqueIdSchema,
    attempts: z.array(publicRunAttemptSchema),
  })
  .strict();

export const getIsolationReadinessRpcSchema = z
  .object({
    jobId: opaqueIdSchema.optional(),
  })
  .strict();

export const liveAssignedProviderSchema = z
  .object({
    jobId: opaqueIdSchema,
    agentId: opaqueIdSchema,
    agentVersionId: opaqueIdSchema,
    providerId: z.string().trim().min(1),
    source: z.literal("live_assigned_agent_version"),
  })
  .strict();

/** Product-facing codes. `reason` stays English technical text. */
export const LAUNCH_REASON_CODES = [
  "ok",
  "assignee_required",
  "assignee_not_member",
  "handshake_unready",
  "isolation_unproven",
  "launch_not_authorized",
] as const;

export type LaunchReasonCode = (typeof LAUNCH_REASON_CODES)[number];

export const launchReasonCodeSchema = z.enum(LAUNCH_REASON_CODES);

export function publicLaunchReasonCode(input: {
  assignedErrorCode?: string | null;
  handshakeReady: boolean;
  sdkTypedSpawnReady: boolean;
  launchAllowed: boolean;
  hasJobId: boolean;
}): LaunchReasonCode {
  if (input.assignedErrorCode === "assignee_required") return "assignee_required";
  if (input.assignedErrorCode === "assignee_not_member") return "assignee_not_member";
  if (input.assignedErrorCode === "provider_isolation_unproven") return "isolation_unproven";
  if (input.assignedErrorCode) return "launch_not_authorized";
  if (!input.hasJobId) return "launch_not_authorized";
  if (!input.handshakeReady || !input.sdkTypedSpawnReady) return "handshake_unready";
  if (input.launchAllowed) return "ok";
  return "isolation_unproven";
}

export const isolationReadinessSchema = z
  .object({
    handshakeReady: z.boolean(),
    executionAvailable: z.boolean(),
    isolationReady: z.boolean(),
    isolatedSpawnFields: z.boolean(),
    sdkTypedSpawnReady: z.boolean(),
    provenIsolationProviders: z.array(z.literal("claude-code")).min(1),
    assignedProvider: liveAssignedProviderSchema.nullable(),
    launchAllowedForAssigned: z.boolean(),
    reason: z.string(),
    reasonCode: launchReasonCodeSchema,
    /** Budget warnings: the launch is allowed, the owner should know. */
    warnings: z.array(z.string()).optional(),
    /** The launch waits for a limit (concurrency or budget): the job can go to the launch queue. */
    waitable: z.boolean().optional(),
  })
  .strict();

const demoDocumentOutput = z.object({ hostId: z.string(), path: z.string(), demo: z.literal(true) }).strict();

export const rpcContract = defineRpcContract({
  prepareDemoDocument: { input: documentInput, output: demoDocumentOutput },
  prepareDocument: { input: documentInput, output: demoDocumentOutput },
  telegramInfo: { input: z.null(), output: telegramInfoSchema },
  telegramPreferences: { input: z.null(), output: telegramPreferenceSchema },
  configureTelegram: { input: telegramPreferenceSchema, output: z.object({ saved: z.literal(true) }) },
  machines: { input: z.null(), output: z.array(machineSchema) },
  agencyLanguage: { input: z.null(), output: z.object({ language: z.enum(["ru", "en"]) }).strict() },
  listBudgets: { input: z.null(), output: domainResultSchema(z.array(budgetStatusSchema)) },
  listTemplates: { input: z.null(), output: domainResultSchema(z.array(templateViewSchema)) },
  getSkillPins: { input: z.null(), output: domainResultSchema(skillPinStatusSchema) },
  listBackups: { input: z.null(), output: domainResultSchema(z.array(backupFileSchema)) },
  createBackup: { input: z.null(), output: domainResultSchema(backupFileSchema) },
  restoreBackup: { input: z.object({ name: z.string().max(200) }).strict(), output: domainResultSchema(z.object({ restored: z.string(), safetyBackup: backupFileSchema, tables: z.number().int() }).strict()) },
  listKnowledge: { input: z.null(), output: domainResultSchema(z.array(knowledgeItemSchema)) },
  saveKnowledge: { input: saveKnowledgeInputSchema, output: domainResultSchema(knowledgeItemSchema) },
  setKnowledgeStatus: { input: z.object({ id: z.string(), expectedRevision: z.number().int(), status: z.enum(["proposal", "accepted", "archived"]) }).strict(), output: domainResultSchema(knowledgeItemSchema) },
  listGoals: { input: z.null(), output: domainResultSchema(z.array(goalViewSchema)) },
  saveGoal: { input: saveGoalInputSchema, output: domainResultSchema(goalViewSchema) },
  setJobGoal: { input: z.object({ jobId: z.string(), goalId: z.string().nullable() }).strict(), output: domainResultSchema(z.object({ jobId: z.string(), goalId: z.string().nullable() }).strict()) },
  setDepartmentParent: { input: z.object({ departmentId: z.string(), parentDepartmentId: z.string().nullable() }).strict(), output: domainResultSchema(z.object({ departmentId: z.string(), parentDepartmentId: z.string().nullable() }).strict()) },
  agentMetrics: { input: z.object({ agentId: z.string() }).strict(), output: domainResultSchema(agentMetricsSchema) },
  searchJobs: { input: z.object({ query: z.string().max(200), limit: z.number().int().min(1).max(200).optional() }).strict(), output: domainResultSchema(z.array(jobSearchHitSchema)) },
  listArchivedJobs: { input: z.object({ limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional() }).strict(), output: domainResultSchema(z.object({ total: z.number().int(), jobs: z.array(jobSchema) }).strict()) },
  listSavedViews: { input: z.null(), output: domainResultSchema(z.array(savedViewSchema)) },
  saveSavedView: { input: z.object({ id: z.string().optional(), name: z.string().max(80), filters: z.record(z.string(), z.string()) }).strict(), output: domainResultSchema(savedViewSchema) },
  deleteSavedView: { input: z.object({ id: z.string() }).strict(), output: domainResultSchema(z.object({ removed: z.boolean() }).strict()) },
  saveRuleSchedule: { input: ruleScheduleSchema, output: domainResultSchema(ruleScheduleSchema) },
  listRuleSchedules: { input: z.null(), output: domainResultSchema(z.array(ruleScheduleSchema)) },
  previewSchedule: { input: previewScheduleInputSchema, output: domainResultSchema(z.array(z.string())) },
  getWebhookSource: { input: z.object({ sourceId: z.string() }).strict(), output: domainResultSchema(webhookSourceViewSchema) },
  rotateWebhookSecret: { input: z.object({ sourceId: z.string() }).strict(), output: domainResultSchema(rotatedWebhookSecretSchema) },
  saveSourceTopics: { input: z.object({ sourceId: z.string(), topics: z.array(z.string()).max(32) }).strict(), output: domainResultSchema(webhookSourceViewSchema) },
  enqueueLaunch: { input: enqueueLaunchRpcSchema, output: domainResultSchema(launchQueueEntrySchema) },
  dequeueLaunch: { input: dequeueLaunchRpcSchema, output: domainResultSchema(z.object({ removed: z.boolean() }).strict()) },
  pinSkills: { input: z.null(), output: domainResultSchema(skillPinStatusSchema) },
  saveTemplate: { input: saveTemplateInputSchema, output: domainResultSchema(templateViewSchema) },
  getAgencyRules: { input: z.null(), output: domainResultSchema(agencyRulesViewSchema) },
  saveAgencyRules: { input: saveAgencyRulesInputSchema, output: domainResultSchema(agencyRulesViewSchema) },
  setAgencyLanguage: { input: z.object({ language: z.enum(["ru", "en"]) }).strict(), output: z.object({ language: z.enum(["ru", "en"]) }).strict() },
  machineInventory: { input: z.object({ hostId: z.string().min(1) }).strict(), output: machineInventorySchema },
  setCliPolicy: {
    input: z.object({ hostId: z.string().min(1), providerId: z.string().min(1), policy: cliPolicySchema }).strict(),
    output: z.object({ saved: z.literal(true) }),
  },
  uiContext: { input: z.null(), output: z.object({ hosts: z.array(z.object({ id: z.string(), name: z.string() })), primaryHostId: z.string().nullable().optional() }) },
  status: { input: z.null(), output: statusSchema },
  notify: { input: notificationSchema, output: receiptSchema },
  sidebarExecutingJobCount: { input: z.null(), output: sidebarExecutingJobCountSchema },
  sidebarInProgressJobCount: { input: z.null(), output: sidebarInProgressJobCountSchema },
  listWorkspace: { input: listWorkspaceInputSchema, output: domainResultSchema(workspaceSnapshotSchema) },
  listBbCatalog: { input: z.null(), output: domainResultSchema(bbCatalogSchema) },
  listCapabilityCatalog: { input: capabilityCatalogInputSchema, output: domainResultSchema(capabilityCatalogSchema) },
  getJob: { input: getJobInputSchema, output: domainResultSchema(jobDetailSchema) },
  getAgent: { input: getAgentInputSchema, output: domainResultSchema(agentDetailSchema) },
  getDepartment: { input: getDepartmentInputSchema, output: domainResultSchema(departmentDetailSchema) },
  listActivity: { input: listActivityInputSchema, output: domainResultSchema(z.array(activitySchema)) },
  listArtifactVersions: { input: listArtifactVersionsInputSchema, output: domainResultSchema(z.array(artifactVersionSchema)) },
  createPolicyVersion: { input: createPolicyVersionCommandSchema, output: domainResultSchema(policyVersionSchema) },
  createAgentVersion: { input: createAgentVersionCommandSchema, output: domainResultSchema(agentVersionSchema) },
  createProcessVersion: { input: createProcessVersionCommandSchema, output: domainResultSchema(processVersionSchema) },
  saveAgentProfile: {
    input: saveAgentProfileCommandSchema,
    output: domainResultSchema(z.object({ agent: agentSchema, version: agentVersionSchema }).strict()),
  },
  saveDepartmentProfile: {
    input: saveDepartmentProfileCommandSchema,
    output: domainResultSchema(
      z.object({ department: departmentSchema, process: processVersionSchema, memberships: z.array(membershipSchema) }).strict(),
    ),
  },
  provisionAgent: {
    input: provisionAgentRpcSchema,
    output: domainResultSchema(z.object({ agent: agentSchema, version: agentVersionSchema }).strict()),
  },
  updateAgent: { input: updateAgentCommandSchema, output: domainResultSchema(agentSchema) },
  provisionDepartment: {
    input: provisionDepartmentRpcSchema,
    output: domainResultSchema(
      z.object({ department: departmentSchema, process: processVersionSchema, membership: membershipSchema }).strict(),
    ),
  },
  updateDepartment: { input: updateDepartmentCommandSchema, output: domainResultSchema(departmentSchema) },
  addMembership: { input: createMembershipCommandSchema, output: domainResultSchema(membershipSchema) },
  removeMembership: { input: removeMembershipCommandSchema, output: domainResultSchema(membershipSchema) },
  createProjectBinding: { input: createProjectBindingCommandSchema, output: domainResultSchema(projectBindingSchema) },
  updateProjectBinding: { input: updateBindingRpcSchema, output: domainResultSchema(projectBindingSchema) },
  linkDepartment: { input: linkDepartmentRpcSchema, output: domainResultSchema(projectDepartmentSchema) },
  unlinkDepartment: { input: unlinkDepartmentRpcSchema, output: domainResultSchema(projectDepartmentSchema) },
  archiveProjectBinding: { input: bindingLifecycleRpcSchema, output: domainResultSchema(projectBindingSchema) },
  restoreProjectBinding: { input: bindingLifecycleRpcSchema, output: domainResultSchema(projectBindingSchema) },
  deleteProjectBinding: {
    input: bindingLifecycleRpcSchema,
    output: domainResultSchema(z.object({ bindingId: opaqueIdSchema }).strict()),
  },
  setDepartmentAvailability: { input: setDepartmentAvailabilityCommandSchema, output: domainResultSchema(departmentSchema) },
  getWorkRules: { input: getWorkRulesInputSchema, output: domainResultSchema(workRulesViewSchema) },
  saveWorkRules: { input: saveWorkRulesCommandSchema, output: domainResultSchema(workRulesViewSchema) },
  readProjectRules: { input: readProjectRulesInputSchema, output: domainResultSchema(projectRulesRecordSchema) },
  saveProjectRules: {
    input: saveProjectRulesInputSchema,
    output: domainResultSchema(
      z.object({ bindingId: opaqueIdSchema, relativePath: z.string().min(1), hash: sha256Schema, size: z.number().int().nonnegative() }).strict(),
    ),
  },
  createJob: { input: createJobRpcSchema, output: domainResultSchema(jobSchema) },
  updateJob: { input: updateJobRpcSchema, output: domainResultSchema(jobSchema) },
  transitionJob: { input: transitionJobRpcSchema, output: domainResultSchema(jobSchema) },
  listDashboardUsage: { input: listDashboardUsageInputSchema, output: domainResultSchema(listDashboardUsageOutputSchema) },
  createActivity: { input: createActivityRpcSchema, output: domainResultSchema(activitySchema) },
  createArtifact: { input: createArtifactRpcSchema, output: domainResultSchema(artifactSchema) },
  publishArtifactVersion: { input: publishArtifactRpcSchema, output: domainResultSchema(artifactVersionSchema) },
  attachJobInput: { input: attachJobInputRpcSchema, output: domainResultSchema(attachedJobInputSchema) },
  reportNeedsInput: { input: reportNeedsInputRpcSchema, output: domainResultSchema(needsInputRecordSchema) },
  answerNeedsInput: { input: answerNeedsInputRpcSchema, output: domainResultSchema(answerNeedsInputRecordSchema) },
  acceptArtifactVersion: { input: acceptArtifactRpcSchema, output: domainResultSchema(artifactVersionSchema) },
  openArtifact: { input: openArtifactRpcSchema, output: domainResultSchema(openArtifactOutputSchema) },
  resolveArtifactPreview: {
    input: resolveArtifactPreviewInputSchema,
    output: domainResultSchema(resolveArtifactPreviewOutputSchema),
  },
  prepareLaunch: {
    input: prepareLaunchRpcSchema,
    output: domainResultSchema(z.unknown()),
  },
  getLaunch: {
    input: getLaunchRpcSchema,
    output: domainResultSchema(z.unknown()),
  },
  reconcileLaunch: {
    input: reconcileLaunchRpcSchema,
    output: domainResultSchema(z.unknown()),
  },
  interpretWorkerCompletion: {
    input: interpretWorkerCompletionRpcSchema,
    output: domainResultSchema(
      z
        .object({
          runSucceeded: z.literal(false),
          runFailed: z.boolean(),
          mayEnterReview: z.boolean(),
          publishedVerified: z.boolean(),
          acceptedVerified: z.boolean(),
          threadStatus: z.string().nullable(),
          reason: z.string(),
        })
        .strict(),
    ),
  },
  listJobAttempts: {
    input: listJobAttemptsRpcSchema,
    output: domainResultSchema(listJobAttemptsOutputSchema),
  },
  getIsolationReadiness: {
    input: getIsolationReadinessRpcSchema,
    output: domainResultSchema(isolationReadinessSchema),
  },
  cancelLaunch: {
    input: cancelLaunchCommandSchema,
    output: domainResultSchema(cancelLaunchRecordSchema),
  },
  returnJobForRework: {
    input: returnJobForReworkCommandSchema,
    output: domainResultSchema(jobSchema),
  },
  saveEventDefinition: { input: saveEventDefinitionCommandSchema, output: domainResultSchema(eventDefinitionRecordSchema) },
  saveEventSource: { input: saveEventSourceCommandSchema, output: domainResultSchema(eventSourceRecordSchema) },
  saveRuleVersion: { input: saveRuleVersionCommandSchema, output: domainResultSchema(ruleVersionRecordSchema) },
  ingestInboxEvent: { input: ingestInboxEventCommandSchema, output: domainResultSchema(inboxEventRecordSchema) },
  dispatchTick: { input: dispatchTickCommandSchema, output: domainResultSchema(dispatchTickRecordSchema) },
  listEventDefinitions: { input: listDispatcherCatalogCommandSchema, output: domainResultSchema(z.array(eventDefinitionRecordSchema)) },
  listEventSources: { input: listDispatcherCatalogCommandSchema, output: domainResultSchema(z.array(eventSourceRecordSchema)) },
  listRuleVersions: { input: listDispatcherCatalogCommandSchema, output: domainResultSchema(z.array(catalogRuleRecordSchema)) },
  listActionIntents: { input: listActionIntentsCommandSchema, output: domainResultSchema(z.array(listedActionIntentSchema)) },
  claimActionIntent: { input: claimActionIntentCommandSchema, output: domainResultSchema(actionIntentRecordSchema) },
  approveActionIntent: { input: approveActionIntentCommandSchema, output: domainResultSchema(actionIntentRecordSchema) },
  completeActionIntent: { input: completeActionIntentCommandSchema, output: domainResultSchema(actionIntentRecordSchema) },
});
