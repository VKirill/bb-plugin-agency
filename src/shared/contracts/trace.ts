import { z } from "zod";

export const traceOutcomeSchema = z.enum(["started", "succeeded", "waiting", "blocked", "failed", "skipped"]);
export const traceQuerySchema = z.object({
  jobId: z.string().min(1).max(100).optional(), // Job id or human key, e.g. AG-177.
  descendants: z.boolean().default(true),
  beforeId: z.number().int().positive().optional(),
  since: z.string().datetime({ offset: true }).optional(),
  step: z.string().min(1).max(80).optional(),
  outcome: traceOutcomeSchema.optional(),
  minRepeats: z.number().int().min(1).optional(),
  minDurationMs: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();
export type TraceQuery = z.infer<typeof traceQuerySchema>;

export const traceRecordSchema = z.object({
  id: z.number().int(), firstAt: z.string(), lastAt: z.string(), repeats: z.number().int(),
  jobId: z.string().nullable(), jobKey: z.string().nullable(), rootJobId: z.string().nullable(),
  revision: z.number().int().nullable(), state: z.string().nullable(),
  step: z.string(), outcome: traceOutcomeSchema, reason: z.string(),
  requestId: z.string().nullable(), attemptId: z.string().nullable(), launchId: z.string().nullable(),
  threadId: z.string().nullable(), artifactHash: z.string().nullable(),
  relatedJobId: z.string().nullable(), durationMs: z.number().nullable(),
  facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
}).strict();
export const traceViewSchema = z.object({
  records: z.array(traceRecordSchema), nextBeforeId: z.number().nullable(),
  summary: z.array(z.object({ step: z.string(), outcome: z.string(), reason: z.string(), episodes: z.number(), observations: z.number(), maxDurationMs: z.number().nullable() })),
  retention: z.object({ days: z.number(), maxRows: z.number(), oldestAt: z.string().nullable() }),
  health: z.object({ writeFailures: z.number(), lastFailureAt: z.string().nullable() }),
}).strict();
