import { z } from "zod";
import { displayNameSchema, opaqueIdSchema } from "./ids";
import { changeCommandSchema, createCommandSchema, revisionedRecordSchema } from "./revision";

export const agentStateSchema = z.enum(["active", "paused", "archived"]);
export const membershipRoleSchema = z.enum(["member", "lead"]);

export const agentSchema = revisionedRecordSchema
  .extend({
    id: opaqueIdSchema,
    name: displayNameSchema,
    state: agentStateSchema,
    currentVersionId: opaqueIdSchema,
  })
  .strict();

export const departmentSchema = revisionedRecordSchema
  .extend({
    id: opaqueIdSchema,
    name: displayNameSchema,
    leadAgentId: opaqueIdSchema,
    processVersionId: opaqueIdSchema,
  })
  .strict();

export const membershipSchema = z
  .object({
    departmentId: opaqueIdSchema,
    agentId: opaqueIdSchema,
    role: membershipRoleSchema,
  })
  .strict();

export const createAgentCommandSchema = createCommandSchema
  .extend({
    name: displayNameSchema,
    state: agentStateSchema,
    currentVersionId: opaqueIdSchema,
  })
  .strict();

export const updateAgentCommandSchema = changeCommandSchema
  .extend({
    agentId: opaqueIdSchema,
    name: displayNameSchema.optional(),
    state: agentStateSchema.optional(),
    currentVersionId: opaqueIdSchema.optional(),
  })
  .strict();

export const createDepartmentCommandSchema = createCommandSchema
  .extend({
    name: displayNameSchema,
    leadAgentId: opaqueIdSchema,
    processVersionId: opaqueIdSchema,
  })
  .strict();

export const updateDepartmentCommandSchema = changeCommandSchema
  .extend({
    departmentId: opaqueIdSchema,
    name: displayNameSchema.optional(),
    leadAgentId: opaqueIdSchema.optional(),
    processVersionId: opaqueIdSchema.optional(),
  })
  .strict();

export const createMembershipCommandSchema = createCommandSchema
  .extend({
    departmentId: opaqueIdSchema,
    agentId: opaqueIdSchema,
    role: membershipRoleSchema,
  })
  .strict();

export const removeMembershipCommandSchema = createCommandSchema
  .extend({
    departmentId: opaqueIdSchema,
    agentId: opaqueIdSchema,
  })
  .strict();

export type Agent = z.infer<typeof agentSchema>;
export type Department = z.infer<typeof departmentSchema>;
export type Membership = z.infer<typeof membershipSchema>;
export type CreateAgentCommand = z.infer<typeof createAgentCommandSchema>;
export type UpdateAgentCommand = z.infer<typeof updateAgentCommandSchema>;
export type CreateDepartmentCommand = z.infer<typeof createDepartmentCommandSchema>;
export type UpdateDepartmentCommand = z.infer<typeof updateDepartmentCommandSchema>;
export type CreateMembershipCommand = z.infer<typeof createMembershipCommandSchema>;
export type RemoveMembershipCommand = z.infer<typeof removeMembershipCommandSchema>;
