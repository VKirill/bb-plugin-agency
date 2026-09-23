import { z } from "zod";

export const recoveryDecisionSchema = z.object({
  cause: z.string().trim().min(10).max(2000),
  correction: z.string().trim().min(10).max(2000),
  verification: z.string().trim().min(10).max(2000),
}).strict();
export type RecoveryDecision = z.infer<typeof recoveryDecisionSchema>;
