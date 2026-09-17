import { fail, ok, type DomainResult } from "../../domain";
import type { Job } from "../../shared/contracts/job";
import type { SqlDatabase } from "../db/sql";
import { agencyLanguage } from "../i18n/language";
import { workRulesView } from "./work-rules";

/** Attempt states that hold a launch slot: a thread is starting or working. */
export const SLOT_ATTEMPT_STATES = ["prepared", "launching", "running"] as const;

export type LimitScope = { kind: "agency" } | { kind: "department"; id: string; name: string } | { kind: "agent"; id: string; name: string };

export type SpendFilter = { departmentId?: string; agentId?: string; attemptsFrom: string };

export type LimitDeps = {
  db: SqlDatabase;
  /** Estimated spend in US cents of attempts started since `attemptsFrom`; null when nothing is priced. */
  spend: (filter: SpendFilter) => Promise<number | null>;
  now?: () => Date;
};

export type BudgetStatus = {
  scope: string;
  label: string;
  monthStart: string;
  limitUsd: number;
  spendUsdCents: number;
  percent: number;
  warnPercent: number;
};

export type LaunchLimitCheck = {
  /** Warnings the owner should see before and at launch; the launch still goes. */
  warnings: string[];
};

/** Start of the current calendar month, UTC. */
export function monthStartUtc(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function nameOf(db: SqlDatabase, table: "agency_department" | "agency_agent", id: string): string {
  const row = db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id) as { name: string } | undefined;
  return row?.name ?? id;
}

export function scopesForJob(db: SqlDatabase, job: Pick<Job, "departmentId" | "assignedAgentId">): LimitScope[] {
  const scopes: LimitScope[] = [{ kind: "agency" }, { kind: "department", id: job.departmentId, name: nameOf(db, "agency_department", job.departmentId) }];
  if (job.assignedAgentId) scopes.push({ kind: "agent", id: job.assignedAgentId, name: nameOf(db, "agency_agent", job.assignedAgentId) });
  return scopes;
}

function scopeKey(scope: LimitScope): string {
  return scope.kind === "agency" ? "agency" : `${scope.kind}:${scope.id}`;
}

function scopeLabel(scope: LimitScope, en: boolean): string {
  if (scope.kind === "agency") return en ? "the agency" : "Агентства";
  if (scope.kind === "department") return en ? `department «${scope.name}»` : `отдела «${scope.name}»`;
  return en ? `employee ${scope.name}` : `сотрудника ${scope.name}`;
}

/** Attempts holding a launch slot in a scope; the job being launched is not counted against itself. */
export function liveLaunchCount(db: SqlDatabase, scope: LimitScope, excludeJobId = ""): number {
  const states = SLOT_ATTEMPT_STATES.map(() => "?").join(", ");
  const base = `SELECT COUNT(*) AS n FROM agency_run_attempt a JOIN agency_job j ON j.id = a.job_id WHERE a.state IN (${states}) AND a.job_id != ?`;
  const row =
    scope.kind === "agency"
      ? db.prepare(base).get(...SLOT_ATTEMPT_STATES, excludeJobId)
      : scope.kind === "department"
        ? db.prepare(`${base} AND j.department_id = ?`).get(...SLOT_ATTEMPT_STATES, excludeJobId, scope.id)
        : db.prepare(`${base} AND j.assigned_agent_id = ?`).get(...SLOT_ATTEMPT_STATES, excludeJobId, scope.id);
  return (row as { n: number }).n;
}

