/** A factory lifetime: old asynchronous work may finish, but cannot apply again. */
export function createRuntimeLifetime() {
  let active = true;
  return { isActive: () => active, dispose: () => { active = false; } };
}

export class ObservationUnavailable extends Error {
  constructor(readonly code: "observation_timeout" | "runtime_disposed") { super(code); }
}

/** Read-only calls only. A timed-out underlying call stays single-flight until it
 * settles; polling cannot accumulate requests or apply its late result. */
export function createBoundedReader(isActive: () => boolean, timeoutMs = 15_000) {
  const pending = new Map<string, { promise: Promise<unknown>; expires: number }>();
  return async function read<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (!isActive()) throw new ObservationUnavailable("runtime_disposed");
    let entry = pending.get(key);
    if (!entry) {
      const promise = Promise.resolve().then(() => {
        if (!isActive()) throw new ObservationUnavailable("runtime_disposed");
        return operation();
      });
      entry = { promise, expires: Date.now() + timeoutMs };
      pending.set(key, entry);
      const clear = () => { if (pending.get(key)?.promise === promise) pending.delete(key); };
      void promise.then(clear, clear);
    }
    const remaining = entry.expires - Date.now();
    if (remaining <= 0) throw new ObservationUnavailable("observation_timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([entry.promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ObservationUnavailable("observation_timeout")), remaining);
      })]);
      if (!isActive()) throw new ObservationUnavailable("runtime_disposed");
      return result as T;
    } finally { if (timer) clearTimeout(timer); }
  };
}

/** Never log arbitrary exception messages: they may contain credentials. */
export function observationErrorCode(error: unknown): string {
  if (error instanceof ObservationUnavailable) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[a-zA-Z0-9_.:-]{1,80}$/.test(code) ? code : "observation_rpc_failed";
}
