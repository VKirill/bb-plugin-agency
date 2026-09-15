import { z } from "zod";
import { displayNameSchema, jobKeySchema, opaqueIdSchema, utcInstantSchema } from "./ids";
import { jobTeamAgentIdsSchema } from "./job-team";
import { changeCommandSchema, createCommandSchema, revisionedRecordSchema } from "./revision";

export const jobStateSchema = z.enum([
  "backlog",
  "queued",
  "running",
  "review",
  "waiting_input",
  "blocked",
  "done",
  "canceled",
]);

export const jobPrioritySchema = z.enum(["low", "normal", "high", "urgent"]);

export const jobSchema = revisionedRecordSchema
  .extend({
    id: opaqueIdSchema,
    key: jobKeySchema,
    bindingId: opaqueIdSchema,
    departmentId: opaqueIdSchema,
    title: displayNameSchema,
    brief: z.string().trim().min(1).max(20_000),
    acceptance: z.string().trim().min(1).max(20_000),
    state: jobStateSchema,
    parentJobId: opaqueIdSchema.nullable(),
    assignedAgentId: opaqueIdSchema.nullable(),
    reviewerAgentIds: jobTeamAgentIdsSchema.optional(),
    observerAgentIds: jobTeamAgentIdsSchema.optional(),
    priority: jobPrioritySchema,
    dueAt: utcInstantSchema.nullable(),
  })
  .strict();

export const jobDependencySchema = z
  .object({
    jobId: opaqueIdSchema,
    dependsOnJobId: opaqueIdSchema,
  })
  .strict();

export const createJobCommandSchema = createCommandSchema
  .extend({
    key: jobKeySchema,
    bindingId: opaqueIdSchema,
    departmentId: opaqueIdSchema,
    title: displayNameSchema,
    brief: z.string().trim().min(1).max(20_000),
    acceptance: z.string().trim().min(1).max(20_000),
    parentJobId: opaqueIdSchema.nullable(),
    assignedAgentId: opaqueIdSchema.nullable(),
    reviewerAgentIds: jobTeamAgentIdsSchema.optional(),
    observerAgentIds: jobTeamAgentIdsSchema.optional(),
    priority: jobPrioritySchema,
    dueAt: utcInstantSchema.nullable(),
  })
  .strict();

export const updateJobCommandSchema = changeCommandSchema
  .extend({
    jobId: opaqueIdSchema,
    title: displayNameSchema.optional(),
    brief: z.string().trim().min(1).max(20_000).optional(),
    acceptance: z.string().trim().min(1).max(20_000).optional(),
    bindingId: opaqueIdSchema.optional(),
    departmentId: opaqueIdSchema.optional(),
    assignedAgentId: opaqueIdSchema.nullable().optional(),
    reviewerAgentIds: jobTeamAgentIdsSchema.optional(),
    observerAgentIds: jobTeamAgentIdsSchema.optional(),
    priority: jobPrioritySchema.optional(),
    dueAt: utcInstantSchema.nullable().optional(),
  })
  .strict();

export const jobTransitionCommandSchema = changeCommandSchema
  .extend({
    jobId: opaqueIdSchema,
    to: jobStateSchema,
    reworkComment: z.string().trim().min(1).max(8_000).optional(),
  })
  .strict();

export type JobState = z.infer<typeof jobStateSchema>;
export type JobPriority = z.infer<typeof jobPrioritySchema>;
export type Job = z.infer<typeof jobSchema>;
export type JobDependency = z.infer<typeof jobDependencySchema>;
export type CreateJobCommand = z.infer<typeof createJobCommandSchema>;
export type UpdateJobCommand = z.infer<typeof updateJobCommandSchema>;
export type JobTransitionCommand = z.infer<typeof jobTransitionCommandSchema>;
