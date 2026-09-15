/** Exact Run thread for the job card. Not the assigned agent's personal thread. */

export function scopedAttemptThreadId(
  item:
    | {
        attempt?: { threadId?: string | null };
        receipt?: { threadId?: string | null } | null;
      }
    | null
    | undefined,
): string | null {
  const attempt = item?.attempt?.threadId?.trim() ?? "";
  const receipt = item?.receipt?.threadId?.trim() ?? "";
  if (attempt && receipt && attempt !== receipt) return null;
  if (attempt) return attempt;
  if (receipt) return receipt;
  return null;
}

export function canOpenNativeThread(navigate: { toThread?: (threadId: string) => void } | null | undefined): boolean {
  return typeof navigate?.toThread === "function";
}
