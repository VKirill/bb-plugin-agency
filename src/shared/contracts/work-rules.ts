import { z } from "zod";
import { requestIdSchema } from "./ids";

/**
 * Work rules: thresholds and policies a team may tune. Guarantees of result
 * integrity (hash-verified review, acceptance of the current version, no self
 * review) are not rules and cannot be switched off.
 *
 * Inherited keys: an agency value is the default, a department may override it.
 * Limits (budget, concurrency) belong to their own scope and do not inherit:
 * the agency limit, a department limit and an employee limit apply together.
 */

/** Same ladder as the profile: each provider offers its own subset in the picker. */
const reasoningSchema = z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]);
const serviceTierSchema = z.enum(["default", "fast"]);

export const workRulesSchema = z
  .object({
    reworkLimit: z.number().int().min(1).max(10),
    minorDefectsWithoutRound: z.boolean(),
    /** An executor's hand-in creates and queues an independent review subtask by itself. */
    autoReview: z.boolean(),
    /** Once a day after nightlyRecheckHour a reviewer rechecks the versions accepted since the previous recheck. */
    nightlyRecheck: z.boolean(),
    /** Hour of the BB server's clock, 0–23. */
    nightlyRecheckHour: z.number().int().min(0).max(23),
    /** Launches run with full permissions and without the CLI sandbox. Off by default. */
    runWithoutSandbox: z.boolean(),
    watchQuietMinutes: z.number().int().min(1).max(240),
    watchStallMinutes: z.number().int().min(2).max(720),
    watchStartMinutes: z.number().int().min(1).max(120),
    watchErrorMinutes: z.number().int().min(1).max(120),
    watchCeilingHours: z.number().min(0.5).max(24),
    completionReminders: z.number().int().min(0).max(5),
    dueReminderHours: z.number().int().min(0).max(336),
    /** A main job waiting for a decision this long is escalated to the parent department; 0 turns it off. */
    escalateAfterHours: z.number().int().min(0).max(720),
    budgetWarnPercent: z.number().int().min(10).max(99),
    /** Month budget in USD at API list prices; null means no budget. */
    budgetMonthlyUsd: z.number().min(0).max(1_000_000).nullable(),
    /** Running attempts at once in this scope; null means no limit. */
    concurrencyLimit: z.number().int().min(1).max(100).nullable(),
    /** Any provider connected in BB: a new employee of this role type starts on it. */
    defaultProviderLead: z.string().trim().min(1).max(80),
    defaultProviderExecutor: z.string().trim().min(1).max(80),
    defaultProviderReviewer: z.string().trim().min(1).max(80),
    defaultModelLead: z.string().trim().min(1).max(120),
    defaultModelExecutor: z.string().trim().min(1).max(120),
    defaultModelReviewer: z.string().trim().min(1).max(120),
    defaultReasoningLead: reasoningSchema,
    defaultReasoningExecutor: reasoningSchema,
    defaultReasoningReviewer: reasoningSchema,
    /** Null: the provider has no service tiers or the default tier is used. */
    defaultServiceTierLead: serviceTierSchema.nullable(),
    defaultServiceTierExecutor: serviceTierSchema.nullable(),
    defaultServiceTierReviewer: serviceTierSchema.nullable(),
  })
  .strict();

export type WorkRules = z.infer<typeof workRulesSchema>;
export type WorkRuleKey = keyof WorkRules;

export const DEFAULT_WORK_RULES: WorkRules = {
  reworkLimit: 3,
  minorDefectsWithoutRound: false,
  autoReview: false,
  nightlyRecheck: false,
  nightlyRecheckHour: 3,
  runWithoutSandbox: false,
  watchQuietMinutes: 10,
  watchStallMinutes: 30,
  watchStartMinutes: 10,
  watchErrorMinutes: 5,
  watchCeilingHours: 2,
  completionReminders: 2,
  dueReminderHours: 24,
  escalateAfterHours: 24,
  budgetWarnPercent: 80,
  budgetMonthlyUsd: null,
  concurrencyLimit: null,
  defaultProviderLead: "claude-code",
  defaultProviderExecutor: "claude-code",
  defaultProviderReviewer: "claude-code",
  defaultModelLead: "claude-opus-5[1m]",
  defaultModelExecutor: "claude-sonnet-5",
  defaultModelReviewer: "claude-opus-5[1m]",
  defaultReasoningLead: "high",
  defaultReasoningExecutor: "medium",
  defaultReasoningReviewer: "high",
  defaultServiceTierLead: null,
  defaultServiceTierExecutor: null,
  defaultServiceTierReviewer: null,
};

