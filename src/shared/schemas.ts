import { z } from "zod";

// Notifications carry references, not prompts, secrets or arbitrary payloads.
export const notificationSchema = z.object({
  eventId: z.string().trim().min(1).max(160),
  projectId: z.string().trim().min(1).max(160),
  topic: z.string().regex(/^[a-z][a-z0-9_.-]{0,95}$/),
  reference: z.string().trim().min(1).max(500),
}).strict();
export type Notification = z.infer<typeof notificationSchema>;
export const sourceSchema = z.enum(["rpc", "cli"]);
export type IntakeSource = z.infer<typeof sourceSchema>;
export const receiptSchema = z.object({
  eventId: z.string(), accepted: z.literal(true), duplicate: z.boolean(),
  state: z.literal("pending"), execution: z.literal("unavailable"),
}).strict();
export const statusSchema = z.object({
  phase: z.literal("scaffold"), execution: z.literal("unavailable"),
  reason: z.string(), inboxCount: z.number().int().nonnegative(),
}).strict();
export type AgencyStatus = z.infer<typeof statusSchema>;
