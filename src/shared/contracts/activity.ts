import { z } from "zod";
import { externalIdSchema, opaqueIdSchema, utcInstantSchema } from "./ids";
import { createCommandSchema } from "./revision";

export const activityActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: externalIdSchema }).strict(),
  z.object({ kind: z.literal("agent"), agentId: opaqueIdSchema }).strict(),
  z.object({ kind: z.literal("system") }).strict(),
]);

export const activityReferenceSchema = z
  .object({
    type: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    id: externalIdSchema,
  })
  .strict();

export const activityCommentSchema = z.string().trim().min(1).max(8_000);

export const activitySchema = z
  .object({
    id: opaqueIdSchema,
    jobId: opaqueIdSchema,
    actor: activityActorSchema,
    kind: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    causationId: opaqueIdSchema.nullable(),
    timestamp: utcInstantSchema,
    references: z.array(activityReferenceSchema),
    comment: activityCommentSchema.optional(),
  })
  .strict();

export const createActivityCommandSchema = createCommandSchema
  .extend({
    jobId: opaqueIdSchema,
    actor: activityActorSchema,
    kind: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    causationId: opaqueIdSchema.nullable(),
    references: z.array(activityReferenceSchema),
    comment: activityCommentSchema.optional(),
  })
  .strict();

export type ActivityActor = z.infer<typeof activityActorSchema>;
export type Activity = z.infer<typeof activitySchema>;
export type CreateActivityCommand = z.infer<typeof createActivityCommandSchema>;
