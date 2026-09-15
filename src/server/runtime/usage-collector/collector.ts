import type { TokenUsageEventPort } from "../dashboard-usage/service.js";
import type { SqlDatabase } from "../../db/sql.js";
import { asBoundThreadPort } from "./bound.js";
import { captureBoundThreads } from "./capture.js";
import { createUsageEventStore } from "./store.js";
import { createUnionUsageEventPort } from "./union.js";
import type { BoundThreadPort } from "./types.js";

export function createUsageCollector(deps: {
  db: SqlDatabase;
  bound: BoundThreadPort | Iterable<string>;
  live: TokenUsageEventPort;
}) {
  const bound = asBoundThreadPort(deps.bound);
  const store = createUsageEventStore(deps.db);
  return {
    store,
    capture(threadIds: readonly string[], options?: { shouldContinue?: () => boolean }) {
      return captureBoundThreads({
        store,
        bound,
        live: deps.live,
        threadIds,
        shouldContinue: options?.shouldContinue,
      });
    },
    events: createUnionUsageEventPort({ live: deps.live, store, bound }),
  };
}
