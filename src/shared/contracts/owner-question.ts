import { z } from "zod";
import { requestIdSchema } from "./ids";

/** `app.slots.pendingInteraction` id; must match `bb.ui.requestInput` rendererId. */
export const OWNER_QUESTION_RENDERER_ID = "agency-owner-question";

export const ownerAskOverlayOptionSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(400),
  })
  .strict();

export const ownerAskOverlayQuestionSchema = z
  .object({
    header: z.string().trim().min(1).max(12),
    question: z.string().trim().min(1).max(4_000),
    options: z.array(ownerAskOverlayOptionSchema).min(2).max(4),
  })
  .strict();

export const ownerAskToolInputSchema = z
  .object({
    questions: z.array(ownerAskOverlayQuestionSchema).min(1).max(4).optional(),
  })
  .strict();

export const ownerQuestionOptionSchema = z
  .object({
    id: z.string().trim().min(1).max(40),
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(400).optional(),
  })
  .strict();

export const ownerQuestionTargetSchema = z
  .object({
    waitId: requestIdSchema,
    questionId: z.string().trim().min(1).max(80),
  })
  .strict();

export const ownerQuestionItemSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    header: z.string().trim().min(1).max(12),
    text: z.string().trim().min(1).max(4_000),
    options: z.array(ownerQuestionOptionSchema).max(4),
    targets: z.array(ownerQuestionTargetSchema).max(16),
  })
  .strict();

export const ownerQuestionPayloadSchema = z
  .object({
    jobs: z
      .array(
        z
          .object({
            key: z.string().trim().min(1).max(40),
            title: z.string().trim().min(1).max(240),
          })
          .strict(),
      )
      .max(16),
    items: z.array(ownerQuestionItemSchema).min(1).max(4),
  })
  .strict();

export const ownerQuestionResponseSchema = z
  .object({
    answers: z.record(z.string(), z.string().trim().min(1).max(4_000)),
  })
  .strict();

export type OwnerAskOverlayQuestion = z.infer<typeof ownerAskOverlayQuestionSchema>;
export type OwnerAskToolInput = z.infer<typeof ownerAskToolInputSchema>;
export type OwnerQuestionOption = z.infer<typeof ownerQuestionOptionSchema>;
export type OwnerQuestionItem = z.infer<typeof ownerQuestionItemSchema>;
export type OwnerQuestionPayload = z.infer<typeof ownerQuestionPayloadSchema>;
export type OwnerQuestionResponse = z.infer<typeof ownerQuestionResponseSchema>;
