import { z } from "zod";

export const knowledgeScopeKindSchema = z.enum(["agency", "department", "project", "section"]);

/** Id of a project-folders section (folder UUID), same bounds as ProjectBinding.sectionId. */
export const knowledgeSectionIdSchema = z.string().trim().min(1).max(160);

export type KnowledgeScopeKind = z.infer<typeof knowledgeScopeKindSchema>;
