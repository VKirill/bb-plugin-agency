import { z } from "zod";
import { opaqueIdSchema, requestIdSchema } from "./ids";

const names = z.array(z.string().trim().min(1).max(200)).max(500);
export const contextFilterSchema = z.object({ mode: z.enum(["allow", "deny", "assigned"]), names }).strict();
const nativeFilter = z.object({ mode: z.enum(["allow", "deny"]), names }).strict();
/** Missing fields inherit from the department; deny [] explicitly loads everything in that category. */
export const workerContextPolicySchema = z.object({
  skills: contextFilterSchema.optional(), bbPlugins: contextFilterSchema.optional(),
  mcpServers: nativeFilter.optional(), nativePlugins: nativeFilter.optional(),
  userInstructions: z.boolean().optional(), projectInstructions: z.boolean().optional(), claudeAiSync: z.boolean().optional(),
}).strict();
export type WorkerContextPolicy = z.infer<typeof workerContextPolicySchema>;
export const workerContextQuerySchema = z.object({ scope: z.enum(["agent", "department"]), scopeId: opaqueIdSchema }).strict();
export const saveWorkerContextSchema = workerContextQuerySchema.extend({
  requestId: requestIdSchema, expectedRevision: z.number().int().nonnegative(), policy: workerContextPolicySchema,
}).strict();
export type WorkerContextQuery = z.infer<typeof workerContextQuerySchema>;
export const workerContextRecordSchema = workerContextQuerySchema.extend({ revision: z.number().int().nonnegative(), policy: workerContextPolicySchema });
export const workerContextViewSchema = workerContextRecordSchema.extend({ inherited: z.array(z.object({departmentId:z.string(),name:z.string(),revision:z.number().int().nonnegative(),policy:workerContextPolicySchema})).default([]), available: z.boolean(), contributions: z.array(z.object({
  pluginId: z.string(), instructions: z.boolean(), configure: z.boolean(), tools: z.array(z.string()), skills: z.array(z.string()),
})) });
export type WorkerContextView = z.infer<typeof workerContextViewSchema>;
export type FrozenWorkerContext = { policy: VkSessionPolicy; departmentRevision: number; agentRevision: number };
export type VkSessionPolicy = Omit<WorkerContextPolicy, "skills" | "bbPlugins"> & {
  skills?: { mode: "allow" | "deny"; names: string[] }; bbPlugins?: { mode: "allow" | "deny"; names: string[] };
};
