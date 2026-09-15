import { z } from "zod";
import { bbProjectIdSchema, opaqueIdSchema } from "./ids";

export const dashboardUsageGrainSchema = z.literal("visible_epoch_peaks");
export const dashboardPeriodGrainSchema = z.literal("epoch_proven_day_deltas");

export const tokenUsageTotalsSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningOutputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  })
  .strict();

export const dashboardUsageKnownUnitsSchema = tokenUsageTotalsSchema.extend({
  unknown: z.literal(false),
  source: z.literal("thread/tokenUsage/updated.visible_epoch_peaks"),
});

export const dashboardUsageUnknownReasonSchema = z.enum([
  "empty",
  "no_thread",
  "unavailable",
  "malformed",
  "unsupported_usage_semantics",
]);

export const dashboardUsageUnknownUnitsSchema = z
  .object({
    unknown: z.literal(true),
    reason: dashboardUsageUnknownReasonSchema,
  })
  .strict();

export const dashboardUsageUnitsSchema = z.union([dashboardUsageKnownUnitsSchema, dashboardUsageUnknownUnitsSchema]);

export const dashboardDayHistoryReasonSchema = z.enum([
  "empty",
  "single_snapshot",
  "prefix_pruned",
  "epoch_reset",
  "unavailable",
  "malformed",
  "unsupported_usage_semantics",
  "page_limit",
]);

export const dashboardUsageCoverageSchema = z
  .object({
    jobCount: z.number().int().nonnegative(),
    attemptCount: z.number().int().nonnegative(),
    uniqueThreadCount: z.number().int().nonnegative(),
    attemptsWithoutThread: z.number().int().nonnegative(),
    threadsWithUsage: z.number().int().nonnegative(),
    threadsUnknown: z.number().int().nonnegative(),
    epochCount: z.number().int().nonnegative(),
    lifetimeIncomplete: z.boolean(),
    dayHistoryIncomplete: z.boolean(),
    dayHistoryReasons: z.array(dashboardDayHistoryReasonSchema),
    dayChart: z.enum(["omitted", "partial"]),
    resetObserved: z.boolean(),
  })
  .strict();

const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const dashboardUsageDaySchema = tokenUsageTotalsSchema.extend({
  date: calendarDateSchema,
  threadId: z.string().min(1),
  bbProjectId: z.string().min(1).nullable(),
  departmentId: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  modelSource: z.literal("snapshot").nullable(),
});

export const dashboardUsageRowSchema = z
  .object({
    attemptId: opaqueIdSchema,
    jobId: opaqueIdSchema,
    rootJobId: opaqueIdSchema,
    threadId: z.string().min(1).nullable(),
    attemptState: z.string().min(1),
    bbProjectId: z.string().min(1).nullable(),
    departmentId: z.string().min(1).nullable(),
    providerId: z.string().min(1).nullable(),
    model: z.string().min(1).nullable(),
    modelSource: z.literal("snapshot").nullable(),
    units: dashboardUsageUnitsSchema,
    sessionLatestTotal: tokenUsageTotalsSchema.nullable(),
    resetObserved: z.boolean(),
    costUsdCents: z.null(),
  })
  .strict();

export const listDashboardUsageInputSchema = z
  .object({
    bindingId: opaqueIdSchema.optional(),
    rootJobId: opaqueIdSchema.optional(),
    claimedBbProjectId: bbProjectIdSchema.optional(),
    departmentId: opaqueIdSchema.optional(),
    providerId: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    fromDate: calendarDateSchema.optional(),
    toDate: calendarDateSchema.optional(),
  })
  .strict();

export const dashboardAllTimeSchema = z
  .object({
    grain: dashboardUsageGrainSchema,
    totals: tokenUsageTotalsSchema.nullable(),
    incomplete: z.literal(true),
  })
  .strict();

export const dashboardPeriodSchema = z
  .object({
    grain: dashboardPeriodGrainSchema,
    available: z.boolean(),
    fromDate: calendarDateSchema.optional(),
    toDate: calendarDateSchema.optional(),
    days: z.array(dashboardUsageDaySchema),
  })
  .strict();

export const listDashboardUsageOutputSchema = z
  .object({
    grain: dashboardUsageGrainSchema,
    totals: tokenUsageTotalsSchema.nullable(),
    allTime: dashboardAllTimeSchema,
    period: dashboardPeriodSchema,
    costUsdCents: z.null(),
    coverage: dashboardUsageCoverageSchema,
    days: z.array(dashboardUsageDaySchema),
    rows: z.array(dashboardUsageRowSchema),
  })
  .strict();

export type TokenUsageTotals = z.infer<typeof tokenUsageTotalsSchema>;
export type DashboardUsageUnits = z.infer<typeof dashboardUsageUnitsSchema>;
export type DashboardUsageCoverage = z.infer<typeof dashboardUsageCoverageSchema>;
export type DashboardUsageDay = z.infer<typeof dashboardUsageDaySchema>;
export type DashboardUsageRow = z.infer<typeof dashboardUsageRowSchema>;
export type ListDashboardUsageInput = z.infer<typeof listDashboardUsageInputSchema>;
export type ListDashboardUsageOutput = z.infer<typeof listDashboardUsageOutputSchema>;
export type DashboardDayHistoryReason = z.infer<typeof dashboardDayHistoryReasonSchema>;
export type DashboardUsageUnknownReason = z.infer<typeof dashboardUsageUnknownReasonSchema>;