/** Keys a department inherits from the agency and may override. */
export const INHERITED_RULE_KEYS = [
  "reworkLimit",
  "minorDefectsWithoutRound",
  "autoReview",
  "nightlyRecheck",
  "nightlyRecheckHour",
  "runWithoutSandbox",
  "watchQuietMinutes",
  "watchStallMinutes",
  "watchStartMinutes",
  "watchErrorMinutes",
  "watchCeilingHours",
  "completionReminders",
  "dueReminderHours",
  "escalateAfterHours",
  "budgetWarnPercent",
] as const satisfies readonly WorkRuleKey[];

/**
 * Inherited keys an employee may override for their own launches. «Проверка создаётся
 * автоматически» belongs here too: a scout who only collects material for a colleague
 * has nothing for a reviewer to check.
 */
export const AGENT_OVERRIDE_RULE_KEYS = ["runWithoutSandbox", "autoReview"] as const satisfies readonly WorkRuleKey[];

/**
 * Inherited keys a machine may override for every launch on it, e.g. a Linux server
 * whose sandbox does not let Agency commands through. An employee's own value wins.
 */
export const HOST_OVERRIDE_RULE_KEYS = ["runWithoutSandbox"] as const satisfies readonly WorkRuleKey[];

/** Limits of the scope itself. */
export const LIMIT_RULE_KEYS = ["budgetMonthlyUsd", "concurrencyLimit"] as const satisfies readonly WorkRuleKey[];

export const AGENCY_ONLY_RULE_KEYS = [
  "defaultProviderLead",
  "defaultProviderExecutor",
  "defaultProviderReviewer",
  "defaultModelLead",
  "defaultModelExecutor",
  "defaultModelReviewer",
  "defaultReasoningLead",
  "defaultReasoningExecutor",
  "defaultReasoningReviewer",
  "defaultServiceTierLead",
  "defaultServiceTierExecutor",
  "defaultServiceTierReviewer",
] as const satisfies readonly WorkRuleKey[];

export const workRulesScopeSchema = z.union([
  z.literal("agency"),
  z.string().regex(/^department:[A-Za-z0-9_-]{3,80}$/),
  z.string().regex(/^agent:[A-Za-z0-9_-]{3,80}$/),
  z.string().regex(/^host:[A-Za-z0-9_-]{3,80}$/),
]);

export type WorkRulesScope = z.infer<typeof workRulesScopeSchema>;

export function allowedRuleKeys(scope: string): readonly WorkRuleKey[] {
  if (scope === "agency") return [...INHERITED_RULE_KEYS, ...LIMIT_RULE_KEYS, ...AGENCY_ONLY_RULE_KEYS];
  if (scope.startsWith("department:")) return [...INHERITED_RULE_KEYS, ...LIMIT_RULE_KEYS];
  if (scope.startsWith("host:")) return [...HOST_OVERRIDE_RULE_KEYS];
  return [...LIMIT_RULE_KEYS, ...AGENT_OVERRIDE_RULE_KEYS];
}

export const storedWorkRulesSchema = workRulesSchema.partial().strict();
export type StoredWorkRules = z.infer<typeof storedWorkRulesSchema>;

export const saveWorkRulesCommandSchema = z
  .object({
    requestId: requestIdSchema,
    scope: workRulesScopeSchema,
    /** 0 for a scope that has never been saved. */
    expectedRevision: z.number().int().min(0),
    /** The full stored set for the scope: a missing key returns to the inherited or default value. */
    rules: storedWorkRulesSchema,
  })
  .strict();

export type SaveWorkRulesCommand = z.infer<typeof saveWorkRulesCommandSchema>;

export const ruleSourceSchema = z.enum(["default", "agency", "department", "host", "agent"]);
export type RuleSource = z.infer<typeof ruleSourceSchema>;

export const workRulesViewSchema = z
  .object({
    scope: workRulesScopeSchema,
    revision: z.number().int().min(0),
    stored: storedWorkRulesSchema,
    effective: workRulesSchema,
    sources: z.record(z.string(), ruleSourceSchema),
  })
  .strict();

export type WorkRulesView = z.infer<typeof workRulesViewSchema>;
