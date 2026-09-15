import type { TokenUsageEventPort } from "../dashboard-usage/service.js";
import { asBoundThreadPort } from "./bound.js";
import type { UsageEventStore } from "./store.js";
import type { BoundThreadPort } from "./types.js";

function eventIdOf(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const id = (raw as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function createUnionUsageEventPort(deps: {
  live: TokenUsageEventPort;
  store: UsageEventStore;
  bound: BoundThreadPort | Iterable<string>;
}): TokenUsageEventPort {
  const bound = asBoundThreadPort(deps.bound);
  return {
    async listUpdated(threadId: string) {
      if (!bound.isBound(threadId)) return [];
      const durable = deps.store.listEnvelopes(threadId);
      let live: readonly unknown[] | "unavailable";
      try {
        live = await deps.live.listUpdated(threadId);
      } catch {
        live = "unavailable";
      }
      if (live === "unavailable") return durable.length > 0 ? durable : "unavailable";
      const seen = new Set<string>();
      const merged: unknown[] = [];
      for (const row of durable) {
        const id = eventIdOf(row);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        merged.push(row);
      }
      for (const row of live) {
        const id = eventIdOf(row);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        merged.push(row);
      }
      return merged;
    },
  };
}
