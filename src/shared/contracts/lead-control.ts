import { contentHashSchema } from "./artifact";
import { z } from "zod";
import { opaqueIdSchema, requestIdSchema } from "./ids";
import { jobSchema } from "./job";

const note = z.string().trim().min(1).max(2000);
export const leadDecisionSchema = z.object({
  unknowns: z.array(note).max(30),
  bottleneck: note,
  action: z.enum(["inspect", "delegate", "repair", "wait", "ask_owner", "deliver"]),
  rationale: note,
  nextCheck: note,
  evidence: z.array(note).max(30),
}).strict();
export const recordLeadDecisionSchema = z.object({
  requestId: requestIdSchema, jobId: opaqueIdSchema,
  expectedRevision: z.number().int().min(0), decision: leadDecisionSchema,
}).strict();
export const leadDecisionRecordSchema = z.object({
  revision: z.number().int().positive(), decision: leadDecisionSchema, activityId: opaqueIdSchema,
}).strict();
export const submitJobResultSchema = z.object({
  requestId: requestIdSchema, jobId: opaqueIdSchema, expectedRevision: z.number().int().positive(),
  artifactId: opaqueIdSchema, version: z.number().int().positive(), hash: contentHashSchema,
  comment: z.string().trim().min(1).max(8000),
}).strict();
export const leadStateQuerySchema = z.object({ jobId: opaqueIdSchema, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(30), beforeDecisionRevision: z.number().int().positive().optional() }).strict();
export const recordLessonFeedbackSchema = z.object({
  requestId: requestIdSchema, jobId: opaqueIdSchema, knowledgeId: opaqueIdSchema,
  expectedRevision: z.number().int().positive(),
  outcome: z.enum(["helped", "not_helpful", "harmful", "not_applicable"]),
  evidence: z.array(note).min(1).max(10), comment: note,
}).strict();
export type RecordLessonFeedback = z.infer<typeof recordLessonFeedbackSchema>;
export const progressSignalSchema = z.object({
  step: z.string(), reason: z.string(), count: z.number().int(),
  traceIds: z.array(z.number().int()), attemptId: opaqueIdSchema,
}).strict();
export const leadStateSchema = z.object({
  job: jobSchema,
  decision: leadDecisionRecordSchema.nullable(),
  decisions: z.array(leadDecisionRecordSchema), nextDecisionBeforeRevision: z.number().int().positive().nullable(),
  lessonCandidates: z.array(z.object({ id: opaqueIdSchema, title: z.string(), summary: z.string(), source: z.string(), revision: z.number().int().positive() }).strict()),
  lessonCandidateCount: z.number().int().min(0),
  decisionRevision: z.number().int().min(0),
  decisionFreshness: z.object({
    status: z.enum(["missing", "current", "new_facts"]), count: z.number().int(),
    changes: z.array(z.object({ activityId: opaqueIdSchema, jobId: opaqueIdSchema, kind: z.string() }).strict()),
  }).strict(),
  progressSignal: progressSignalSchema.nullable(),
  lessonFeedback: z.array(z.object({ knowledgeId: opaqueIdSchema, revision: z.number().int(), jobId: opaqueIdSchema,
    outcome: recordLessonFeedbackSchema.shape.outcome, evidence: z.array(z.string()), comment: z.string(), activityId: opaqueIdSchema,
  }).strict()),
  children: z.array(z.object({ id: opaqueIdSchema, key: z.string(), title: z.string(), state: z.string(), assignedAgentId: opaqueIdSchema.nullable() }).strict()),
  childCounts: z.record(z.string(), z.number().int()), nextOffset: z.number().int().nullable(),
  publications: z.array(z.object({ artifactId: opaqueIdSchema, version: z.number().int(), hash: contentHashSchema, relativePath: z.string() }).strict()),
  handIn: z.object({ protocol: z.enum(["explicit", "legacy"]), dependenciesReady: z.boolean(), submittedHash: contentHashSchema.nullable() }).strict(),
  guidance: z.string(),
}).strict();
export type LeadDecision = z.infer<typeof leadDecisionSchema>;
export type RecordLeadDecision = z.infer<typeof recordLeadDecisionSchema>;
export type SubmitJobResult = z.infer<typeof submitJobResultSchema>;
