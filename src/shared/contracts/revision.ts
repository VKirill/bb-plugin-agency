import { z } from "zod";
import { requestIdSchema, utcInstantSchema } from "./ids";

export const revisionSchema = z.number().int().positive();

export const revisionedRecordSchema = z
  .object({
    revision: revisionSchema,
    updatedAt: utcInstantSchema,
  })
  .strict();

/** Header for create commands. Mutations use expectedRevision instead. */
export const createCommandSchema = z
  .object({
    requestId: requestIdSchema,
  })
  .strict();

/** Header every mutating command must send. Conflict does not overwrite. */
export const changeCommandSchema = z
  .object({
    expectedRevision: revisionSchema,
    requestId: requestIdSchema,
  })
  .strict();

export const revisionConflictSchema = z
  .object({
    code: z.literal("revision_conflict"),
    expectedRevision: revisionSchema,
    actualRevision: revisionSchema,
    requestId: requestIdSchema,
  })
  .strict();

export type CreateCommand = z.infer<typeof createCommandSchema>;
export type ChangeCommand = z.infer<typeof changeCommandSchema>;
export type RevisionConflict = z.infer<typeof revisionConflictSchema>;
