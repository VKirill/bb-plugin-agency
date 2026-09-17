import { fail, ok, type DomainResult } from "../../domain";
import type { SqlDatabase } from "../db/sql";
import type { DispatcherDeps } from "../dispatcher/engine.js";
import type { ServiceContext } from "../services/context.js";
import { assertCronRule, previewOccurrences } from "./cron/planner.js";
import { CronPlannerError, type CronMisfire } from "./cron/types.js";
import { tickCronIntoInbox } from "./durable-inbox.js";

/**
 * Schedules of rules on a cron source. The schedule belongs to the rule (all its
 * versions); occurrences are planned per rule version, so saving a new version
 * starts a fresh plan and the misfire policy decides what a gap means.
 */

export const RULE_SCHEDULE_MIGRATION = `CREATE TABLE agency_rule_schedule (
    rule_id TEXT PRIMARY KEY,
    expression TEXT NOT NULL,
    timezone TEXT NOT NULL,
    misfire TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

export type RuleSchedule = { ruleId: string; expression: string; timezone: string; misfire: CronMisfire };

const CRON_MESSAGES: Record<string, string> = {
  cron_expression_invalid: "Расписание не разобрано: нужно пять полей cron — минута, час, день месяца, месяц, день недели. Например «0 9 * * 1» — по понедельникам в 9:00.",
  cron_timezone_not_iana: "Часовой пояс не найден: укажите название вида Europe/Madrid.",
  cron_misfire_invalid: "Неизвестная политика пропусков.",
};

function validate(input: Pick<RuleSchedule, "expression" | "timezone" | "misfire">): DomainResult<true> {
  try {
    assertCronRule({ ruleVersionId: "validate", topic: "validate", expression: input.expression, timezone: input.timezone, misfire: input.misfire });
    return ok(true);
  } catch (error) {
    const code = error instanceof CronPlannerError ? error.code : "cron_expression_invalid";
    return fail(code, CRON_MESSAGES[code] ?? code);
  }
}

export function saveRuleSchedule(db: SqlDatabase, input: RuleSchedule, now: string): DomainResult<RuleSchedule> {
  const expression = input.expression.trim().replace(/\s+/g, " ");
  const checked = validate({ ...input, expression });
  if (!checked.ok) return checked;
  db.prepare(
    `INSERT INTO agency_rule_schedule (rule_id, expression, timezone, misfire, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(rule_id) DO UPDATE SET expression = excluded.expression, timezone = excluded.timezone, misfire = excluded.misfire, updated_at = excluded.updated_at`,
  ).run(input.ruleId, expression, input.timezone, input.misfire, now);
  return ok({ ...input, expression });
}

export function listRuleSchedules(db: SqlDatabase): RuleSchedule[] {
  return (db.prepare(`SELECT rule_id, expression, timezone, misfire FROM agency_rule_schedule ORDER BY rule_id`).all() as {
    rule_id: string;
    expression: string;
    timezone: string;
    misfire: CronMisfire;
  }[]).map((row) => ({ ruleId: row.rule_id, expression: row.expression, timezone: row.timezone, misfire: row.misfire }));
}

/** The next runs of a schedule, for the form preview. */
export function previewSchedule(input: { expression: string; timezone: string; count?: number }, nowUtc: string): DomainResult<string[]> {
  const rule = { ruleVersionId: "preview", topic: "preview", expression: input.expression.trim().replace(/\s+/g, " "), timezone: input.timezone, misfire: "skip" as const };
  const checked = validate(rule);
  if (!checked.ok) return checked;
  return ok(previewOccurrences(rule, { fromUtc: nowUtc, count: Math.min(input.count ?? 3, 10) }).map((slot) => slot.scheduledAtUtc));
}

/** Plans due occurrences of every enabled scheduled rule on enabled cron sources into the Inbox. */
export function tickSchedules(deps: DispatcherDeps, ctx: ServiceContext, nowUtc: string): { emitted: number; errors: string[] } {
  const schedules = new Map(listRuleSchedules(deps.db).map((row) => [row.ruleId, row]));
  if (schedules.size === 0) return { emitted: 0, errors: [] };
  const sources = deps.db.prepare(`SELECT id, project_id FROM agency_event_source WHERE kind = 'cron' AND enabled = 1`).all() as { id: string; project_id: string }[];
  let emitted = 0;
  const errors: string[] = [];
  for (const source of sources) {
    const rules = (deps.db
      .prepare(
        `SELECT r.id, r.rule_id, r.topic FROM agency_rule_version r
         WHERE r.source_id = ? AND r.enabled = 1 AND r.mode != 'disabled'
           AND r.version = (SELECT MAX(version) FROM agency_rule_version latest WHERE latest.rule_id = r.rule_id)`,
      )
      .all(source.id) as { id: string; rule_id: string; topic: string }[])
      .filter((row) => schedules.has(row.rule_id))
      .map((row) => {
        const schedule = schedules.get(row.rule_id)!;
        return { ruleVersionId: row.id, expression: schedule.expression, timezone: schedule.timezone, topic: row.topic, misfire: schedule.misfire };
      });
    if (!rules.length) continue;
    try {
      const items = tickCronIntoInbox(deps, ctx, { sourceId: source.id, bbProjectId: source.project_id, rules, nowUtc });
      emitted += items.filter((item) => item.state === "emitted" && !item.duplicate).length;
    } catch (error) {
      errors.push(`${source.id}: ${error instanceof CronPlannerError ? error.code : String(error)}`);
    }
  }
  return { emitted, errors };
}
