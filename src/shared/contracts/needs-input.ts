import { z } from "zod";
import { contentHashSchema } from "./artifact";
import { opaqueIdSchema, requestIdSchema } from "./ids";
import { changeCommandSchema } from "./revision";

export const needsInputSourceKindSchema = z.enum([
  "process_acceptance",
  "process_instructions",
  "job_acceptance",
  "job_brief",
]);

export const needsInputSourceRefSchema = z
  .object({
    kind: needsInputSourceKindSchema,
    id: opaqueIdSchema,
  })
  .strict();

export const needsInputQuestionSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    text: z.string().trim().min(1).max(4_000),
    sourceRefs: z.array(needsInputSourceRefSchema).min(1).max(8),
  })
  .strict();

export const reportNeedsInputCommandSchema = changeCommandSchema
  .extend({
    jobId: opaqueIdSchema,
    expectedAttemptRevision: z.number().int().positive(),
    attemptId: opaqueIdSchema,
    launchId: z.string().uuid(),
    threadId: z.string().trim().min(8).max(80),
    questions: z.array(needsInputQuestionSchema).min(1).max(8),
  })
  .strict();

export const needsInputRecordSchema = z
  .object({
    waitId: requestIdSchema,
    jobId: opaqueIdSchema,
    attemptId: opaqueIdSchema,
    launchId: z.string().uuid(),
    threadId: z.string(),
    requestId: requestIdSchema,
    questions: z.array(needsInputQuestionSchema).min(1),
    bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
    jobState: z.literal("waiting_input"),
    attemptState: z.literal("waiting_input"),
    jobRevision: z.number().int().positive(),
    attemptRevision: z.number().int().positive(),
  })
  .strict();

export const reportNeedsInputRpcSchema = reportNeedsInputCommandSchema;

export const needsInputAnswerSchema = z
  .object({
    questionId: z.string().trim().min(1).max(80),
    text: z.string().trim().min(1).max(4_000),
  })
  .strict();

export const answerNeedsInputCommandSchema = changeCommandSchema
  .extend({
    jobId: opaqueIdSchema,
    expectedAttemptRevision: z.number().int().positive(),
    attemptId: opaqueIdSchema,
    launchId: z.string().uuid(),
    threadId: z.string().trim().min(8).max(80),
    waitId: requestIdSchema,
    answers: z.array(needsInputAnswerSchema).min(1).max(8),
    expectedProcessVersionId: opaqueIdSchema,
    expectedSnapshotDigest: contentHashSchema,
    expectedProcessInstructionsHash: contentHashSchema.optional(),
    expectedProcessAcceptanceHash: contentHashSchema.optional(),
    expectedJobBriefHash: contentHashSchema.optional(),
    expectedJobAcceptanceHash: contentHashSchema.optional(),
  })
  .strict();

export const answerNeedsInputRecordSchema = z
  .object({
    waitId: requestIdSchema,
    jobId: opaqueIdSchema,
    attemptId: opaqueIdSchema,
    launchId: z.string().uuid(),
    threadId: z.string(),
    requestId: requestIdSchema,
    answers: z.array(needsInputAnswerSchema).min(1),
    bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
    jobState: z.enum(["waiting_input", "running"]),
    attemptState: z.enum(["waiting_input", "running"]),
    jobRevision: z.number().int().positive(),
    attemptRevision: z.number().int().positive(),
    sendState: z.enum(["pending", "unknown", "confirmed", "queued", "needs_reconciliation", "rejected"]),
    turnActive: z.boolean(),
    amendment: z
      .object({
        processVersionId: opaqueIdSchema,
        snapshotProcessVersionId: opaqueIdSchema,
        processInstructionsHash: contentHashSchema,
        processAcceptanceHash: contentHashSchema,
        jobBriefHash: contentHashSchema,
        jobAcceptanceHash: contentHashSchema,
        snapshotDigest: contentHashSchema,
      })
      .strict(),
  })
  .strict();

export const answerNeedsInputRpcSchema = answerNeedsInputCommandSchema;

export type NeedsInputSourceRef = z.infer<typeof needsInputSourceRefSchema>;
export type NeedsInputQuestion = z.infer<typeof needsInputQuestionSchema>;
export type ReportNeedsInputCommand = z.infer<typeof reportNeedsInputCommandSchema>;
export type NeedsInputRecord = z.infer<typeof needsInputRecordSchema>;
export type NeedsInputAnswer = z.infer<typeof needsInputAnswerSchema>;
export type AnswerNeedsInputCommand = z.infer<typeof answerNeedsInputCommandSchema>;
export type AnswerNeedsInputRecord = z.infer<typeof answerNeedsInputRecordSchema>;
export type ContinuationAmendment = AnswerNeedsInputRecord["amendment"];
