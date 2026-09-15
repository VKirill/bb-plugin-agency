import { z } from "zod";
import { opaqueIdSchema, requestIdSchema } from "./ids";
import { changeCommandSchema, createCommandSchema } from "./revision";

export const eventNamespaceSchema = z.enum(["bb", "agency", "integration"]);
export const ruleModeSchema = z.enum(["disabled", "observe", "approve", "auto"]);
export const conditionOpSchema = z.enum(["equals", "in", "exists"]);
export const inboxEventStateSchema = z.enum(["accepted", "evaluated", "rejected"]);
export const intentStateSchema = z.enum([
  "observed",
  "awaiting_approval",
  "queued",
  "claimed",
  "succeeded",
  "skipped",
  "failed",
  "canceled",
]);

export const eventConditionSchema = z
  .object({
    field: z.string().trim().min(1).max(80).regex(/^(topic|reference|data\.[a-zA-Z0-9_]+|subject\.[a-zA-Z0-9_]+)$/),
    op: conditionOpSchema,
    value: z.unknown().optional(),
  })
  .strict();

export const ruleActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("observe") }).strict(),
  z
    .object({
      kind: z.literal("prepare_job"),
      departmentId: opaqueIdSchema,
      title: z.string().trim().min(1).max(180),
      brief: z.string().trim().min(1).max(8_000),
      acceptance: z.string().trim().min(1).max(8_000),
    })
    .strict(),
]);

export const saveEventDefinitionCommandSchema = createCommandSchema
  .extend({
    topic: z.string().regex(/^[a-z][a-z0-9_.-]{0,95}$/),
    schemaVersion: z.number().int().positive(),
    namespace: eventNamespaceSchema,
    label: z.string().trim().min(1).max(120),
    payloadSchema: z.record(z.string(), z.unknown()),
  })
  .strict();

export const saveEventSourceCommandSchema = createCommandSchema
  .extend({
    projectId: z.string().trim().min(1).max(160),
    kind: z.enum(["notify", "webhook", "cron", "bb_lifecycle"]),
    enabled: z.boolean().default(true),
  })
  .strict();

export const saveRuleVersionCommandSchema = createCommandSchema
  .extend({
    ruleId: z.string().trim().min(8).max(80),
    projectId: z.string().trim().min(1).max(160),
    sourceId: opaqueIdSchema.optional(),
    topic: z.string().regex(/^[a-z][a-z0-9_.-]{0,95}$/),
    conditions: z.array(eventConditionSchema).max(16),
    mode: ruleModeSchema,
    action: ruleActionSchema,
    maxDepth: z.number().int().min(1).max(12).default(12),
    maxRetries: z.number().int().min(1).max(3).default(3),
    enabled: z.boolean().default(true),
  })
  .strict();

