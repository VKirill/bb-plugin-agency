import { fail, ok, type DomainResult } from "../../domain";
import { STARTER_KIT, kitDepartment, type KitAgent, type KitDepartment, type KitLanguage } from "../../shared/starter-kit";
import type { SqlDatabase } from "../db/sql";
import type { ReasoningEffort, ServiceTier } from "../../shared/contracts/versions";
import type { ModelChoice } from "../runtime/model-fallback.js";

/**
 * Starter departments and employees. Installed records are remembered with their
 * starter key; a record whose texts still equal the starter texts in one language can
 * be switched to the other, and anything the owner edited stays as written.
 */

export const KIT_RECORD_MIGRATION = `CREATE TABLE agency_kit_record (
  record_kind TEXT NOT NULL CHECK(record_kind IN ('department', 'agent')),
  record_id TEXT NOT NULL,
  kit_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (record_kind, record_id)
)`;

type DepartmentState = { id: string; name: string; charter: string; acceptance: string; revision: number; leadAgentId: string; archivedAt: string | null; reviewRequired: boolean };
type AgentState = {
  id: string;
  name: string;
  state: string;
  revision: number;
  version: { role: string; instructions: string; providerId: string; model: string; skillIds: string[]; mcpIds: string[]; policyVersionId: string; reasoningEffort?: string; pluginIds?: string[]; version: number };
};

function readDepartment(db: SqlDatabase, id: string): DepartmentState | null {
  const row = db
    .prepare(
      `SELECT d.id, d.name, d.revision, d.lead_agent_id, d.archived_at, pv.instructions, pv.acceptance, pv.review_policy
       FROM agency_department d JOIN agency_process_version pv ON pv.id = d.process_version_id WHERE d.id = ?`,
    )
    .get(id) as { id: string; name: string; revision: number; lead_agent_id: string; archived_at: string | null; instructions: string; acceptance: string; review_policy: string } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    charter: row.instructions,
    acceptance: row.acceptance,
    revision: row.revision,
    leadAgentId: row.lead_agent_id,
    archivedAt: row.archived_at,
    reviewRequired: (JSON.parse(row.review_policy) as { required?: boolean }).required !== false,
  };
}

function readAgent(db: SqlDatabase, id: string): AgentState | null {
  const row = db
    .prepare(
      `SELECT a.id, a.name, a.state, a.revision, v.version, v.role, v.instructions, v.provider_id, v.model, v.skill_ids, v.mcp_ids, v.policy_version_id, v.reasoning_effort, v.plugin_ids
       FROM agency_agent a JOIN agency_agent_version v ON v.id = a.current_version_id WHERE a.id = ?`,
    )
    .get(id) as
    | { id: string; name: string; state: string; revision: number; version: number; role: string; instructions: string; provider_id: string; model: string; skill_ids: string; mcp_ids: string; policy_version_id: string; reasoning_effort: string | null; plugin_ids: string | null }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    revision: row.revision,
    version: {
      version: row.version,
      role: row.role,
      instructions: row.instructions,
      providerId: row.provider_id,
      model: row.model,
      skillIds: JSON.parse(row.skill_ids) as string[],
      mcpIds: JSON.parse(row.mcp_ids) as string[],
      policyVersionId: row.policy_version_id,
      ...(row.reasoning_effort ? { reasoningEffort: row.reasoning_effort } : {}),
      ...(row.plugin_ids ? { pluginIds: JSON.parse(row.plugin_ids) as string[] } : {}),
    },
  };
}

const LANGUAGES: KitLanguage[] = ["ru", "en"];

/** The starter language a department still matches, or null once the owner edited it. */
export function departmentKitLanguage(item: KitDepartment, state: Pick<DepartmentState, "name" | "charter" | "acceptance">): KitLanguage | null {
  return LANGUAGES.find((lang) => item.text[lang].name === state.name && item.text[lang].charter === state.charter && item.text[lang].acceptance === state.acceptance) ?? null;
}

export function agentKitLanguage(item: KitAgent, state: { name: string; version: { role: string; instructions: string } }): KitLanguage | null {
  return LANGUAGES.find((lang) => item.text[lang].name === state.name && item.text[lang].role === state.version.role && item.text[lang].instructions === state.version.instructions) ?? null;
}

function kitAgent(key: string): KitAgent | undefined {
  for (const department of STARTER_KIT) {
    const agent = department.agents.find((item) => item.key === key);
    if (agent) return agent;
  }
  return undefined;
}

function recordKey(db: SqlDatabase, kind: "department" | "agent", id: string): string | null {
  return (db.prepare(`SELECT kit_key FROM agency_kit_record WHERE record_kind = ? AND record_id = ?`).get(kind, id) as { kit_key: string } | undefined)?.kit_key ?? null;
}

