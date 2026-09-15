import { z } from "zod";
import { activityCommentSchema } from "./activity";
import { bbProjectIdSchema, externalIdSchema, opaqueIdSchema } from "./ids";
import { createCommandSchema } from "./revision";

/** Forced on the comment path. Callers cannot choose a system event kind. */
export const JOB_COMMENT_KIND = "comment" as const;

export const jobCommentReferenceSchema = z
  .object({
    type: z.enum(["artifact", "thread"]),
    id: externalIdSchema,
  })
  .strict();

/**
 * CLI/public write for job history comments.
 * No `kind`, no `actor`: kind is always comment; actor comes from trusted CLI proof.
 */
export const createJobCommentRpcSchema = createCommandSchema
  .extend({
    jobId: opaqueIdSchema,
    comment: activityCommentSchema,
    references: z.array(jobCommentReferenceSchema).default([]),
    claimedBbProjectId: bbProjectIdSchema.optional(),
  })
  .strict();

export type JobCommentReference = z.infer<typeof jobCommentReferenceSchema>;
export type CreateJobCommentRpc = z.infer<typeof createJobCommentRpcSchema>;
