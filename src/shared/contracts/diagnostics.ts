import { z } from "zod";
import { traceViewSchema } from "./trace";

export const jobDiagnosticsQuerySchema = z.object({
  jobId: z.string().min(1).max(100),
  attemptId: z.string().min(1).max(100).optional(),
  beforeSeq: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();
export const jobDiagnosticsViewSchema = z.object({
  jobId: z.string(), jobKey: z.string(), history: z.string(),
  attempts: z.array(z.object({ attemptId: z.string(), threadId: z.string().nullable(), state: z.string(), createdAt: z.string() })),
  trace: traceViewSchema,
  conversation: z.object({ threadId: z.string().nullable(), entries: z.array(z.object({ seq: z.number(), type: z.string(), text: z.string() })),
    nextBeforeSeq: z.number().nullable(), error: z.string().nullable() }),
}).strict();
