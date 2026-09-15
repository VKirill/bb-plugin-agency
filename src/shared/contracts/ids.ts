import { z } from "zod";

/** Version of the stage-1 domain/API schemas. Bump only with a compatible export review. */
export const STAGE1_CONTRACT_VERSION = "agency.domain.stage1.v1" as const;

/** Opaque internal id. Not a display name and not a user-facing job key. */
export const opaqueIdSchema = z
  .string()
  .trim()
  .min(8)
  .max(64)
  .regex(/^[a-z][a-z0-9]*_[a-z0-9]{8,48}$/);

export type OpaqueId = z.infer<typeof opaqueIdSchema>;

/** BB `skills.list` id (`skill_` + 64 hex). Not an Agency entity id. */
export const catalogSkillIdSchema = z
  .string()
  .trim()
  .regex(/^skill_[a-f0-9]{64}$/);

/** BB MCP catalog id when discovery exists. Not an Agency entity id. */
export const catalogMcpIdSchema = z
  .string()
  .trim()
  .regex(/^mcp_[a-f0-9]{64}$/);

export type CatalogSkillId = z.infer<typeof catalogSkillIdSchema>;
export type CatalogMcpId = z.infer<typeof catalogMcpIdSchema>;

/** User-visible job key. Unique, never used as a foreign key. */
export const jobKeySchema = z
  .string()
  .trim()
  .regex(/^AG-\d{1,8}$/);

export type JobKey = z.infer<typeof jobKeySchema>;

export const displayNameSchema = z.string().trim().min(1).max(180);

const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

export function isUtcInstant(value: string): boolean {
  const match = UTC_INSTANT.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() + 1 === month &&
    parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour &&
    parsed.getUTCMinutes() === minute &&
    parsed.getUTCSeconds() === second
  );
}

/** UTC instant. Schedule timezone is stored separately from this field. */
export const utcInstantSchema = z.string().refine(isUtcInstant, "invalid UTC instant");

export const requestIdSchema = z.string().uuid();

/** BB-issued or other external identifier. Not an Agency opaque id. */
export const externalIdSchema = z.string().trim().min(1).max(160);

export const bbProjectIdSchema = externalIdSchema;
export const bbEnvironmentIdSchema = externalIdSchema;
export const hostIdSchema = externalIdSchema;
