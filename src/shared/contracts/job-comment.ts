import { z } from "zod";
import { activityCommentSchema } from "./activity";
import { bbProjectIdSchema, externalIdSchema, opaqueIdSchema } from "./ids";
import { createCommandSchema } from "./revision";

/** Forced on the comment path. Callers cannot choose a system event kind. */
export const JOB_COMMENT_KIND = "comment" as const;

/**
 * Intake assessment is data, not prose: a lead's comment carries size, risk and
 * decision as references, so the card and reports read them without parsing text.
 */
export const INTAKE_REFERENCE_VALUES = {
  intake_size: ["S", "M", "L"],
  intake_risk: ["low", "medium", "high"],
  intake_decision: ["accept", "split", "clarify", "return"],
} as const;

export type IntakeReferenceType = keyof typeof INTAKE_REFERENCE_VALUES;

export const INTAKE_REFERENCE_TYPES = Object.keys(INTAKE_REFERENCE_VALUES) as IntakeReferenceType[];

export function isIntakeReferenceType(type: string): type is IntakeReferenceType {
  return Object.hasOwn(INTAKE_REFERENCE_VALUES, type);
}

export const jobCommentReferenceSchema = z
  .object({
    type: z.enum(["artifact", "thread", "intake_size", "intake_risk", "intake_decision"]),
    id: externalIdSchema,
  })
  .strict()
  .superRefine((reference, ctx) => {
    if (!isIntakeReferenceType(reference.type)) return;
    const allowed: readonly string[] = INTAKE_REFERENCE_VALUES[reference.type];
    if (!allowed.includes(reference.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["id"],
        message: `${reference.type} must be one of ${allowed.join(", ")}`,
      });
    }
  });

/** An assessment is all three references once, or none of them. */
export function intakeReferencesComplete(references: readonly { type: string }[]): boolean {
  const intake = references.filter((reference) => isIntakeReferenceType(reference.type));
  if (intake.length === 0) return true;
  return INTAKE_REFERENCE_TYPES.every(
    (type) => intake.filter((reference) => reference.type === type).length === 1,
  ) && intake.length === INTAKE_REFERENCE_TYPES.length;
}

/**
 * CLI/public write for job history comments.
 * No `kind`, no `actor`: kind is always comment; actor comes from trusted CLI proof.
 */
export const createJobCommentRpcSchema = createCommandSchema
  .extend({
    jobId: opaqueIdSchema,
    comment: activityCommentSchema,
    references: z.array(jobCommentReferenceSchema).default([]),
    claimedBbProjectId: bbProjectIdSchema.optional(),
  })
  .strict();

export type JobCommentReference = z.infer<typeof jobCommentReferenceSchema>;
export type CreateJobCommentRpc = z.infer<typeof createJobCommentRpcSchema>;
