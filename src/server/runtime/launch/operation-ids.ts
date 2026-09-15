import { createHash } from "node:crypto";

export const LAUNCH_OPS = [
  "cas-launching",
  "stale-block",
  "rejected",
  "canceled",
  "bind-running",
  "unknown",
  "reconcile-bind",
  "reconcile-failed",
  "reconcile-canceled",
  "receipt",
  "repair-job",
] as const;

export type LaunchOp = (typeof LAUNCH_OPS)[number];

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

/** RFC 4122 UUID v5. Parent requestId is the namespace — result stays a UUID. */
export function uuidV5(namespaceUuid: string, name: string): string {
  const digest = createHash("sha1")
    .update(uuidBytes(namespaceUuid))
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = Buffer.from(digest).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function launchOpRequestId(parentRequestId: string, op: LaunchOp): string {
  return uuidV5(parentRequestId, `agency.launch.${op}`);
}
