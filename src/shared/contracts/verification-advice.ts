import { z } from "zod";
import { opaqueIdSchema } from "./ids";

/** Worker-supplied change evidence; advisory only, never an attestation or a hand-in. */
export const verificationAdviceInputSchema = z.object({
  jobId: opaqueIdSchema,
  phase: z.enum(["implementation", "final"]),
  diff: z.string().min(1),
  changedPaths: z.array(z.string().min(1)).min(1),
  completeDiff: z.boolean(),
  knownFailure: z.boolean(),
  requiredNow: z.boolean(),
}).strict();
export const verificationAdviceSchema = z.object({
  action: z.enum(["defer_to_final", "targeted_now", "review_required", "final_checks"]),
  reason: z.string(),
  finalChecksRequired: z.literal(true),
  advisory: z.literal(true),
  inputHash: z.string(),
  inputBytes: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1).nullable(),
  model: z.string().nullable(),
  answers: z.string(),
  ms: z.number().nonnegative(),
}).strict();
export type VerificationAdviceInput = z.infer<typeof verificationAdviceInputSchema>;
export type VerificationAdvice = z.infer<typeof verificationAdviceSchema>;
