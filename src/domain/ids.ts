import {
  displayNameSchema,
  jobKeySchema,
  opaqueIdSchema,
  type JobKey,
  type OpaqueId,
} from "../shared/contracts";

export function isOpaqueId(value: string): value is OpaqueId {
  return opaqueIdSchema.safeParse(value).success;
}

export function isJobKey(value: string): value is JobKey {
  return jobKeySchema.safeParse(value).success;
}

export function isDisplayName(value: string): boolean {
  return displayNameSchema.safeParse(value).success;
}

/** Names and user keys never participate in foreign-key equality. */
export function sameEntity(left: string, right: string): boolean {
  const parsedLeft = opaqueIdSchema.safeParse(left);
  const parsedRight = opaqueIdSchema.safeParse(right);
  return parsedLeft.success && parsedRight.success && parsedLeft.data === parsedRight.data;
}
