import { createBoundedReader, observationErrorCode } from "../observation/control";
import type { IsolatedThreadView, IsolatedThreadsApi } from "./sdk-ports.js";
import { interpretVerifiedCompletion, type CompletionReading } from "./completion.js";
import type { AppliedCompletion } from "./completion-apply.js";

export type BoundLaunchWatch = {
  threadId: string;
  jobId: string;
  launchId: string;
};

export type PublishedJobReading = {
  publishedVerified: boolean;
  acceptedVerified: boolean;
  publishedHash: string | null;
};

export type CompletionWatchDeps = {
  threads: IsolatedThreadsApi;
  listBoundLaunches: () => BoundLaunchWatch[];
  readPublishedForJob: (jobId: string) => Promise<PublishedJobReading>;
  applyReading: (
    row: BoundLaunchWatch,
    reading: CompletionReading,
    publishedHash: string | null,
    thread?: IsolatedThreadView | null,
  ) => Promise<AppliedCompletion>;
  onReading?: (jobId: string, reading: AppliedCompletion) => void;
  pollMs?: number;
  readTimeoutMs?: number;
  isActive?: () => boolean;
  onObservation?: (row: BoundLaunchWatch, stage: string, code: string | null) => void;
  onGlobalError?: (code: string) => void;
};

/**
 * Owned poll + optional event hint. Event payloads are not authority:
 * each pass re-reads threads.get and artifact open/hash, then applies store review.
 * Dispose stops both. Reload: new watch + poll reconciles the same receipts.
 * Overlapping poll/hints coalesce. One row error does not stop the rest.
 */
export function createCompletionWatch(deps: CompletionWatchDeps) {
  let disposed = false;
  let cursor = 0;
  const active = () => !disposed && deps.isActive?.() !== false;
  const timeoutMs = deps.readTimeoutMs ?? 15_000;
  const read = createBoundedReader(active, timeoutMs);
  const flights = new Map<string, { promise: Promise<void>; applyingAt: number | null }>();
  const observation = (row: BoundLaunchWatch, stage: string, code: string | null) => {
    if (active()) deps.onObservation?.(row, stage, code);
  };
  async function observe<T>(row: BoundLaunchWatch, stage: string, operation: () => Promise<T>): Promise<T> {
    try {
      const value = await read(`${row.launchId}:${stage}`, operation);
      observation(row, stage, null);
      return value;
    } catch (error) {
      observation(row, stage, observationErrorCode(error));
      throw error;
    }
  }
  async function reconcileOne(row: BoundLaunchWatch): Promise<void> {
    const thread = await observe(row, "thread", () => deps.threads.get({ threadId: row.threadId, include: "environment,host" }));
    if (!active()) return;
    // Artifact I/O is needed for handing in an idle worker, not for supervising
    // a running/failed turn. An offline result host must not hide reconnect.
    const artifact = thread.status === "idle"
      ? await observe(row, "artifact", () => deps.readPublishedForJob(row.jobId))
      : { publishedVerified: false, acceptedVerified: false, publishedHash: null };
    if (!active()) return;
    const reading = interpretVerifiedCompletion({ threadStatus: thread.status ?? null,
      publishedVerified: artifact.publishedVerified, acceptedVerified: artifact.acceptedVerified });
    const flight = flights.get(row.launchId);
    if (flight) flight.applyingAt = Date.now();
    try {
      // Mutations are never timed out/replayed. Other rows remain observable;
      // a stuck apply is reported by subsequent polls until its actual settlement.
      const applied = await deps.applyReading(row, reading, artifact.publishedHash, thread);
      if (!active()) return;
      observation(row, "apply", null);
      deps.onReading?.(row.jobId, applied);
    } catch (error) {
      observation(row, "apply", observationErrorCode(error));
    }
  }
  async function poll(): Promise<void> {
    if (!active()) return;
    try {
      const waits: Promise<void>[] = [];
      const rows = deps.listBoundLaunches();
      const start = rows.length ? cursor % rows.length : 0;
      for (let offset = 0; offset < rows.length; offset++) {
        const index = (start + offset) % rows.length;
        const row = rows[index]!;
        if (!active()) break;
        const current = flights.get(row.launchId);
        if (current) {
          if (current.applyingAt !== null && Date.now() - current.applyingAt >= timeoutMs)
            observation(row, "apply", "observation_timeout");
          // A periodic poll must not itself wait on an already stuck mutation:
          // otherwise each timer tick retains another never-settling Promise.all.
          continue;
        }
        // Bounded parallel reads: one slow row does not stop the whole watch.
        if (flights.size >= 4) continue;
        const flight = { promise: Promise.resolve(), applyingAt: null as number | null };
        flights.set(row.launchId, flight);
        cursor = index + 1;
        flight.promise = reconcileOne(row).catch(() => { /* observe recorded the failing stage */ })
          .finally(() => { if (flights.get(row.launchId) === flight) flights.delete(row.launchId); });
        waits.push(flight.promise);
      }
      await Promise.all(waits);
    } catch (error) {
      if (active()) deps.onGlobalError?.(observationErrorCode(error));
    }
  }
  const timer = setInterval(() => { void poll(); }, deps.pollMs ?? 5_000);
  return {
    poll,
    hintFromCoreEvent(thread: IsolatedThreadView) {
      if (!active()) return;
      try { if (deps.listBoundLaunches().some(row => row.threadId === thread.id)) void poll(); }
      catch (error) { deps.onGlobalError?.(observationErrorCode(error)); }
    },
    dispose() { disposed = true; clearInterval(timer); },
    get disposed() { return !active(); },
  };
}

/**
 * The watch reads every bound launch each pass. Screens only need to hear about a
 * job when its reading changed; publishing every pass makes each open page reload
 * several times a second while launches are bound.
 */
export function createReadingChangeGate(): (jobId: string, reading: AppliedCompletion) => boolean {
  const last = new Map<string, string>();
  return (jobId, reading) => {
    const signature = JSON.stringify(reading);
    if (last.get(jobId) === signature) return false;
    last.set(jobId, signature);
    return true;
  };
}

export function attachDisposableThreadHints(
  events: { on(event: "thread.idle" | "thread.failed", handler: (payload: { thread: IsolatedThreadView }) => void): void },
  watch: { hintFromCoreEvent(thread: IsolatedThreadView): void; dispose(): void; readonly disposed: boolean },
  onDispose: (hook: () => void) => void,
): void {
  events.on("thread.idle", (payload) => {
    if (!watch.disposed) watch.hintFromCoreEvent(payload.thread);
  });
  events.on("thread.failed", (payload) => {
    if (!watch.disposed) watch.hintFromCoreEvent(payload.thread);
  });
  onDispose(() => watch.dispose());
}
