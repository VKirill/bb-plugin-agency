import { fail, ok, type DomainResult } from "../../../domain/result.js";
import {
  listDashboardUsageInputSchema,
  listDashboardUsageOutputSchema,
  type DashboardDayHistoryReason,
  type DashboardUsageRow,
  type DashboardUsageUnits,
  type ListDashboardUsageInput,
  type ListDashboardUsageOutput,
  type TokenUsageTotals,
} from "../../../shared/contracts/dashboard-usage.js";
import type { Job } from "../../../shared/contracts/job.js";
import type { ProjectBinding } from "../../../shared/contracts/project-binding.js";
import type { InternalRunStoreReads } from "../run-store/types.js";
import type { ServiceContext } from "../../services/context.js";
import { assertBindingAccess } from "../../services/context.js";
import { filterDaysByPeriod, mergeAttributedDayDeltas, type AttributedDayDelta } from "./days.js";
import { foldClaudeThreadUsage } from "./epochs.js";
import { collectJobSubtree, resolveRowRootJobId } from "./subtree.js";
import { listJobsForBindings, listStoredBindings } from "../../api/catalog.js";
import type { SqlDatabase } from "../../db/sql.js";
import { addTotals, hasProvenUsageSemantics } from "./units.js";
import {
  DEFAULT_MODEL_PRICES,
  MODEL_PRICES_CHECKED_AT,
  estimateCostUsdCents,
  priceForModel,
  type ModelPriceTable,
} from "./pricing.js";

export function dashboardUsageCatalogFromSql(db: SqlDatabase): DashboardUsageCatalog {
  return {
    listJobs: (bindingIds) => listJobsForBindings(db, bindingIds),
    listBindings: () => listStoredBindings(db),
  };
}

/** Root `createDashboardUsageEventPort` implements this. Do not fetch transcripts. */
export type TokenUsageEventPort = {
  listUpdated(threadId: string): Promise<readonly unknown[] | "unavailable">;
};

export type DashboardUsageCatalog = {
  listJobs(bindingIds: readonly string[]): Job[];
  listBindings(): ProjectBinding[];
};

type AttemptDimensions = {
  bbProjectId: string | null;
  departmentId: string | null;
  agentId: string | null;
  providerId: string | null;
  model: string | null;
  modelSource: "snapshot" | null;
};

type ThreadFoldView = {
  units: DashboardUsageUnits;
  sessionLatestTotal: TokenUsageTotals | null;
  epochCount: number;
  days: Array<TokenUsageTotals & { date: string }>;
  reasons: DashboardDayHistoryReason[];
};

function uniqueReasons(values: readonly DashboardDayHistoryReason[]): DashboardDayHistoryReason[] {
  return [...new Set(values)];
}

function assignmentOf(prepared: readonly { threadId: string | null; dimensions: AttemptDimensions }[], threadId: string): AttemptDimensions {
  const row = prepared.find((item) => item.threadId === threadId);
  return (
    row?.dimensions ?? {
      bbProjectId: null,
      departmentId: null,
      agentId: null,
      providerId: null,
      model: null,
      modelSource: null,
    }
  );
}

