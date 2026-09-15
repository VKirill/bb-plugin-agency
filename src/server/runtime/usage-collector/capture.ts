import type { TokenUsageEventPort } from "../dashboard-usage/service.js";
import { asBoundThreadPort } from "./bound.js";
import { typedUsageEvent } from "./envelope.js";
import type { UsageEventStore } from "./store.js";
import type { BoundThreadPort, CaptureCounts } from "./types.js";

function stillRunning(shouldContinue?: () => boolean): boolean {
  return shouldContinue ? shouldContinue() : true;
}

export async function captureBoundThreads(deps: {
  store: UsageEventStore;
  bound: BoundThreadPort | Iterable<string>;
  live: TokenUsageEventPort;
  threadIds: readonly string[];
  shouldContinue?: () => boolean;
}): Promise<CaptureCounts> {
  const { store, live, threadIds, shouldContinue } = deps;
  const bound = asBoundThreadPort(deps.bound);
  const counts: CaptureCounts = {
    inserted: 0,
    duplicate: 0,
    conflict: 0,
    malformed: 0,
    unbound: 0,
    liveUnavailable: 0,
  };
  threadLoop: for (const threadId of threadIds) {
    if (!stillRunning(shouldContinue)) break;
    if (!bound.isBound(threadId)) {
      counts.unbound += 1;
      continue;
    }
    let listed: readonly unknown[] | "unavailable";
    try {
      listed = await live.listUpdated(threadId);
    } catch {
      listed = "unavailable";
    }
    if (!stillRunning(shouldContinue)) break;
    if (listed === "unavailable") {
      counts.liveUnavailable += 1;
      continue;
    }
    for (const raw of listed) {
      if (!stillRunning(shouldContinue)) break threadLoop;
      const typed = typedUsageEvent(threadId, raw);
      if (!typed) {
        counts.malformed += 1;
        continue;
      }
      if (!stillRunning(shouldContinue)) break threadLoop;
      const written = store.ingest(typed);
      if (!written.ok) {
        counts.conflict += 1;
        continue;
      }
      if (written.value === "inserted") counts.inserted += 1;
      else counts.duplicate += 1;
    }
  }
  return counts;
}