function remember(db: SqlDatabase, kind: "department" | "agent", id: string, key: string, now: string): void {
  db.prepare(`INSERT OR IGNORE INTO agency_kit_record (record_kind, record_id, kit_key, created_at) VALUES (?, ?, ?, ?)`).run(kind, id, key, now);
}

/**
 * Recognizes records created from the starter texts before they were tracked: a
 * department or an employee whose texts equal a starter item exactly in either language.
 */
export function adoptStarterRecords(db: SqlDatabase, now: string): number {
  let adopted = 0;
  for (const row of db.prepare(`SELECT id FROM agency_department`).all() as { id: string }[]) {
    if (recordKey(db, "department", row.id)) continue;
    const state = readDepartment(db, row.id);
    const item = state && STARTER_KIT.find((candidate) => departmentKitLanguage(candidate, state));
    if (item) {
      remember(db, "department", row.id, item.key, now);
      adopted += 1;
    }
  }
  for (const row of db.prepare(`SELECT id FROM agency_agent`).all() as { id: string }[]) {
    if (recordKey(db, "agent", row.id)) continue;
    const state = readAgent(db, row.id);
    if (!state) continue;
    const item = STARTER_KIT.flatMap((department) => department.agents).find((candidate) => agentKitLanguage(candidate, state));
    if (item) {
      remember(db, "agent", row.id, item.key, now);
      adopted += 1;
    }
  }
  return adopted;
}

export type StarterKitView = {
  departments: {
    key: string;
    name: string;
    purpose: string;
    agents: { key: string; name: string; role: string; roleType: KitAgent["roleType"] }[];
    /** The installed department, when there is one and it is not archived. */
    installed: { departmentId: string; language: KitLanguage | null } | null;
  }[];
  /** Records in the other language that still have the starter texts. */
  translatable: number;
  /** Starter records the owner edited: a language switch leaves them as they are. */
  edited: number;
};

function purposeOf(charter: string): string {
  const lines = charter.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s*(Назначение|Purpose)\s*$/i.test(line.trim()));
  return (start >= 0 ? lines.slice(start + 1).find((line) => line.trim()) : lines.find((line) => line.trim() && !line.startsWith("#")))?.trim() ?? "";
}

export function starterKitView(db: SqlDatabase, language: KitLanguage, now: string): StarterKitView {
  adoptStarterRecords(db, now);
  const records = db.prepare(`SELECT record_kind, record_id, kit_key FROM agency_kit_record`).all() as { record_kind: "department" | "agent"; record_id: string; kit_key: string }[];
  let translatable = 0;
  let edited = 0;
  const installedByKey = new Map<string, { departmentId: string; language: KitLanguage | null }>();
  for (const record of records) {
    if (record.record_kind === "department") {
      const item = kitDepartment(record.kit_key);
      const state = readDepartment(db, record.record_id);
      if (!item || !state) continue;
      const lang = departmentKitLanguage(item, state);
      if (!state.archivedAt) installedByKey.set(item.key, { departmentId: state.id, language: lang });
      if (lang === null) edited += 1;
      else if (lang !== language) translatable += 1;
    } else {
      const item = kitAgent(record.kit_key);
      const state = readAgent(db, record.record_id);
      if (!item || !state) continue;
      const lang = agentKitLanguage(item, state);
      if (lang === null) edited += 1;
      else if (lang !== language) translatable += 1;
    }
  }
  return {
    departments: STARTER_KIT.map((item) => ({
      key: item.key,
      name: item.text[language].name,
      purpose: purposeOf(item.text[language].charter),
      agents: item.agents.map((agent) => ({
        key: agent.key,
        name: agent.text[language].name,
        role: agent.text[language].role,
        roleType: agent.roleType,
        ...(agent.preset ? { model: { providerId: agent.preset.providerId, model: agent.preset.model, label: agent.preset.label[language] } } : {}),
      })),
      installed: installedByKey.get(item.key) ?? null,
    })),
    translatable,
    edited,
  };
}

