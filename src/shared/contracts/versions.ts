import { z } from "zod";
import { catalogMcpIdSchema, catalogSkillIdSchema, externalIdSchema, hostIdSchema, opaqueIdSchema } from "./ids";
import { displayNameSchema } from "./ids";
import { changeCommandSchema, createCommandSchema } from "./revision";
import { agentStateSchema, membershipRoleSchema } from "./membership";

export const capabilityIdSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,95}$/);
export const secretRefSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/);

/** Same ladder as SDK `threads.spawn` `reasoningLevel`. Persist as AgentVersion.reasoningEffort. */
export const reasoningEffortSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
]);

export const agentVersionSchema = z
  .object({
    id: opaqueIdSchema,
    agentId: opaqueIdSchema,
    version: z.number().int().positive(),
    role: z.string().trim().min(1).max(80),
    instructions: z.string().trim().min(1).max(40_000),
    providerId: externalIdSchema,
    model: z.string().trim().min(1).max(180),
    skillIds: z.array(catalogSkillIdSchema),
    mcpIds: z.array(catalogMcpIdSchema),
    policyVersionId: opaqueIdSchema,
    reasoningEffort: reasoningEffortSchema.optional(),
  })
  .strict();

export const policyVersionSchema = z
  .object({
    id: opaqueIdSchema,
    allowedCapabilities: z.array(capabilityIdSchema),
    cliHostConstraints: z
      .object({
        providerIds: z.array(externalIdSchema),
        hostIds: z.array(hostIdSchema),
      })
      .strict(),
    secretRefs: z.array(secretRefSchema),
  })
  .strict();

export const processVersionSchema = z
  .object({
    id: opaqueIdSchema,
    departmentId: opaqueIdSchema,
    instructions: z.string().trim().min(1).max(40_000),
    acceptance: z.string().trim().min(1).max(20_000),
    reviewPolicy: z.object({ required: z.boolean() }).strict(),
  })
  .strict();

export const createAgentVersionCommandSchema = createCommandSchema
  .extend({
    agentId: opaqueIdSchema,
    version: z.number().int().positive(),
    role: z.string().trim().min(1).max(80),
    instructions: z.string().trim().min(1).max(40_000),
    providerId: externalIdSchema,
    model: z.string().trim().min(1).max(180),
    skillIds: z.array(catalogSkillIdSchema),
    mcpIds: z.array(catalogMcpIdSchema),
    policyVersionId: opaqueIdSchema,
    reasoningEffort: reasoningEffortSchema.optional(),
  })
  .strict();

export const createPolicyVersionCommandSchema = createCommandSchema
  .extend({
    allowedCapabilities: z.array(capabilityIdSchema),
    cliHostConstraints: z
      .object({
        providerIds: z.array(externalIdSchema),
        hostIds: z.array(hostIdSchema),
      })
      .strict(),
    secretRefs: z.array(secretRefSchema),
  })
  .strict();

export const createProcessVersionCommandSchema = createCommandSchema
  .extend({
    departmentId: opaqueIdSchema,
    instructions: z.string().trim().min(1).max(40_000),
    acceptance: z.string().trim().min(1).max(20_000),
    reviewPolicy: z.object({ required: z.boolean() }).strict(),
  })
  .strict();

export const agentVersionDraftSchema = z
  .object({
    version: z.number().int().positive(),
    role: z.string().trim().min(1).max(80),
    instructions: z.string().trim().min(1).max(40_000),
    providerId: externalIdSchema,
    model: z.string().trim().min(1).max(180),
    skillIds: z.array(catalogSkillIdSchema),
    mcpIds: z.array(catalogMcpIdSchema),
    policyVersionId: opaqueIdSchema,
    reasoningEffort: reasoningEffortSchema.optional(),
  })
  .strict();

export const processVersionDraftSchema = z
  .object({
    instructions: z.string().trim().min(1).max(40_000),
    acceptance: z.string().trim().min(1).max(20_000),
    reviewPolicy: z.object({ required: z.boolean() }).strict(),
  })
  .strict();

export const saveAgentProfileCommandSchema = changeCommandSchema
  .extend({
    agentId: opaqueIdSchema,
    name: displayNameSchema,
    state: agentStateSchema,
    version: agentVersionDraftSchema,
  })
  .strict();

export const saveDepartmentProfileCommandSchema = changeCommandSchema
  .extend({
    departmentId: opaqueIdSchema,
    name: displayNameSchema,
    leadAgentId: opaqueIdSchema,
    process: processVersionDraftSchema.optional(),
    memberships: z
      .array(z.object({ agentId: opaqueIdSchema, role: membershipRoleSchema }).strict())
      .optional(),
  })
  .strict();

export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type AgentVersion = z.infer<typeof agentVersionSchema>;
export type PolicyVersion = z.infer<typeof policyVersionSchema>;
export type ProcessVersion = z.infer<typeof processVersionSchema>;
export type CreateAgentVersionCommand = z.infer<typeof createAgentVersionCommandSchema>;
export type CreatePolicyVersionCommand = z.infer<typeof createPolicyVersionCommandSchema>;
export type CreateProcessVersionCommand = z.infer<typeof createProcessVersionCommandSchema>;
export type AgentVersionDraft = z.infer<typeof agentVersionDraftSchema>;
export type SaveAgentProfileCommand = z.infer<typeof saveAgentProfileCommandSchema>;
export type SaveDepartmentProfileCommand = z.infer<typeof saveDepartmentProfileCommandSchema>;

export function optionalReasoningEffort(
  value: ReasoningEffort | undefined,
): { reasoningEffort: ReasoningEffort } | Record<string, never> {
  return value ? { reasoningEffort: value } : {};
}
