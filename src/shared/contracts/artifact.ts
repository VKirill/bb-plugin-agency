import { z } from "zod";
import { externalIdSchema, hostIdSchema, opaqueIdSchema } from "./ids";
import { changeCommandSchema, createCommandSchema } from "./revision";

export const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const relativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^(?![/\\])(?!.*(?:^|\/)\.\.(?:\/|$))[^\\]+$/);

export const artifactAuthorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: externalIdSchema }).strict(),
  z.object({ kind: z.literal("run"), runId: opaqueIdSchema }).strict(),
  z.object({ kind: z.literal("system") }).strict(),
]);

export const artifactSchema = z
  .object({
    id: opaqueIdSchema,
    jobId: opaqueIdSchema,
  })
  .strict();

export const artifactVersionSchema = z
  .object({
    artifactId: opaqueIdSchema,
    jobId: opaqueIdSchema,
    version: z.number().int().positive(),
    hostId: hostIdSchema,
    relativePath: relativePathSchema,
    mime: z.string().trim().min(1).max(180),
    size: z.number().int().nonnegative(),
    hash: contentHashSchema,
    author: artifactAuthorSchema,
  })
  .strict();

export const publishArtifactVersionCommandSchema = createCommandSchema
  .extend({
    artifactId: opaqueIdSchema,
    jobId: opaqueIdSchema,
    hostId: hostIdSchema,
    relativePath: relativePathSchema,
    mime: z.string().trim().min(1).max(180),
    size: z.number().int().nonnegative(),
    hash: contentHashSchema,
    author: artifactAuthorSchema,
  })
  .strict();

export const acceptArtifactVersionCommandSchema = changeCommandSchema
  .extend({
    jobId: opaqueIdSchema,
    artifactId: opaqueIdSchema,
    version: z.number().int().positive(),
    hash: contentHashSchema,
    reviewResolution: z.object({
      reviewJobId: opaqueIdSchema,
      reason: z.string().trim().min(1).max(4000),
    }).strict().optional(),
  })
  .strict();

export type ArtifactAuthor = z.infer<typeof artifactAuthorSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type ArtifactVersion = z.infer<typeof artifactVersionSchema>;
export type PublishArtifactVersionCommand = z.infer<typeof publishArtifactVersionCommandSchema>;
export type AcceptArtifactVersionCommand = z.infer<typeof acceptArtifactVersionCommandSchema>;