export type StarterKitPorts = {
  db: SqlDatabase;
  now: () => string;
  newRequestId: () => string;
  /** Standard employee permissions: project files, any CLI, any machine the binding allows. */
  policyVersionId: () => DomainResult<string>;
  /** CLI, model, reasoning and fast mode for a role type from the agency work rules. */
  defaults: (roleType: KitAgent["roleType"]) => { providerId: string; model: string; reasoningEffort: ReasoningEffort; serviceTier: ServiceTier | null };
  /**
   * What this BB can actually run. The preset CLI and model are matched against the connected
   * catalog: a missing model becomes the closest one there, and only a hopeless case falls back
   * to the role default from the work rules.
   */
  resolveModel?: (wish: { providerId: string; model: string }) => ModelChoice;
  provisionAgent: (input: { requestId: string; name: string; state: "active"; version: { version: 1; role: string; instructions: string; providerId: string; model: string; reasoningEffort: ReasoningEffort; serviceTier?: ServiceTier; skillIds: string[]; mcpIds: string[]; policyVersionId: string } }) => DomainResult<{ agent: { id: string } }>;
  provisionDepartment: (input: { requestId: string; name: string; leadAgentId: string; process: { instructions: string; acceptance: string; reviewPolicy: { required: boolean } } }) => DomainResult<{ department: { id: string } }>;
  addMembership: (input: { requestId: string; departmentId: string; agentId: string; role: "executor" | "reviewer" | "assistant"; helpsAgentId?: string }) => DomainResult<unknown>;
  saveAgentProfile: (input: { requestId: string; expectedRevision: number; agentId: string; name: string; state: string; version: AgentState["version"] }) => DomainResult<unknown>;
  saveDepartmentProfile: (input: { requestId: string; expectedRevision: number; departmentId: string; name: string; leadAgentId: string; process: { instructions: string; acceptance: string; reviewPolicy: { required: boolean } } }) => DomainResult<unknown>;
};

export type InstallOutcome = { installed: { key: string; departmentId: string; agents: number; note?: string }[]; skipped: { key: string; reason: string }[] };

/** Installs the chosen starter departments with their employees in the given language. */
export function installStarterKit(ports: StarterKitPorts, input: { keys: string[]; language: KitLanguage }, en: boolean): DomainResult<InstallOutcome> {
  const policy = ports.policyVersionId();
  if (!policy.ok) return policy;
  const now = ports.now();
  const view = starterKitView(ports.db, input.language, now);
  const outcome: InstallOutcome = { installed: [], skipped: [] };
  for (const key of [...new Set(input.keys)]) {
    const item = kitDepartment(key);
    if (!item) {
      outcome.skipped.push({ key, reason: en ? "unknown starter department" : "такого стартового отдела нет" });
      continue;
    }
    if (view.departments.find((department) => department.key === key)?.installed) {
      outcome.skipped.push({ key, reason: en ? "already installed" : "уже установлен" });
      continue;
    }
    const text = item.text[input.language];
    const taken = ports.db.prepare(`SELECT 1 FROM agency_department WHERE lower(trim(name)) = lower(trim(?))`).get(text.name);
    if (taken) {
      outcome.skipped.push({ key, reason: en ? `a department named «${text.name}» exists` : `отдел «${text.name}» уже есть` });
      continue;
    }
    const agentIds = new Map<string, string>();
    let failed: string | null = null;
    const missingCli: string[] = [];
    const swapped: string[] = [];
    for (const agent of item.agents) {
      const wish = agent.preset ? { providerId: agent.preset.providerId, model: agent.preset.model } : null;
      const choice = wish && ports.resolveModel ? ports.resolveModel(wish) : null;
      const preset = agent.preset && (!choice || choice.status !== "missing") ? agent.preset : null;
      if (agent.preset && !preset) missingCli.push(`${agent.text[input.language].name} (${agent.preset.providerId})`);
      const substituted = preset && choice && choice.status === "substituted" ? choice : null;
      if (substituted) swapped.push(`${agent.text[input.language].name}: ${substituted.wanted.model} → ${substituted.model}`);
      const defaults = preset
        ? {
            providerId: substituted ? substituted.providerId : preset.providerId,
            model: substituted ? substituted.model : preset.model,
            reasoningEffort: preset.reasoningEffort as ReasoningEffort,
            // Fast mode belongs to the CLI it was set for; another CLI may not have it at all.
            serviceTier: (substituted && substituted.providerId !== preset.providerId ? null : preset.serviceTier ?? null) as ServiceTier | null,
          }
        : ports.defaults(agent.roleType);
      const created = ports.provisionAgent({
        requestId: ports.newRequestId(),
        name: agent.text[input.language].name,
        state: "active",
        version: {
          version: 1,
          role: agent.text[input.language].role,
          instructions: agent.text[input.language].instructions,
          providerId: defaults.providerId,
          model: defaults.model,
          reasoningEffort: defaults.reasoningEffort,
          ...(defaults.serviceTier ? { serviceTier: defaults.serviceTier } : {}),
          skillIds: [],
          mcpIds: [],
          policyVersionId: policy.value,
        },
      });
      if (!created.ok) {
        failed = created.error.message;
        break;
      }
      agentIds.set(agent.key, created.value.agent.id);
      remember(ports.db, "agent", created.value.agent.id, agent.key, now);
    }
    const lead = item.agents.find((agent) => agent.roleType === "lead");
    const leadId = lead ? agentIds.get(lead.key) : undefined;
    if (failed || !leadId) {
      outcome.skipped.push({ key, reason: failed ?? (en ? "the department has no lead" : "у отдела нет руководителя") });
      continue;
    }
    const department = ports.provisionDepartment({
      requestId: ports.newRequestId(),
      name: text.name,
      leadAgentId: leadId,
      process: { instructions: text.charter, acceptance: text.acceptance, reviewPolicy: { required: true } },
    });
    if (!department.ok) {
      outcome.skipped.push({ key, reason: department.error.message });
      continue;
    }
    remember(ports.db, "department", department.value.department.id, item.key, now);
    for (const agent of item.agents) {
      if (agent.roleType === "lead") continue;
      const helps = agent.helpsKey ? agentIds.get(agent.helpsKey) : undefined;
      ports.addMembership({
        requestId: ports.newRequestId(),
        departmentId: department.value.department.id,
        agentId: agentIds.get(agent.key)!,
        role: agent.roleType,
        ...(helps ? { helpsAgentId: helps } : {}),
      });
    }
    outcome.installed.push({
      key,
      departmentId: department.value.department.id,
      agents: agentIds.size,
      ...(missingCli.length || swapped.length
        ? {
            note: [
              missingCli.length
                ? en
                  ? `CLI is not connected in BB, the role default is used: ${missingCli.join(", ")}.`
                  : `CLI не подключён в BB, взята модель роли по умолчанию: ${missingCli.join(", ")}.`
                : "",
              swapped.length
                ? en
                  ? `The model is not connected here, the closest one is used: ${swapped.join(", ")}.`
                  : `Модель здесь не подключена, взята ближайшая: ${swapped.join(", ")}.`
                : "",
            ]
              .filter(Boolean)
              .join(" "),
          }
        : {}),
    });
  }
  return ok(outcome);
}