export function createDashboardUsageReader(deps: {
  reads: Pick<InternalRunStoreReads, "listAttempts" | "getSnapshot">;
  catalog: DashboardUsageCatalog;
  events: TokenUsageEventPort;
  prices?: () => ModelPriceTable;
}) {
  return {
    async listDashboardUsage(ctx: ServiceContext, raw: unknown): Promise<DomainResult<ListDashboardUsageOutput>> {
      const parsed = listDashboardUsageInputSchema.safeParse(raw ?? {});
      if (!parsed.success) return fail("invalid_command", parsed.error.message);
      const input: ListDashboardUsageInput = parsed.data;

      let bindingIds = [...ctx.allowedBindingIds];
      if (input.bindingId) {
        const access = assertBindingAccess(ctx, input.bindingId);
        if (!access.ok) return access;
        bindingIds = [input.bindingId];
      }
      const bindings = deps.catalog
        .listBindings()
        .filter((binding) => bindingIds.includes(binding.id))
        .filter((binding) => !input.claimedBbProjectId || binding.bbProjectId === input.claimedBbProjectId);
      const scopedBindingIds = bindings.map((binding) => binding.id);
      const bindingById = new Map(bindings.map((binding) => [binding.id, binding]));

      const scopedJobs = deps.catalog.listJobs(scopedBindingIds);
      if (input.rootJobId && !scopedJobs.some((job) => job.id === input.rootJobId)) {
        return fail("not_found", `job ${input.rootJobId} not found in trusted scope`);
      }
      const treeJobs = collectJobSubtree(scopedJobs, input.rootJobId);

      type PreparedAttempt = {
        attemptId: string;
        jobId: string;
        attemptState: string;
        threadId: string | null;
        dimensions: AttemptDimensions;
      };
      const prepared: PreparedAttempt[] = [];
      for (const job of treeJobs) {
        const listed = deps.reads.listAttempts(ctx, job.id);
        if (!listed.ok) return listed;
        for (const attempt of listed.value) {
          if (input.attemptsFrom && attempt.createdAt < input.attemptsFrom) continue;
          const snapshot = deps.reads.getSnapshot(ctx, attempt.snapshotId);
          const dimensions: AttemptDimensions = snapshot.ok
            ? {
                bbProjectId: snapshot.value.snapshot.binding.bbProjectId,
                departmentId: snapshot.value.snapshot.job.departmentId,
                agentId: snapshot.value.snapshot.agentVersion.agentId,
                providerId: snapshot.value.snapshot.agentVersion.providerId,
                model: snapshot.value.snapshot.agentVersion.model,
                modelSource: "snapshot",
              }
            : {
                bbProjectId: bindingById.get(job.bindingId)?.bbProjectId ?? null,
                departmentId: job.departmentId,
                agentId: job.assignedAgentId,
                providerId: null,
                model: null,
                modelSource: null,
              };
          if (input.departmentId && dimensions.departmentId !== input.departmentId) continue;
          if (input.agentId && dimensions.agentId !== input.agentId) continue;
          if (input.providerId && dimensions.providerId !== input.providerId) continue;
          if (input.model && dimensions.model !== input.model) continue;
          prepared.push({
            attemptId: attempt.attemptId,
            jobId: attempt.jobId,
            attemptState: attempt.state,
            threadId: attempt.threadId,
            dimensions,
          });
        }
      }

      const uniqueThreadIds = [...new Set(prepared.map((row) => row.threadId).filter((id): id is string => Boolean(id)))];
      const foldByThread = new Map<string, ThreadFoldView>();
      for (const threadId of uniqueThreadIds) {
        const providers = [
          ...new Set(prepared.filter((row) => row.threadId === threadId).map((row) => row.dimensions.providerId)),
        ];
        const proven = providers.length > 0 && providers.every((id) => hasProvenUsageSemantics(id));
        if (!proven) {
          foldByThread.set(threadId, {
            units: { unknown: true, reason: "unsupported_usage_semantics" },
            sessionLatestTotal: null,
            epochCount: 0,
            days: [],
            reasons: ["unsupported_usage_semantics"],
          });
          continue;
        }
        const listed = await deps.events.listUpdated(threadId);
        if (listed === "unavailable") {
          foldByThread.set(threadId, {
            units: { unknown: true, reason: "unavailable" },
            sessionLatestTotal: null,
            epochCount: 0,
            days: [],
            reasons: ["unavailable"],
          });
          continue;
        }
        const fold = foldClaudeThreadUsage(listed);
        if (fold.unknown) {
          foldByThread.set(threadId, {
            units: { unknown: true, reason: fold.reason },
            sessionLatestTotal: null,
            epochCount: 0,
            days: [],
            reasons: fold.reasons,
          });
          continue;
        }
        foldByThread.set(threadId, {
          units: {
            unknown: false,
            source: "thread/tokenUsage/updated.visible_epoch_peaks",
            ...fold.peaks,
          },
          sessionLatestTotal: fold.sessionLatestTotal,
          epochCount: fold.epochCount,
          days: fold.days,
          reasons: fold.reasons,
        });
      }

      const prices = deps.prices?.() ?? DEFAULT_MODEL_PRICES;
      const costByThread = new Map<string, number | null>();
      const unpricedModels = new Set<string>();
      for (const threadId of uniqueThreadIds) {
        const units = foldByThread.get(threadId)!.units;
        if (units.unknown) {
          costByThread.set(threadId, null);
          continue;
        }
        const model = assignmentOf(prepared, threadId).model;
        const modelPrice = priceForModel(model, prices);
        if (!modelPrice && model) unpricedModels.add(model);
        costByThread.set(threadId, modelPrice ? estimateCostUsdCents(units, modelPrice) : null);
      }
      const pricedCosts = [...costByThread.values()].filter((value): value is number => value !== null);
      const knownThreads = [...costByThread.keys()].filter((id) => !foldByThread.get(id)!.units.unknown);

      const rows: DashboardUsageRow[] = prepared.map((row) => {
        const fold = row.threadId ? foldByThread.get(row.threadId) : undefined;
        return {
          attemptId: row.attemptId,
          jobId: row.jobId,
          rootJobId: resolveRowRootJobId(treeJobs, row.jobId, input.rootJobId),
          threadId: row.threadId,
          attemptState: row.attemptState,
          bbProjectId: row.dimensions.bbProjectId,
          departmentId: row.dimensions.departmentId,
          providerId: row.dimensions.providerId,
          model: row.dimensions.model,
          modelSource: row.dimensions.modelSource,
          units: fold?.units ?? { unknown: true, reason: "no_thread" },
          sessionLatestTotal: fold?.sessionLatestTotal ?? null,
          resetObserved: fold?.reasons.includes("epoch_reset") ?? false,
          costUsdCents: row.threadId ? (costByThread.get(row.threadId) ?? null) : null,
        };
      });

      const threadViews = uniqueThreadIds.map((id) => foldByThread.get(id)!);
      const attributedDays: AttributedDayDelta[] = uniqueThreadIds.flatMap((threadId) => {
        const view = foldByThread.get(threadId)!;
        const assigned = assignmentOf(prepared, threadId);
        return view.days.map((day) => ({
          ...day,
          threadId,
          bbProjectId: assigned.bbProjectId,
          departmentId: assigned.departmentId,
          model: assigned.model,
          modelSource: assigned.modelSource,
        }));
      });
      const allTimeDays = mergeAttributedDayDeltas(attributedDays);
      const days = filterDaysByPeriod(allTimeDays, input.fromDate, input.toDate);
      const reasons = uniqueReasons(threadViews.flatMap((view) => view.reasons));

      let totals: TokenUsageTotals | null = null;
      for (const view of threadViews) {
        if (view.units.unknown) continue;
        const next = {
          inputTokens: view.units.inputTokens,
          cachedInputTokens: view.units.cachedInputTokens,
          outputTokens: view.units.outputTokens,
          reasoningOutputTokens: view.units.reasoningOutputTokens,
          totalTokens: view.units.totalTokens,
        };
        totals = totals ? addTotals(totals, next) : next;
      }

      const resetObserved = reasons.includes("epoch_reset");
      const output: ListDashboardUsageOutput = {
        grain: "visible_epoch_peaks",
        totals,
        allTime: {
          grain: "visible_epoch_peaks",
          totals,
          incomplete: true,
        },
        period: {
          grain: "epoch_proven_day_deltas",
          available: days.length > 0,
          ...(input.fromDate ? { fromDate: input.fromDate } : {}),
          ...(input.toDate ? { toDate: input.toDate } : {}),
          days,
        },
        costUsdCents: pricedCosts.length > 0 ? Math.round(pricedCosts.reduce((sum, value) => sum + value, 0) * 100) / 100 : null,
        cost: {
          basis: "api_list_price_without_cache_writes",
          pricesCheckedAt: MODEL_PRICES_CHECKED_AT,
          pricedThreads: pricedCosts.length,
          unpricedThreads: knownThreads.length - pricedCosts.length,
          unpricedModels: [...unpricedModels].sort(),
        },
        coverage: {
          jobCount: treeJobs.length,
          attemptCount: prepared.length,
          uniqueThreadCount: uniqueThreadIds.length,
          attemptsWithoutThread: prepared.filter((row) => !row.threadId).length,
          threadsWithUsage: threadViews.filter((view) => !view.units.unknown).length,
          threadsUnknown: threadViews.filter((view) => view.units.unknown).length,
          epochCount: threadViews.reduce((sum, view) => sum + view.epochCount, 0),
          lifetimeIncomplete: true,
          dayHistoryIncomplete: reasons.length > 0 || allTimeDays.length === 0,
          dayHistoryReasons: reasons,
          dayChart: days.length === 0 ? "omitted" : "partial",
          resetObserved,
        },
        days,
        rows,
      };
      return ok(listDashboardUsageOutputSchema.parse(output));
    },
  };
}
