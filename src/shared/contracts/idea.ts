import { z } from "zod";
import { knowledgeSectionIdSchema } from "./knowledge-scope";
import { opaqueIdSchema } from "./ids";

export const IDEA_KINDS = ["idea", "todo"] as const;
export const IDEA_STATUSES = ["open", "parked", "done", "archived"] as const;

export const ideaKindSchema = z.enum(IDEA_KINDS);
export const ideaStatusSchema = z.enum(IDEA_STATUSES);

export const ideaItemSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    body: z.string(),
    kind: ideaKindSchema,
    status: ideaStatusSchema,
    bindingId: opaqueIdSchema,
    sectionId: knowledgeSectionIdSchema.nullable(),
    sectionLabel: z.string(),
    sourceThreadId: z.string().nullable(),
    relativePath: z.string(),
    fileHash: z.string().nullable(),
    fileWritten: z.boolean(),
    bbProjectId: z.string().nullable(),
    hostId: z.string().nullable(),
    projectPath: z.string().nullable(),
    revision: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const saveIdeaInputSchema = z
  .object({
    id: z.string().optional(),
    expectedRevision: z.number().int().min(0),
    title: z.string().trim().min(1).max(200),
    body: z.string().max(20_000),
    kind: ideaKindSchema.optional(),
    status: ideaStatusSchema.optional(),
    bindingId: opaqueIdSchema,
    sectionId: knowledgeSectionIdSchema.nullable().optional(),
    sectionLabel: z.string().trim().max(200).optional(),
    sourceThreadId: z.string().trim().max(80).nullable().optional(),
  })
  .strict();

export const listIdeasInputSchema = z.union([
  z.null(),
  z
    .object({
      bindingId: opaqueIdSchema.optional(),
      bbProjectId: z.string().optional(),
      sectionId: knowledgeSectionIdSchema.optional(),
      kind: ideaKindSchema.optional(),
      status: ideaStatusSchema.optional(),
    })
    .strict(),
]);

export const setIdeaStatusInputSchema = z
  .object({
    id: z.string().min(1),
    expectedRevision: z.number().int(),
    status: ideaStatusSchema,
  })
  .strict();

/** Selections from experimental_NewThreadComposer, forwarded to threads.spawn. */
export const ideaComposerRequestSchema = z
  .object({
    projectId: z.string().min(1),
    providerId: z.string().min(1),
    model: z.string().min(1),
    reasoningLevel: z.string().min(1),
    permissionMode: z.string().min(1),
    serviceTier: z.string().optional(),
    executionInputSources: z.record(z.string(), z.unknown()).optional(),
    environment: z.unknown(),
    input: z.array(z.unknown()),
    sendAt: z.number().optional(),
  })
  .passthrough();

export const spawnIdeaThreadInputSchema = z
  .object({
    id: z.string().min(1),
    request: ideaComposerRequestSchema,
  })
  .strict();

export const spawnedIdeaThreadSchema = z
  .object({
    threadId: z.string().min(1),
  })
  .strict();

export type IdeaKind = z.infer<typeof ideaKindSchema>;
export type IdeaStatus = z.infer<typeof ideaStatusSchema>;
export type IdeaItemView = z.infer<typeof ideaItemSchema>;
export type SaveIdeaInput = z.infer<typeof saveIdeaInputSchema>;
export type ListIdeasInput = z.infer<typeof listIdeasInputSchema>;
export type IdeaComposerRequest = z.infer<typeof ideaComposerRequestSchema>;
export type SpawnIdeaThreadInput = z.infer<typeof spawnIdeaThreadInputSchema>;
