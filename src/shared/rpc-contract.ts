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
  createCommandSchema,
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

const kitLanguageSchema = z.enum(["ru", "en"]);
/**
 * What BB knows about a provider's subscription: the plan and its windows. This is the only
 * spending a CLI without token events (Cursor, OpenCode, Antigravity) reports at all.
 */
export const providerUsageSchema = z
  .object({
    providerId: z.string(),
    name: z.string(),
    status: z.enum(["ok", "not_installed", "unauthenticated", "expired", "error"]),
    planLabel: z.string().nullable(),
    message: z.string().optional(),
    /** True when the Agency counts this CLI's tokens itself. */
    countsTokens: z.boolean(),
    windows: z.array(
      z
        .object({
          label: z.string(),
          usedPercent: z.number(),
          resetsAt: z.string().nullable(),
          usedUsdCents: z.number().optional(),
          limitUsdCents: z.number().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type ProviderUsageView = z.infer<typeof providerUsageSchema>;

/** A price of one model, USD per million tokens, as the settings table edits it. */
export const modelPriceRowSchema = z
  .object({
    model: z.string().min(1).max(120),
    input: z.number().min(0).max(100_000),
    cachedInput: z.number().min(0).max(100_000),
    output: z.number().min(0).max(100_000),
  })
  .strict();

export const modelPricesViewSchema = z
  .object({
    rows: z.array(modelPriceRowSchema.extend({ custom: z.boolean() })),
    /** Models the employees are set to run: the ones worth a price first. */
    usedModels: z.array(z.string()),
    checkedAt: z.string(),
    source: z.string(),
    /** The stored settings value could not be read; built-in prices are in use. */
    error: z.string().nullable(),
  })
  .strict();

/** One employee against the models this BB can actually run. */
export const agentModelRowSchema = z
  .object({
    agentId: z.string(),
    name: z.string(),
    providerId: z.string(),
    model: z.string(),
    status: z.enum(["exact", "substituted", "missing", "unchanged", "repaired", "blocked"]),
    suggestedProviderId: z.string().nullable(),
    suggestedModel: z.string().nullable(),
    note: z.string().nullable(),
  })
  .strict();

export const agentModelsViewSchema = z
  .object({
    /** The machine whose catalog was read; null when no project is connected. */
    hostId: z.string().nullable(),
    /** BB could not list models: nothing is judged and nothing is blocked. */
    catalogUnavailable: z.boolean(),
    rows: z.array(agentModelRowSchema),
  })
  .strict();

export type AgentModelsView = z.infer<typeof agentModelsViewSchema>;

/** Как в этом проекте делают такой вид результата: голос, стиль, эталоны. */
/** Оценщик: настройки, точки решения и состояние ключа. Значение ключа сюда не приходит. */
export const decisionSettingsSchema = z
  .object({
    enabled: z.boolean(),
    endpointKind: z.enum(["openrouter", "typesafe", "custom"]),
    baseUrl: z.string(),
    model: z.string(),
    keySource: z.enum(["env-catalog", "machine-env"]),
    keyName: z.string(),
    timeoutMs: z.number().int(),
    points: z.array(z.string()),
    revision: z.number().int(),
  })
  .strict();

export const decisionViewSchema = z
  .object({
    settings: decisionSettingsSchema,
    points: z.array(z.object({ key: z.string(), title: z.string(), hint: z.string(), threshold: z.number() }).strict()),
    keyReady: z.boolean(),
    keyProblem: z.string().nullable(),
    catalogAvailable: z.boolean(),
    keyOptions: z.array(z.object({ name: z.string(), service: z.string().nullable(), masked: z.string().nullable() }).strict()),
  })
  .strict();

export const saveDecisionSettingsInputSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    enabled: z.boolean(),
    endpointKind: z.enum(["openrouter", "typesafe", "custom"]),
    baseUrl: z.string().max(300).optional(),
    model: z.string().max(120),
    keySource: z.enum(["env-catalog", "machine-env"]),
    keyName: z.string().max(120),
    timeoutMs: z.number().int().min(1_000).max(60_000).optional(),
    points: z.array(z.string().max(40)).max(20).optional(),
  })
  .strict();

export const decisionTestSchema = z.union([
  z.object({
    ok: z.literal(true),
    ms: z.number(),
    answers: z.array(z.object({ id: z.string(), value: z.union([z.string(), z.number(), z.boolean()]), confidence: z.number() }).strict()),
  }).strict(),
  z.object({ ok: z.literal(false), ms: z.number(), reason: z.string(), detail: z.string().nullable() }).strict(),
]);

export const workProfileSchema = z
  .object({
    id: z.string(),
    bbProjectId: z.string(),
    key: z.string(),
    title: z.string(),
    triggers: z.array(z.string()),
    body: z.string(),
    samples: z.array(z.object({ label: z.string(), ref: z.string(), note: z.string().optional() }).strict()),
    acceptance: z.string(),
    revision: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export type WorkProfileView = z.infer<typeof workProfileSchema>;

export const saveWorkProfileInputSchema = z
  .object({
    bbProjectId: z.string().min(1),
    key: z.string().min(1).max(60),
    expectedRevision: z.number().int().min(0),
    title: z.string().min(1).max(120),
    triggers: z.array(z.string().max(120)).max(20).default([]),
    body: z.string().min(1).max(20_000),
    samples: z
      .array(z.object({ label: z.string().min(1).max(120), ref: z.string().min(1).max(400), note: z.string().max(400).optional() }).strict())
      .max(20)
      .default([]),
    acceptance: z.string().max(2_000).default(""),
  })
  .strict();

export type ModelPricesView = z.infer<typeof modelPricesViewSchema>;
export type ModelPriceRowView = z.infer<typeof modelPricesViewSchema>["rows"][number];

export const starterKitViewSchema = z
  .object({
    departments: z.array(
      z
        .object({
          key: z.string(),
          name: z.string(),
          purpose: z.string(),
          agents: z.array(
            z
              .object({
                key: z.string(),
                name: z.string(),
                role: z.string(),
                roleType: z.enum(["lead", "executor", "reviewer", "assistant"]),
                /** CLI and model this employee is meant for; absent means the role default. */
                model: z.object({ providerId: z.string(), model: z.string(), label: z.string() }).strict().optional(),
              })
              .strict(),
          ),
          installed: z.object({ departmentId: z.string(), language: kitLanguageSchema.nullable() }).strict().nullable(),
        })
        .strict(),
    ),
    translatable: z.number().int(),
    edited: z.number().int(),
  })
  .strict();
export type StarterKitViewRecord = z.infer<typeof starterKitViewSchema>;
export const installStarterKitInputSchema = z.object({ keys: z.array(z.string().max(40)).min(1).max(20), language: kitLanguageSchema.optional() }).strict();
export const installStarterKitOutputSchema = z
  .object({
    installed: z.array(z.object({ key: z.string(), departmentId: z.string(), agents: z.number().int(), note: z.string().optional() }).strict()),
    skipped: z.array(z.object({ key: z.string(), reason: z.string() }).strict()),
  })
  .strict();
export const translateStarterKitOutputSchema = z
  .object({
    translated: z.number().int(),
    unchanged: z.number().int(),
    edited: z.array(z.object({ kind: z.enum(["department", "agent"]), name: z.string() }).strict()),
  })
  .strict();
export const recordLifecycleInputSchema = z.object({ kind: z.enum(["department", "agent"]), id: z.string().max(80) }).strict();
export const recordLifecycleSchema = z.object({ deletable: z.boolean(), reason: z.string().nullable(), archivedAt: z.string().nullable() }).strict();

/** A message to the owner from a script, watchdog or employee. */
export const ownerMessageSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    level: z.enum(["info", "warning"]),
    jobId: z.string().nullable(),
    jobKey: z.string().nullable(),
    source: z.string(),
    /** off — Telegram not used; queued; failed: reason. */
    telegram: z.string(),
    createdAt: z.string(),
    readAt: z.string().nullable(),
  })
  .strict();
export type OwnerMessageView = z.infer<typeof ownerMessageSchema>;
const dedupeKeySchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);
export const notifyOwnerInputSchema = z
  .object({
    text: z.string().trim().min(1).max(2000),
    level: z.enum(["info", "warning"]).optional(),
    /** Job id or AG-N key the message is about. */
    jobId: z.string().min(1).max(80).optional(),
    /** The same key is delivered once: put the date or state into it for recurring messages. */
    dedupeKey: dedupeKeySchema.optional(),
  })
  .strict();
export const notifyOwnerOutputSchema = z.object({ message: ownerMessageSchema, duplicate: z.boolean() }).strict();
export const ownerMessagesSchema = z.object({ messages: z.array(ownerMessageSchema), unread: z.number().int() }).strict();
export const ownerDigestInputSchema = z
  .object({
    kind: z.enum(["summary", "watchdog"]),
    sinceHours: z.number().int().min(1).max(168).optional(),
    stuckHours: z.number().int().min(1).max(720).optional(),
    /** Also send it to the owner; a watchdog sends only when something waits. */
    notify: z.boolean().optional(),
    dedupeKey: dedupeKeySchema.optional(),
  })
  .strict();
export const ownerDigestSchema = z
  .object({
    text: z.string(),
    level: z.enum(["info", "warning"]),
    items: z.array(z.object({ key: z.string(), title: z.string(), state: z.string(), since: z.string() }).strict()),
    counts: z.record(z.string(), z.number()),
    message: ownerMessageSchema.nullable(),
    duplicate: z.boolean(),
  })
  .strict();
export const scriptTemplateSchema = z.object({ id: z.string(), title: z.string(), description: z.string(), script: z.string() }).strict();

/** A job on the other end of a dependency, as the job card draws it. */
export const dependencyLinkSchema = z.object({ jobId: z.string(), key: z.string(), title: z.string(), state: z.string() }).strict();
export type DependencyLinkRecord = z.infer<typeof dependencyLinkSchema>;

/** Follow-up job the Agency creates by itself when this one is done. */
export const jobNextStepSchema = z
  .object({
    departmentId: opaqueIdSchema,
    title: z.string().trim().min(1).max(200),
    brief: z.string().trim().min(1).max(20_000),
    acceptance: z.string().trim().min(1).max(20_000),
    /** Who takes it: the department lead (default) or the least loaded member of that role type. */
    assignment: z.enum(["lead", "executor", "reviewer"]).default("lead"),
  })
  .strict();
export type JobNextStepRecord = z.infer<typeof jobNextStepSchema>;

export const nextStepViewSchema = z
  .object({
    step: jobNextStepSchema,
    createdJobId: z.string().nullable(),
    /** null while waiting; `created` or the reason it did not run. */
    outcome: z.string().nullable(),
    updatedAt: z.string(),
  })
  .strict();
export type NextStepViewRecord = z.infer<typeof nextStepViewSchema>;

export const addJobDependencyRpcSchema = createCommandSchema
  .extend({ jobId: opaqueIdSchema, dependsOnJobId: opaqueIdSchema, claimedBbProjectId: bbProjectIdSchema.optional() })
  .strict();
export const removeJobDependencyRpcSchema = z.object({ jobId: opaqueIdSchema, dependsOnJobId: opaqueIdSchema }).strict();
export const setJobNextStepRpcSchema = z.object({ jobId: opaqueIdSchema, step: jobNextStepSchema.nullable() }).strict();

export const jobDetailSchema = z
  .object({
    job: jobSchema,
    binding: projectBindingSchema,
    activity: z.array(activitySchema),
    dependencies: z.array(jobDependencySchema),
    links: z.object({ waitsFor: z.array(dependencyLinkSchema), blocks: z.array(dependencyLinkSchema) }).strict().optional(),
    nextStep: nextStepViewSchema.nullable().optional(),
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
    summary: z.string(),
    body: z.string(),
    kind: z.enum(["fact", "decision", "procedure", "preference", "reference", "lesson"]),
    importance: z.number().int(),
    pinned: z.boolean(),
    writeReason: z.string(),
    /** Сколько раз запись открывали из треда сотрудника: видно, работает она или лежит. */
    readCount: z.number().int(),
    lastReadAt: z.string().nullable(),
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
    summary: z.string().max(300).optional(),
    body: z.string().max(20_000),
    kind: z.enum(["fact", "decision", "procedure", "preference", "reference", "lesson"]).optional(),
    importance: z.number().int().min(0).max(100).optional(),
    pinned: z.boolean().optional(),
    writeReason: z.string().max(500).optional(),
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
export type DecisionView = z.infer<typeof decisionViewSchema>;
export type DecisionSettingsView = z.infer<typeof decisionSettingsSchema>;
export type DecisionTestView = z.infer<typeof decisionTestSchema>;
export const backupFileSchema = z.object({ name: z.string(), size: z.number().int(), createdAt: z.string() }).strict();
export type BackupFileView = z.infer<typeof backupFileSchema>;
export type GoalViewRecord = z.infer<typeof goalViewSchema>;
export type AgentMetricsView = z.infer<typeof agentMetricsSchema>;
export type JobSearchHitView = z.infer<typeof jobSearchHitSchema>;
export type SavedViewRecord = z.infer<typeof savedViewSchema>;
export const installedPluginSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    version: z.string(),
    running: z.boolean(),
    toolNames: z.array(z.string()),
    hasSkill: z.boolean(),
    /** The plugin adds a section to thread instructions (read from its server bundle). */
    hasInstructions: z.boolean().optional(),
    cliCommand: z.string().nullable(),
  })
  .strict();
export const pluginDirectorySchema = z
  .object({
    plugins: z.array(installedPluginSchema),
    /** Agency features opened by installed plugins. */
    features: z.object({ projectFolders: z.boolean(), fileGateway: z.boolean() }).strict(),
  })
  .strict();
export type InstalledPluginRecord = z.infer<typeof installedPluginSchema>;
export type PluginDirectoryView = z.infer<typeof pluginDirectorySchema>;
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
    /** Commands the employee ran outside the CLI sandbox in this attempt; absent when none. */
    outsideSandboxCommands: z.number().int().positive().optional(),
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
  if (input.assignedErrorCode) return "launch_not_authorized";
  if (!input.hasJobId) return "launch_not_authorized";
  if (!input.handshakeReady || !input.sdkTypedSpawnReady) return "handshake_unready";
  if (input.launchAllowed) return "ok";
  return "launch_not_authorized";
}

export const isolationReadinessSchema = z
  .object({
    handshakeReady: z.boolean(),
    executionAvailable: z.boolean(),
    isolationReady: z.boolean(),
    isolatedSpawnFields: z.boolean(),
    sdkTypedSpawnReady: z.boolean(),
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
  providerUsage: { input: z.null(), output: domainResultSchema(z.array(providerUsageSchema)) },
  modelPrices: { input: z.null(), output: modelPricesViewSchema },
  agentModels: { input: z.null(), output: domainResultSchema(agentModelsViewSchema) },
  listWorkProfiles: { input: z.object({ bbProjectId: z.string().optional() }).strict(), output: domainResultSchema(z.array(workProfileSchema)) },
  saveWorkProfile: { input: saveWorkProfileInputSchema, output: domainResultSchema(workProfileSchema) },
  deleteWorkProfile: { input: z.object({ bbProjectId: z.string().min(1), key: z.string().min(1) }).strict(), output: domainResultSchema(z.object({ removed: z.boolean() }).strict()) },
  getDecisionSettings: { input: z.null(), output: domainResultSchema(decisionViewSchema) },
  saveDecisionSettings: { input: saveDecisionSettingsInputSchema, output: domainResultSchema(decisionSettingsSchema) },
  saveDecisionKey: { input: z.object({ name: z.string().min(1).max(120), value: z.string().min(1).max(500) }).strict(), output: domainResultSchema(z.object({ name: z.string() }).strict()) },
  testDecisionModel: { input: z.null(), output: domainResultSchema(decisionTestSchema) },
  repairAgentModels: { input: z.object({ agentIds: z.array(z.string()).max(200).optional() }).strict(), output: domainResultSchema(agentModelsViewSchema) },
  setModelPrices: { input: z.object({ rows: z.array(modelPriceRowSchema).max(300) }).strict(), output: modelPricesViewSchema },
  listTemplates: { input: z.null(), output: domainResultSchema(z.array(templateViewSchema)) },
  getSkillPins: { input: z.null(), output: domainResultSchema(skillPinStatusSchema) },
  listBackups: { input: z.null(), output: domainResultSchema(z.array(backupFileSchema)) },
  createBackup: { input: z.null(), output: domainResultSchema(backupFileSchema) },
  restoreBackup: { input: z.object({ name: z.string().max(200) }).strict(), output: domainResultSchema(z.object({ restored: z.string(), safetyBackup: backupFileSchema, tables: z.number().int() }).strict()) },
  listKnowledge: { input: z.null(), output: domainResultSchema(z.array(knowledgeItemSchema)) },
  getKnowledge: { input: z.object({ id: z.string().min(1) }).strict(), output: domainResultSchema(knowledgeItemSchema) },
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
  listPlugins: { input: z.null(), output: domainResultSchema(pluginDirectorySchema) },
  notifyOwner: { input: notifyOwnerInputSchema, output: domainResultSchema(notifyOwnerOutputSchema) },
  starterKit: { input: z.object({ language: kitLanguageSchema.optional() }).strict(), output: domainResultSchema(starterKitViewSchema) },
  installStarterKit: { input: installStarterKitInputSchema, output: domainResultSchema(installStarterKitOutputSchema) },
  translateStarterKit: { input: z.object({ language: kitLanguageSchema.optional() }).strict(), output: domainResultSchema(translateStarterKitOutputSchema) },
  recordLifecycle: { input: recordLifecycleInputSchema, output: domainResultSchema(recordLifecycleSchema) },
  archiveDepartment: { input: z.object({ departmentId: z.string().max(80) }).strict(), output: domainResultSchema(z.object({ archivedAt: z.string() }).strict()) },
  restoreDepartment: { input: z.object({ departmentId: z.string().max(80) }).strict(), output: domainResultSchema(z.object({ restored: z.literal(true) }).strict()) },
  deleteDepartment: { input: z.object({ departmentId: z.string().max(80) }).strict(), output: domainResultSchema(z.object({ deleted: z.literal(true) }).strict()) },
  deleteAgent: { input: z.object({ agentId: z.string().max(80) }).strict(), output: domainResultSchema(z.object({ deleted: z.literal(true) }).strict()) },
  listOwnerMessages: { input: z.object({ limit: z.number().int().min(1).max(500).optional() }).strict(), output: domainResultSchema(ownerMessagesSchema) },
  markOwnerMessagesRead: { input: z.object({ ids: z.array(z.string().max(80)).max(500).optional() }).strict(), output: domainResultSchema(z.object({ marked: z.number().int() }).strict()) },
  ownerDigest: { input: ownerDigestInputSchema, output: domainResultSchema(ownerDigestSchema) },
  listScriptTemplates: { input: z.object({}).strict(), output: domainResultSchema(z.array(scriptTemplateSchema)) },
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
  addJobDependency: { input: addJobDependencyRpcSchema, output: domainResultSchema(jobDependencySchema) },
  removeJobDependency: { input: removeJobDependencyRpcSchema, output: domainResultSchema(z.object({ removed: z.boolean() }).strict()) },
  setJobNextStep: { input: setJobNextStepRpcSchema, output: domainResultSchema(nextStepViewSchema.nullable()) },
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
