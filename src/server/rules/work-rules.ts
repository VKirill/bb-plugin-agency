import {
  AGENCY_ONLY_RULE_KEYS,
  DEFAULT_WORK_RULES,
  INHERITED_RULE_KEYS,
  LIMIT_RULE_KEYS,
  allowedRuleKeys,
  storedWorkRulesSchema,
  workRulesSchema,
  type RuleSource,
  type StoredWorkRules,
  type WorkRuleKey,
  type WorkRules,
  type WorkRulesView,
} from "../../shared/contracts/work-rules";
import type { SqlDatabase } from "../db/sql";

export const WORK_RULES_MIGRATION = `CREATE TABLE agency_work_rules (
    scope TEXT PRIMARY KEY,
    rules_json TEXT NOT NULL,
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`;

export function readStoredRules(db: SqlDatabase, scope: string): { rules: StoredWorkRules; revision: number } {
  const row = db.prepare(`SELECT rules_json, revision FROM agency_work_rules WHERE scope = ?`).get(scope) as
    | { rules_json: string; revision: number }
    | undefined;
  if (!row) return { rules: {}, revision: 0 };
  const parsed = storedWorkRulesSchema.safeParse(JSON.parse(row.rules_json));
  return { rules: parsed.success ? parsed.data : {}, revision: row.revision };
}

export function writeStoredRules(db: SqlDatabase, scope: string, rules: StoredWorkRules, revision: number, now: string): void {
  db.prepare(
    `INSERT INTO agency_work_rules (scope, rules_json, revision, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET rules_json = excluded.rules_json, revision = excluded.revision, updated_at = excluded.updated_at`,
  ).run(scope, JSON.stringify(rules), revision, now);
}

/** Keys a scope may not set are dropped with their names, so a save can refuse them. */
export function foreignRuleKeys(scope: string, rules: StoredWorkRules): string[] {
  const allowed = new Set<string>(allowedRuleKeys(scope));
  return Object.keys(rules).filter((key) => !allowed.has(key));
}

/**
 * The view of one scope: its stored values, the effective set it works by and
 * where each effective value comes from. Inherited keys flow default → agency →
 * department; limits are the scope's own; agency-only keys come from the agency.
 */
export function workRulesView(db: SqlDatabase, scope: string): WorkRulesView {
  const own = readStoredRules(db, scope);
  const agency = scope === "agency" ? own.rules : readStoredRules(db, "agency").rules;
  const department = scope.startsWith("department:") ? own.rules : {};
  const effective: Record<string, unknown> = { ...DEFAULT_WORK_RULES };
  const sources: Record<string, RuleSource> = {};
  const set = (key: WorkRuleKey, value: unknown, source: RuleSource) => {
    effective[key] = value;
    sources[key] = source;
  };
  for (const key of Object.keys(DEFAULT_WORK_RULES) as WorkRuleKey[]) sources[key] = "default";
  for (const key of [...INHERITED_RULE_KEYS, ...AGENCY_ONLY_RULE_KEYS]) {
    if (agency[key] !== undefined) set(key, agency[key], "agency");
  }
  for (const key of INHERITED_RULE_KEYS) {
    if (department[key] !== undefined) set(key, department[key], "department");
  }
  const ownSource: RuleSource = scope === "agency" ? "agency" : scope.startsWith("department:") ? "department" : "agent";
  for (const key of LIMIT_RULE_KEYS) {
    if (own.rules[key] !== undefined) set(key, own.rules[key], ownSource);
    else set(key, null, "default");
  }
  return {
    scope,
    revision: own.revision,
    stored: own.rules,
    effective: workRulesSchema.parse(effective),
    sources,
  };
}

/** Rules a job works by: its department's view. */
export function rulesForDepartment(db: SqlDatabase, departmentId: string): WorkRules {
  return workRulesView(db, `department:${departmentId}`).effective;
}
