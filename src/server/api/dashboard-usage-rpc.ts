import type { ModelPriceTable } from "../runtime/dashboard-usage/pricing.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { SqlDatabase } from "../db/sql";
import { resolveRpcAccess } from "./auth";
import { createInternalRunStoreReads } from "../runtime/run-store";
import { createDashboardUsageReader, dashboardUsageCatalogFromSql } from "../runtime/dashboard-usage";
import { createUsageCollector } from "../runtime/usage-collector";

type EventsPort = Pick<BbPluginApi["sdk"]["threads"]["events"], "list">;

export const USAGE_COLLECTOR_POLL_MS = 60_000;
export const USAGE_CHANGED_CHANNEL = "usage-changed" as const;

/** Only usage events from the exact Agency-bound thread. Never fetch its transcript. */
export function createDashboardUsageEventPort(events: EventsPort) {
  return {
    async listUpdated(threadId: string): Promise<readonly unknown[] | "unavailable"> {
      try {
        const rows: unknown[] = [];
        let afterSeq: string | undefined;
        const signal = AbortSignal.timeout(10_000);
        for (let page = 0; page < 100; page += 1) {
          const chunk = await events.list({
            threadId,
            types: ["thread/tokenUsage/updated"],
            order: "asc",
            limit: "100",
            ...(afterSeq ? { afterSeq } : {}),
            signal,
          });
          if (chunk.some((row) => row.threadId !== threadId || row.type !== "thread/tokenUsage/updated")) {
            return "unavailable";
          }
          rows.push(...chunk);
          if (chunk.length < 100) return rows;
          const last = chunk[chunk.length - 1];
          const next = last ? String(last.seq) : null;
          if (!next || (afterSeq !== undefined && Number(next) <= Number(afterSeq))) return "unavailable";
          afterSeq = next;
        }
        return "unavailable";
      } catch {
        return "unavailable";
      }
    },
  };
}

export function listBoundAttemptThreadIds(db: SqlDatabase): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT thread_id AS threadId
       FROM agency_run_attempt
       WHERE thread_id IS NOT NULL AND length(thread_id) > 0
       ORDER BY thread_id`,
    )
    .all() as Array<{ threadId: string }>;
  return rows.map((row) => row.threadId);
}

export function createAttemptBoundThreadPort(db: SqlDatabase) {
  const exists = db.prepare(`SELECT 1 AS ok FROM agency_run_attempt WHERE thread_id = ? LIMIT 1`);
  return {
    isBound(threadId: string) {
      return Boolean(exists.get(threadId));
    },
  };
}

export function startUsageCollectorCapture(deps: {
  capture: (threadIds: readonly string[], shouldContinue: () => boolean) => Promise<unknown>;
  listThreadIds: () => readonly string[];
  intervalMs?: number;
  schedule?: (tick: () => void, intervalMs: number) => () => void;
}): { dispose: () => void; tick: () => Promise<void>; busy: () => boolean; shouldContinue: () => boolean } {
  let busy = false;
  let disposed = false;
  const shouldContinue = () => !disposed;
  const intervalMs = deps.intervalMs ?? USAGE_COLLECTOR_POLL_MS;
  const schedule =
    deps.schedule ??
    ((tick, ms) => {
      const handle = setInterval(tick, ms);
      return () => clearInterval(handle);
    });

  const tick = async () => {
    if (disposed || busy) return;
    busy = true;
    try {
      await deps.capture(deps.listThreadIds(), shouldContinue);
    } catch {
      // Capture already isolates per thread; this keeps a poll tick from throwing.
    } finally {
      busy = false;
    }
  };

  const cancel = schedule(() => {
    void tick();
  }, intervalMs);
  void tick();

  return {
    dispose() {
      disposed = true;
      cancel();
    },
    tick,
    busy: () => busy,
    shouldContinue,
  };
}

export function createDashboardUsageRpc(deps: { db: SqlDatabase; events: EventsPort; prices?: () => ModelPriceTable }) {
  const live = createDashboardUsageEventPort(deps.events);
  const collector = createUsageCollector({
    db: deps.db,
    bound: createAttemptBoundThreadPort(deps.db),
    live,
  });
  const reader = createDashboardUsageReader({
    reads: createInternalRunStoreReads(deps.db),
    catalog: dashboardUsageCatalogFromSql(deps.db),
    events: collector.events,
    prices: deps.prices,
  });
  return {
    collector,
    async listDashboardUsage(input: unknown) {
      const access = resolveRpcAccess(deps.db);
      if (!access.ok) return access;
      return reader.listDashboardUsage(access.value.ctx, input);
    },
  };
}

/** Union read path plus background capture of attempt-bound threads. Not a second runtime. */
export function attachDashboardUsageCollector(deps: {
  db: SqlDatabase;
  events: EventsPort;
  onUsageChanged?: () => void;
  prices?: () => ModelPriceTable;
}) {
  const { collector, listDashboardUsage } = createDashboardUsageRpc(deps);
  const poll = startUsageCollectorCapture({
    capture: async (threadIds, shouldContinue) => {
      const counts = await collector.capture(threadIds, { shouldContinue });
      if (counts.inserted > 0 && shouldContinue()) deps.onUsageChanged?.();
    },
    listThreadIds: () => listBoundAttemptThreadIds(deps.db),
  });
  return {
    handlers: { listDashboardUsage },
    dispose: poll.dispose,
    collector,
    poll,
  };
}
