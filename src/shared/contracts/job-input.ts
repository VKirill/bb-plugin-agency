import { z } from "zod";
import { contentHashSchema, relativePathSchema } from "./artifact.js";
import { hostIdSchema, opaqueIdSchema, requestIdSchema } from "./ids.js";

export const attachJobInputHandoffSchema = z
  .object({
    priorAttemptId: opaqueIdSchema,
    sourceSnapshotDigest: contentHashSchema,
    reason: z.string().trim().max(2000).nullable().optional(),
    questions: z.array(z.string().trim().min(1).max(500)).max(32).optional(),
  })
  .strict();

/** Public attach. Caller does not send hostId or canonicalRoot. */
export const attachJobInputCommandSchema = z
  .object({
    requestId: requestIdSchema,
    expectedRevision: z.number().int().positive(),
    targetJobId: opaqueIdSchema,
    sourceJobId: opaqueIdSchema,
    artifactId: opaqueIdSchema,
    version: z.number().int().positive(),
    hash: contentHashSchema,
    handoff: attachJobInputHandoffSchema.optional(),
  })
  .strict();

export const attachedJobInputSchema = z
  .object({
    targetJobId: opaqueIdSchema,
    sourceJobId: opaqueIdSchema,
    artifactId: opaqueIdSchema,
    version: z.number().int().positive(),
    hash: contentHashSchema,
    hostId: hostIdSchema,
    relativePath: relativePathSchema,
    publishedVerified: z.literal(true),
    accepted: z.boolean(),
    authorizedInputJobIds: z.array(opaqueIdSchema),
  })
  .strict();

export type AttachJobInputCommand = z.infer<typeof attachJobInputCommandSchema>;
export type AttachJobInputHandoff = z.infer<typeof attachJobInputHandoffSchema>;
export type AttachedJobInput = z.infer<typeof attachedJobInputSchema>;