export const ingestInboxEventCommandSchema = createCommandSchema
  .extend({
    sourceId: opaqueIdSchema,
    eventId: z.string().trim().min(1).max(160),
    topic: z.string().regex(/^[a-z][a-z0-9_.-]{0,95}$/),
    reference: z.string().trim().min(1).max(500),
    body: z.record(z.string(), z.unknown()),
    depth: z.number().int().min(0).max(12).default(0),
    causationId: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export const dispatchTickCommandSchema = z
  .object({
    requestId: requestIdSchema,
    live: z.boolean().default(false),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

export const listActionIntentsCommandSchema = z
  .object({
    projectId: z.string().trim().min(1).max(160).optional(),
    state: intentStateSchema.optional(),
  })
  .strict();

export const listDispatcherCatalogCommandSchema = z
  .object({
    projectId: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export const claimActionIntentCommandSchema = createCommandSchema
  .extend({
    intentId: opaqueIdSchema,
    live: z.boolean().default(false),
    leaseOwner: z.string().trim().min(1).max(80),
    leaseMs: z.number().int().min(1).max(600_000).default(60_000),
  })
  .strict();

export const approveActionIntentCommandSchema = changeCommandSchema
  .extend({
    intentId: opaqueIdSchema,
  })
  .strict();

export const completeActionIntentCommandSchema = createCommandSchema
  .extend({
    intentId: opaqueIdSchema,
    fencingToken: z.string().uuid(),
    fencingGeneration: z.number().int().positive(),
    outcome: z.enum(["succeeded", "failed"]),
  })
  .strict();

export const eventDefinitionRecordSchema = z
  .object({
    topic: z.string(),
    schemaVersion: z.number().int(),
    namespace: eventNamespaceSchema,
    label: z.string(),
  })
  .strict();

export const eventSourceRecordSchema = z
  .object({
    id: opaqueIdSchema,
    projectId: z.string(),
    kind: z.string(),
    enabled: z.boolean(),
  })
  .strict();

export const ruleVersionRecordSchema = z
  .object({
    id: opaqueIdSchema,
    ruleId: z.string(),
    version: z.number().int(),
    projectId: z.string(),
    topic: z.string(),
    mode: ruleModeSchema,
    enabled: z.boolean(),
  })
  .strict();

export const inboxEventRecordSchema = z
  .object({
    id: opaqueIdSchema,
    sourceId: opaqueIdSchema,
    projectId: z.string(),
    eventId: z.string(),
    topic: z.string(),
    bodyDigest: z.string(),
    state: inboxEventStateSchema,
    duplicate: z.boolean(),
    depth: z.number().int(),
  })
  .strict();

export const actionIntentRecordSchema = z
  .object({
    id: opaqueIdSchema,
    matchId: opaqueIdSchema,
    uniqueKey: z.string(),
    state: intentStateSchema,
    attemptCount: z.number().int(),
    revision: z.number().int().positive(),
    fencingToken: z.string().uuid().nullable(),
    fencingGeneration: z.number().int().nonnegative(),
    liveGate: z.boolean(),
    jobId: opaqueIdSchema.nullable(),
    lastError: z.string().nullable(),
  })
  .strict();

export const listedActionIntentSchema = actionIntentRecordSchema
  .extend({
    topic: z.string().nullable(),
    definitionLabel: z.string().nullable(),
    ruleId: z.string().nullable(),
    ruleLabel: z.string().nullable(),
    sourceId: opaqueIdSchema.nullable(),
    sourceKind: z.string().nullable(),
  })
  .strict();

export const catalogRuleRecordSchema = ruleVersionRecordSchema
  .extend({
    label: z.string(),
    sourceId: opaqueIdSchema.nullable(),
  })
  .strict();

export const dispatchTickRecordSchema = z
  .object({
    evaluated: z.number().int(),
    matched: z.number().int(),
    intents: z.number().int(),
    live: z.boolean(),
    legacyInboxIgnored: z.literal(true),
  })
  .strict();

export type SaveEventDefinitionCommand = z.infer<typeof saveEventDefinitionCommandSchema>;
export type SaveEventSourceCommand = z.infer<typeof saveEventSourceCommandSchema>;
export type SaveRuleVersionCommand = z.infer<typeof saveRuleVersionCommandSchema>;
export type IngestInboxEventCommand = z.infer<typeof ingestInboxEventCommandSchema>;
export type DispatchTickCommand = z.infer<typeof dispatchTickCommandSchema>;
export type ClaimActionIntentCommand = z.infer<typeof claimActionIntentCommandSchema>;
export type ApproveActionIntentCommand = z.infer<typeof approveActionIntentCommandSchema>;
export type CompleteActionIntentCommand = z.infer<typeof completeActionIntentCommandSchema>;
export type EventCondition = z.infer<typeof eventConditionSchema>;
export type RuleAction = z.infer<typeof ruleActionSchema>;
export type EventDefinitionRecord = z.infer<typeof eventDefinitionRecordSchema>;
export type EventSourceRecord = z.infer<typeof eventSourceRecordSchema>;
export type InboxEventRecord = z.infer<typeof inboxEventRecordSchema>;
export type ActionIntentRecord = z.infer<typeof actionIntentRecordSchema>;
export type ListedActionIntent = z.infer<typeof listedActionIntentSchema>;
export type CatalogRuleRecord = z.infer<typeof catalogRuleRecordSchema>;
export type ListDispatcherCatalogCommand = z.infer<typeof listDispatcherCatalogCommandSchema>;
export type DispatchTickRecord = z.infer<typeof dispatchTickRecordSchema>;
