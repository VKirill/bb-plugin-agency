import { z } from "zod";
import { bbEnvironmentIdSchema, bbProjectIdSchema, hostIdSchema, opaqueIdSchema, utcInstantSchema } from "./ids";
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
    /** Set when the project is disconnected from the Agency: history stays, new jobs and launches stop. */
    archivedAt: utcInstantSchema.nullable().optional(),
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

/** Disconnect, reconnect or delete a project binding. Delete works only for a binding without jobs. */
export const bindingLifecycleCommandSchema = changeCommandSchema
  .extend({
    bindingId: opaqueIdSchema,
  })
  .strict();

/** Remove a department from a project's selected list. Departments open to all projects are not affected. */
export const unlinkDepartmentCommandSchema = createCommandSchema
  .extend({
    bindingId: opaqueIdSchema,
    departmentId: opaqueIdSchema,
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
export type BindingLifecycleCommand = z.infer<typeof bindingLifecycleCommandSchema>;
export type UnlinkDepartmentCommand = z.infer<typeof unlinkDepartmentCommandSchema>;
