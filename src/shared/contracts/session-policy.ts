import { z } from "zod";
import { bbProjectIdSchema, opaqueIdSchema, requestIdSchema } from "./ids";

/** Stored override: inherit deletes the row and falls back to the wider scope. */
export const SESSION_POLICY_MODES = ["inherit", "ordinary", "suggest", "pm"] as const;
export type SessionPolicyMode = (typeof SESSION_POLICY_MODES)[number];

export const SESSION_SCOPES = ["project", "binding", "thread"] as const;
export type SessionPolicyScope = (typeof SESSION_SCOPES)[number];

/** What the ordinary chat actually receives after resolution. */
export const SESSION_EFFECTIVE_MODES = ["ordinary", "suggest", "delegate", "pm"] as const;
export type SessionEffectiveMode = (typeof SESSION_EFFECTIVE_MODES)[number];

export const sessionPolicyModeSchema = z.enum(SESSION_POLICY_MODES);
export const sessionPolicyScopeSchema = z.enum(SESSION_SCOPES);
export const sessionEffectiveModeSchema = z.enum(SESSION_EFFECTIVE_MODES);

export const getSessionPolicyInputSchema = z
  .object({
    bbProjectId: bbProjectIdSchema.optional(),
    bindingId: opaqueIdSchema.optional(),
    threadId: z.string().trim().min(1).max(80).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.bbProjectId || value.bindingId || value.threadId), {
    message: "bbProjectId, bindingId or threadId is required",
  });

export const saveSessionPolicyInputSchema = z
  .object({
    requestId: requestIdSchema,
    scope: sessionPolicyScopeSchema,
    scopeId: z.string().trim().min(1).max(160),
    mode: sessionPolicyModeSchema,
  })
  .strict();

export const sessionPolicyLayersSchema = z
  .object({
    agency: sessionEffectiveModeSchema,
    project: sessionPolicyModeSchema,
    binding: sessionPolicyModeSchema,
    thread: sessionPolicyModeSchema,
  })
  .strict();

export const sessionPolicyViewSchema = z
  .object({
    effective: sessionEffectiveModeSchema,
    source: z.enum(["thread", "binding", "project", "agency"]),
    layers: sessionPolicyLayersSchema,
    bbProjectId: z.string().nullable(),
    bindingId: z.string().nullable(),
    threadId: z.string().nullable(),
    connected: z.boolean(),
  })
  .strict();

export type GetSessionPolicyInput = z.infer<typeof getSessionPolicyInputSchema>;
export type SaveSessionPolicyInput = z.infer<typeof saveSessionPolicyInputSchema>;
export type SessionPolicyView = z.infer<typeof sessionPolicyViewSchema>;
