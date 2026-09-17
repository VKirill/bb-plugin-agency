import { z } from "zod";
import { displayNameSchema, opaqueIdSchema } from "./ids";
import { changeCommandSchema, createCommandSchema, revisionedRecordSchema } from "./revision";

export const agentStateSchema = z.enum(["active", "paused", "archived"]);
/**
 * Role type inside a department: what the system does differently for the
 * agent. The free-text job title lives in the agent profile (`role`).
 * lead — takes department jobs, orchestrates subtasks, hears about them;
 * executor — does the work and hands in a version;
 * reviewer — checks someone else's version and may not check their own work.
 */
export const MEMBERSHIP_ROLES = ["lead", "executor", "reviewer", "assistant"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];
/** `member` is the pre-2026-09-16 name of executor; old payloads keep working. */
export const membershipRoleSchema = z.preprocess(
  (value) => (value === "member" ? "executor" : value),
  z.enum(MEMBERSHIP_ROLES),
);
/**
 * all — the department takes jobs from every connected project (default);
 * selected — only from projects it is linked to.
 */
export const departmentAvailabilitySchema = z.enum(["all", "selected"]);

export const agentSchema = revisionedRecordSchema
  .extend({
    id: opaqueIdSchema,
    name: displayNameSchema,
    state: agentStateSchema,
    currentVersionId: opaqueIdSchema,
    /** Folder where this employee always works (File Gateway). Absent means the job's folder. */
    workplaceBindingId: opaqueIdSchema.optional(),
  })
  .strict();

export const departmentSchema = revisionedRecordSchema
  .extend({
    id: opaqueIdSchema,
    name: displayNameSchema,
    leadAgentId: opaqueIdSchema,
    processVersionId: opaqueIdSchema,
    /** Omitted means all. */
    availability: departmentAvailabilitySchema.optional(),
    /** Archived: out of routing, forms and pickers; history stays. */
    archivedAt: z.string().optional(),
  })
  .strict();

export const setDepartmentAvailabilityCommandSchema = changeCommandSchema
  .extend({
    departmentId: opaqueIdSchema,
    availability: departmentAvailabilitySchema,
  })
  .strict();

export const membershipSchema = z
  .object({
    departmentId: opaqueIdSchema,
    agentId: opaqueIdSchema,
    role: membershipRoleSchema,
    /** Assistants only: the employee of this department they help; null means the lead decides. */
    helpsAgentId: opaqueIdSchema.nullable().optional(),
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
    /** Null clears the workplace. */
    workplaceBindingId: opaqueIdSchema.nullable().optional(),
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
    helpsAgentId: opaqueIdSchema.nullable().optional(),
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
export type DepartmentAvailability = z.infer<typeof departmentAvailabilitySchema>;
export type SetDepartmentAvailabilityCommand = z.infer<typeof setDepartmentAvailabilityCommandSchema>;
