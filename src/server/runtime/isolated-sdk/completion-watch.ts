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
};

/**
 * Owned poll + optional event hint. Event payloads are not authority:
 * each pass re-reads threads.get and artifact open/hash, then applies store review.
 * Dispose stops both. Reload: new watch + poll reconciles the same receipts.
 * Overlapping poll/hints coalesce. One row error does not stop the rest.
 */
export function createCompletionWatch(deps: CompletionWatchDeps) {
  let disposed = false;
  let inFlight = false;
  let coalesced = false;
  const pollMs = deps.pollMs ?? 5_000;

  async function reconcileOne(row: BoundLaunchWatch): Promise<AppliedCompletion | null> {
    let threadStatus: string | null = null;
    let thread: IsolatedThreadView | null = null;
    try {
      thread = await deps.threads.get({ threadId: row.threadId, include: "environment,host" });
      threadStatus = thread.status ?? null;
    } catch {
      threadStatus = null;
    }
    if (disposed) return null;
    let artifact: PublishedJobReading = {
      publishedVerified: false,
      acceptedVerified: false,
      publishedHash: null,
    };
    try {
      artifact = await deps.readPublishedForJob(row.jobId);
    } catch {
      return null;
    }
    if (disposed) return null;
    const reading = interpretVerifiedCompletion({
      threadStatus,
      publishedVerified: artifact.publishedVerified,
      acceptedVerified: artifact.acceptedVerified,
    });
    const applied = await deps.applyReading(row, reading, artifact.publishedHash, thread);
    if (disposed) return null;
    return applied;
  }

  async function runPass(): Promise<void> {
    if (disposed) return;
    if (inFlight) {
      coalesced = true;
      return;
    }
    inFlight = true;
    try {
      do {
        coalesced = false;
        for (const row of deps.listBoundLaunches()) {
          if (disposed) return;
          try {
            const reading = await reconcileOne(row);
            if (disposed || !reading) continue;
            deps.onReading?.(row.jobId, reading);
          } catch {
            continue;
          }
        }
      } while (coalesced && !disposed);
    } finally {
      inFlight = false;
    }
  }

  async function poll(): Promise<void> {
    try {
      await runPass();
    } catch {
      return;
    }
  }

  const timer = setInterval(() => {
    void poll();
  }, pollMs);

  function hintFromCoreEvent(thread: IsolatedThreadView): void {
    if (disposed) return;
    const row = deps.listBoundLaunches().find((item) => item.threadId === thread.id);
    if (!row) return;
    void poll();
  }

  return {
    poll,
    hintFromCoreEvent,
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
    get disposed() {
      return disposed;
    },
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