export type TranslateOutcome = { translated: number; unchanged: number; edited: { kind: "department" | "agent"; name: string }[] };

/** Switches starter records still holding starter texts to the language; edited ones stay. */
export function translateStarterKit(ports: StarterKitPorts, language: KitLanguage): DomainResult<TranslateOutcome> {
  const now = ports.now();
  adoptStarterRecords(ports.db, now);
  const outcome: TranslateOutcome = { translated: 0, unchanged: 0, edited: [] };
  const records = ports.db.prepare(`SELECT record_kind, record_id, kit_key FROM agency_kit_record ORDER BY record_kind DESC`).all() as {
    record_kind: "department" | "agent";
    record_id: string;
    kit_key: string;
  }[];
  for (const record of records) {
    if (record.record_kind === "agent") {
      const item = kitAgent(record.kit_key);
      const state = readAgent(ports.db, record.record_id);
      if (!item || !state) continue;
      const lang = agentKitLanguage(item, state);
      if (lang === null) {
        outcome.edited.push({ kind: "agent", name: state.name });
        continue;
      }
      if (lang === language) {
        outcome.unchanged += 1;
        continue;
      }
      const text = item.text[language];
      const saved = ports.saveAgentProfile({
        requestId: ports.newRequestId(),
        expectedRevision: state.revision,
        agentId: state.id,
        name: text.name,
        state: state.state,
        version: { ...state.version, role: text.role, instructions: text.instructions },
      });
      if (!saved.ok) return fail(saved.error.code, `${state.name}: ${saved.error.message}`);
      outcome.translated += 1;
    } else {
      const item = kitDepartment(record.kit_key);
      const state = readDepartment(ports.db, record.record_id);
      if (!item || !state) continue;
      const lang = departmentKitLanguage(item, state);
      if (lang === null) {
        outcome.edited.push({ kind: "department", name: state.name });
        continue;
      }
      if (lang === language) {
        outcome.unchanged += 1;
        continue;
      }
      const text = item.text[language];
      const saved = ports.saveDepartmentProfile({
        requestId: ports.newRequestId(),
        expectedRevision: state.revision,
        departmentId: state.id,
        name: text.name,
        leadAgentId: state.leadAgentId,
        process: { instructions: text.charter, acceptance: text.acceptance, reviewPolicy: { required: state.reviewRequired } },
      });
      if (!saved.ok) return fail(saved.error.code, `${state.name}: ${saved.error.message}`);
      outcome.translated += 1;
    }
  }
  return ok(outcome);
}
