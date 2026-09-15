import { z } from "zod";
import { bbEnvironmentIdSchema, bbProjectIdSchema, hostIdSchema, opaqueIdSchema } from "./ids";
import { changeCommandSchema, createCommandSchema, revisionedRecordSchema } from "./revision";

export const canonicalRootSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .regex(/^\/(?!.*(?:^|\/)\.\.(?:\/|$)).+$/);

export const projectBindingSchema = revisionedRecordSchema
  .extend({
    id: opaqueIdSchema,
    bbProjectId: bbProjectIdSchema,
    environmentId: bbEnvironmentIdSchema,
    hostId: hostIdSchema,
    canonicalRoot: canonicalRootSchema,
    policyVersionId: opaqueIdSchema,
    sectionId: z.string().trim().min(1).max(160).nullable(),
  })
  .strict();

export const projectDepartmentSchema = z
  .object({
    bindingId: opaqueIdSchema,
    departmentId: opaqueIdSchema,
  })
  .strict();

export const createProjectBindingCommandSchema = createCommandSchema
  .extend({
    bbProjectId: bbProjectIdSchema,
    environmentId: bbEnvironmentIdSchema,
    hostId: hostIdSchema,
    canonicalRoot: canonicalRootSchema,
    policyVersionId: opaqueIdSchema,
    sectionId: z.string().trim().min(1).max(160).nullable(),
  })
  .strict();

export const updateProjectBindingCommandSchema = changeCommandSchema
  .extend({
    bindingId: opaqueIdSchema,
    sectionId: z.string().trim().min(1).max(160).nullable().optional(),
    policyVersionId: opaqueIdSchema.optional(),
  })
  .strict();

/** Client may send a project claim; the server must compare it to the stored binding. */
export const projectScopedQuerySchema = z
  .object({
    bindingId: opaqueIdSchema,
    claimedBbProjectId: bbProjectIdSchema.optional(),
  })
  .strict();

export type ProjectBinding = z.infer<typeof projectBindingSchema>;
export type ProjectDepartment = z.infer<typeof projectDepartmentSchema>;
export type CreateProjectBindingCommand = z.infer<typeof createProjectBindingCommandSchema>;
export type UpdateProjectBindingCommand = z.infer<typeof updateProjectBindingCommandSchema>;
export type ProjectScopedQuery = z.infer<typeof projectScopedQuerySchema>;
