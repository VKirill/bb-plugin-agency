import { z } from "zod";
import { jobKeySchema, opaqueIdSchema, requestIdSchema } from "./ids";

/** Outcome code for close and cancel from an origin-chat stale answer. */
export const STALE_OUTCOME_CODE = "closed_by_origin_agent" as const;

export const STALE_ANSWER_REFUSAL_CODES = [
  "not_stale_candidate",
  "needs_acceptance",
  "revision_conflict",
  "duplicate",
  "foreign_thread",
  "live_attempt",
] as const;

export const staleAnswerRefusalCodeSchema = z.enum(STALE_ANSWER_REFUSAL_CODES);
export type StaleAnswerRefusalCode = z.infer<typeof staleAnswerRefusalCodeSchema>;

export const staleNudgeSendStateSchema = z.enum([
  "pending",
  "queued",
  "confirmed",
  "unknown",
  "rejected",
  "skipped",
]);
export type StaleNudgeSendState = z.infer<typeof staleNudgeSendStateSchema>;

export const staleAnswerDecisionSchema = z.enum(["close", "cancel", "keep", "escalate"]);
export type StaleAnswerDecision = z.infer<typeof staleAnswerDecisionSchema>;

export function nudgeId(jobId: string, stateSince: string, n: number): string {
  return `stale:${jobId}:${stateSince}:${n}`;
}

export function batchId(originThreadId: string, claimedAt: Date | string | number): string {
  const ms =
    typeof claimedAt === "number"
      ? claimedAt
      : typeof claimedAt === "string"
        ? Date.parse(claimedAt)
        : claimedAt.getTime();
  const seconds = Math.floor(ms / 1000);
  return `stalebatch:${originThreadId}:${seconds}`;
}

export function staleNudgeToken(id: string): string {
  return `agency.staleNudge:${id}`;
}

export function staleBatchToken(id: string): string {
  return `agency.staleBatch:${id}`;
}

export const staleAnswerJobIdSchema = z.union([opaqueIdSchema, jobKeySchema]);

export const staleAnswerSchema = z
  .object({
    requestId: requestIdSchema,
    jobId: staleAnswerJobIdSchema,
    nudgeId: z.string().trim().min(1).max(240),
    expectedJobRevision: z.number().int(),
    decision: staleAnswerDecisionSchema,
    reason: z.string().trim().min(1).max(2000),
    nextCheckHours: z.number().int().min(1).max(168).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision === "keep") {
      if (value.nextCheckHours === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nextCheckHours"],
          message: "nextCheckHours is required when decision is keep",
        });
      }
    } else if (value.nextCheckHours !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextCheckHours"],
        message: "nextCheckHours is only allowed when decision is keep",
      });
    }
  });

export const staleAnswerRpcSchema = staleAnswerSchema;
export type StaleAnswerCommand = z.infer<typeof staleAnswerSchema>;