function limitsOf(db: SqlDatabase, scope: LimitScope, job: Pick<Job, "departmentId">) {
  const own = workRulesView(db, scopeKey(scope)).effective;
  // The warning threshold is inherited: an employee works by the department's.
  const warnPercent = scope.kind === "agent" ? workRulesView(db, `department:${job.departmentId}`).effective.budgetWarnPercent : own.budgetWarnPercent;
  return { budgetMonthlyUsd: own.budgetMonthlyUsd, concurrencyLimit: own.concurrencyLimit, warnPercent };
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function budgetOf(deps: LimitDeps, scope: LimitScope, job: Pick<Job, "departmentId">, monthStart: string): Promise<BudgetStatus | null> {
  const limits = limitsOf(deps.db, scope, job);
  if (limits.budgetMonthlyUsd === null) return null;
  const spend =
    (await deps.spend({
      attemptsFrom: monthStart,
      ...(scope.kind === "department" ? { departmentId: scope.id } : scope.kind === "agent" ? { agentId: scope.id } : {}),
    })) ?? 0;
  const limitCents = limits.budgetMonthlyUsd * 100;
  return {
    scope: scopeKey(scope),
    label: scopeLabel(scope, false),
    monthStart,
    limitUsd: limits.budgetMonthlyUsd,
    spendUsdCents: spend,
    percent: limitCents > 0 ? Math.round((spend / limitCents) * 100) : 100,
    warnPercent: limits.warnPercent,
  };
}

/**
 * Limits a launch must respect: concurrent launches and the monthly budget of
 * the agency, the job's department and its employee. The strictest wins. A
 * refusal names the limit, the numbers and where to change it.
 */
export async function checkLaunchLimits(deps: LimitDeps, job: Pick<Job, "id" | "departmentId" | "assignedAgentId">): Promise<DomainResult<LaunchLimitCheck>> {
  const en = agencyLanguage() === "en";
  const now = deps.now?.() ?? new Date();
  const monthStart = monthStartUtc(now);
  const warnings: string[] = [];
  for (const scope of scopesForJob(deps.db, job)) {
    const limits = limitsOf(deps.db, scope, job);
    if (limits.concurrencyLimit !== null) {
      const live = liveLaunchCount(deps.db, scope, job.id);
      if (live >= limits.concurrencyLimit) {
        return fail(
          "concurrency_limit_reached",
          en
            ? `${live} launches of ${scopeLabel(scope, true)} are already working; the limit is ${limits.concurrencyLimit}. Put the job in the launch queue — it starts when a slot frees — or raise the limit in the work rules.`
            : `Уже работают запусков ${scopeLabel(scope, false)}: ${live}, лимит ${limits.concurrencyLimit}. Поставьте задачу в очередь запуска — она стартует, когда освободится слот, — или поднимите лимит в «Правила работы».`,
        );
      }
    }
    const budget = await budgetOf(deps, scope, job, monthStart);
    if (!budget) continue;
    if (budget.spendUsdCents >= budget.limitUsd * 100) {
      return fail(
        "budget_exhausted",
        en
          ? `The monthly budget of ${scopeLabel(scope, true)} is spent: ${money(budget.spendUsdCents)} of $${budget.limitUsd}. Raise it in the work rules or wait for the next month.`
          : `Бюджет ${scopeLabel(scope, false)} на месяц израсходован: ${money(budget.spendUsdCents)} из $${budget.limitUsd}. Поднимите бюджет в «Правила работы» или дождитесь нового месяца.`,
      );
    }
    if (budget.percent >= budget.warnPercent) {
      warnings.push(
        en
          ? `Budget of ${scopeLabel(scope, true)}: ${money(budget.spendUsdCents)} of $${budget.limitUsd} spent this month (${budget.percent}%).`
          : `Бюджет ${scopeLabel(scope, false)}: израсходовано ${money(budget.spendUsdCents)} из $${budget.limitUsd} за месяц (${budget.percent}%).`,
      );
    }
  }
  return ok({ warnings });
}

/** Every scope with a monthly budget and its spend this month. */
export async function listBudgets(deps: LimitDeps): Promise<BudgetStatus[]> {
  const now = deps.now?.() ?? new Date();
  const monthStart = monthStartUtc(now);
  const rows = deps.db.prepare(`SELECT scope FROM agency_work_rules ORDER BY scope`).all() as { scope: string }[];
  const out: BudgetStatus[] = [];
  for (const { scope: key } of rows) {
    const [kind, id] = key.includes(":") ? (key.split(":", 2) as [string, string]) : [key, ""];
    const scope: LimitScope | null =
      kind === "agency"
        ? { kind: "agency" }
        : kind === "department"
          ? { kind: "department", id, name: nameOf(deps.db, "agency_department", id) }
          : kind === "agent"
            ? { kind: "agent", id, name: nameOf(deps.db, "agency_agent", id) }
            : null;
    if (!scope) continue;
    const departmentId =
      scope.kind === "department"
        ? scope.id
        : scope.kind === "agent"
          ? ((deps.db.prepare(`SELECT department_id FROM agency_membership WHERE agent_id = ? ORDER BY rowid LIMIT 1`).get(scope.id) as { department_id: string } | undefined)?.department_id ?? "")
          : "";
    const status = await budgetOf(deps, scope, { departmentId }, monthStart);
    if (status) out.push(status);
  }
  return out;
}
