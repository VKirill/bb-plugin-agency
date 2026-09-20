import { callerAttemptForThread, callerThreadId } from "../../api/caller.js";
import type { SqlDatabase } from "../../db/sql";

const THREAD = /^thr_[a-z0-9]{6,72}$/i;

export function isOriginThreadId(value: string | null | undefined): value is string {
  return typeof value === "string" && THREAD.test(value.trim());
}

/**
 * Client chat that commissioned the job. Explicit field wins, then the parent
 * job, then the owner's CLI thread. An employee attempt thread is never stored:
 * that is the factory, not the customer.
 */
export function resolveJobOriginThreadId(
  db: SqlDatabase,
  input: { originThreadId?: string | null },
  parent: { originThreadId?: string | null } | null,
): string | null {
  const explicit = input.originThreadId?.trim() || null;
  if (isOriginThreadId(explicit)) return explicit;
  const inherited = parent?.originThreadId?.trim() || null;
  if (isOriginThreadId(inherited)) return inherited;
  const thread = callerThreadId()?.trim() || null;
  if (!isOriginThreadId(thread)) return null;
  if (callerAttemptForThread(db, thread)) return null;
  return thread;
}
