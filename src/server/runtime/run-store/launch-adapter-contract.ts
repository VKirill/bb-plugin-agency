/**
 * Launch adapter contract for a future spawn worker.
 *
 * Persist lives in `createRunStore` (`prepared` reserve). The launch worker is
 * `src/server/runtime/launch` (ports + coordinator). This module does not
 * spawn, does not mark execution available, and does not set Job.state.
 *
 * launchPreparedRun MUST:
 * 1. Load snapshot+attempt by snapshotId; fail if stored digest ≠ request digest.
 * 2. Re-check hostId/canonicalRoot against the live binding. Reserve already
 *    compares live identity; compile digest is still not auth.
 * 3. CAS `prepared` → `launching` with requestId (no job running yet).
 * 4. After a confirmed thread bind, CAS `launching` → `running` with threadId.
 *    Only a separate job service may then set Job.state=running.
 * 5. Confirmed transport failure → `failed`. Uncertain transport → `unknown`.
 *    `unknown` ≠ `failed`. Do not automatically retry spawn from either.
 * 6. A new attempt after inspection is a new reserve, not a silent overwrite.
 */
export const RUN_LAUNCH_ADAPTER_CONTRACT = {
  executionAvailable: false,
  persist: "run-store.reservePreparedRun",
  spawn: "not_implemented",
  jobRunningRequiresConfirmedThread: true,
  automaticSpawnRetry: false,
} as const;
