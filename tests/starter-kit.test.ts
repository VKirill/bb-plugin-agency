import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { resolveAlias } from "../src/server/cli/aliases";
import { CLI_EXAMPLES } from "../src/server/cli/examples";
import { CLI_OPERATIONS } from "../src/server/cli/operations";
import { openMigratedDatabase } from "../src/server/db";
import { charterAccepts } from "../src/server/delegation/instructions";
import { agentDeleteBlocker, archiveDepartment, deleteAgent, deleteDepartment, restoreDepartment } from "../src/server/organization/lifecycle";
import { adoptStarterRecords, installStarterKit, starterKitView, translateStarterKit, type StarterKitPorts } from "../src/server/organization/starter-kit";
import { STARTER_KIT } from "../src/shared/starter-kit";
import { resolveModelChoice } from "../src/server/runtime/model-fallback";
import { seed } from "./role-types.test";

const NOW = "2026-09-17T12:00:00.000Z";

function setup() {
  const db = openMigratedDatabase(new Database(":memory:"));
  const s = seed(db);
  const ctx = s.bootstrap;
  const ports: StarterKitPorts = {
    db,
    now: () => NOW,
    newRequestId: () => randomUUID(),
    policyVersionId: () => {
      const created = s.store.createPolicyVersion(ctx, {
        requestId: randomUUID(),
        allowedCapabilities: ["read.files", "write.files"],
        cliHostConstraints: { providerIds: [], hostIds: [] },
        secretRefs: [],
      });
      return created.ok ? { ok: true, value: created.value.id } : created;
    },
    defaults: (roleType) => ({
      providerId: roleType === "lead" ? "claude-code" : "codex",
      model: roleType === "lead" ? "claude-opus-5[1m]" : "gpt-5.6-luna",
      reasoningEffort: roleType === "lead" ? "high" : "medium",
      serviceTier: roleType === "lead" ? null : "fast",
    }),
    provisionAgent: (input) => s.store.provisionAgent(ctx, input as never),
    provisionDepartment: (input) => s.store.provisionDepartment(ctx, input),
    addMembership: (input) => s.store.addMembership(ctx, input),
    saveAgentProfile: (input) => s.store.saveAgentProfile(ctx, input as never),
    saveDepartmentProfile: (input) => s.store.saveDepartmentProfile(ctx, input),
  };
  const names = () => (db.prepare(`SELECT name FROM agency_agent ORDER BY rowid`).all() as { name: string }[]).map((row) => row.name);
  return { db, s, ports, names };
}

describe("starter kit", () => {
  it("has a lead and routable charters in both languages in every department", () => {
    expect(STARTER_KIT.map((item) => item.key)).toEqual(["development", "dev-conveyor", "research", "writing"]);
    for (const item of STARTER_KIT) {
      expect(item.agents.filter((agent) => agent.roleType === "lead")).toHaveLength(1);
      expect(charterAccepts(item.text.ru.charter)).toBeTruthy();
      expect(charterAccepts(item.text.en.charter)).toBeTruthy();
      expect(item.text.en.charter).not.toMatch(/[А-Яа-яЁё]/);
      for (const agent of item.agents) expect(agent.text.en.instructions + agent.text.en.name + agent.text.en.role).not.toMatch(/[А-Яа-яЁё]/);
    }
  });

  it("gives the conveyor employees the CLI their work is meant for", () => {
    const conveyor = STARTER_KIT.find((item) => item.key === "dev-conveyor")!;
    const preset = (key: string) => conveyor.agents.find((agent) => agent.key === key)?.preset;
    // The code is written by Grok in fast mode, planning and review go to other vendors.
    expect(preset("conveyor-coder")).toMatchObject({ providerId: "acp-cursor", model: "grok-4.6", reasoningEffort: "medium", serviceTier: "fast" });
    expect(preset("conveyor-lead")).toMatchObject({ providerId: "claude-code" });
    expect(preset("conveyor-scout")).toMatchObject({ providerId: "codex", serviceTier: "fast" });
    expect(preset("conveyor-reviewer")).toMatchObject({ providerId: "codex", reasoningEffort: "high" });
    expect(conveyor.agents.every((agent) => agent.preset?.label.ru && agent.preset.label.en && !/[А-Яа-яЁё]/.test(agent.preset.label.en))).toBe(true);
  });

  it("puts a conveyor employee on the closest model this BB has", () => {
    const t = setup();
    // This BB has no Cursor and no Codex: only Claude models are connected.
    const claude = [
      { providerId: "claude-code", model: "claude-opus-5[1m]", isDefault: true },
      { providerId: "claude-code", model: "claude-sonnet-5", isDefault: false },
      { providerId: "claude-code", model: "claude-haiku-4-5", isDefault: false },
    ];
    const installed = installStarterKit(
      { ...t.ports, resolveModel: (wish) => resolveModelChoice(wish, claude) },
      { keys: ["dev-conveyor"], language: "ru" },
      false,
    );
    expect(installed.ok).toBe(true);
    const coder = t.db
      .prepare(
        `SELECT v.provider_id AS providerId, v.model AS model, v.service_tier AS serviceTier
         FROM agency_agent a JOIN agency_agent_version v ON v.id = a.current_version_id WHERE a.name = ?`,
      )
      .get("Кодер") as { providerId: string; model: string; serviceTier: string | null };
    // Grok is not here: the coder gets a model of the same class, and fast mode does not travel to another CLI.
    expect(coder).toMatchObject({ providerId: "claude-code", model: "claude-sonnet-5", serviceTier: null });
    expect(installed.ok && installed.value.installed[0]?.note).toContain("grok-4.6 → claude-sonnet-5");
  });

  it("installs only the chosen departments, with default models, and never twice", () => {
    const t = setup();
    const installed = installStarterKit(t.ports, { keys: ["development"], language: "en" }, true);
    expect(installed.ok && installed.value.installed.map((row) => [row.key, row.agents])).toEqual([["development", 4]]);
    expect(t.names()).toEqual(expect.arrayContaining(["Development lead", "Lead developer", "Developer", "Code reviewer"]));
    const view = starterKitView(t.db, "en", NOW);
    expect(view.departments.find((item) => item.key === "development")?.installed?.language).toBe("en");
    expect(view.departments.find((item) => item.key === "research")?.installed).toBeNull();
    const lead = t.db.prepare(`SELECT v.model, v.reasoning_effort FROM agency_agent a JOIN agency_agent_version v ON v.id = a.current_version_id WHERE a.name = 'Development lead'`).get();
    expect(lead).toEqual({ model: "claude-opus-5[1m]", reasoning_effort: "high" });
    const again = installStarterKit(t.ports, { keys: ["development"], language: "en" }, true);
    expect(again.ok && again.value.skipped).toEqual([{ key: "development", reason: "already installed" }]);
  });

  it("switches untouched starter records to the other language and leaves edited ones", () => {
    const t = setup();
    installStarterKit(t.ports, { keys: ["writing"], language: "ru" }, false);
    const writer = t.db.prepare(`SELECT id FROM agency_agent WHERE name = 'Автор'`).get() as { id: string };
    const agent = t.s.store.getAgent(writer.id)!;
    const version = t.s.store.getAgentVersion(agent.currentVersionId)!;
    const { id: _id, agentId: _agentId, ...draft } = version;
    const edited = t.s.store.saveAgentProfile(t.s.bootstrap, { requestId: randomUUID(), expectedRevision: agent.revision, agentId: agent.id, name: agent.name, state: agent.state, version: { ...draft, instructions: `${version.instructions}\nПишу только короткие тексты.` } });
    expect(edited.ok).toBe(true);
    expect(starterKitView(t.db, "en", NOW)).toMatchObject({ translatable: 3, edited: 1 });

    const translated = translateStarterKit(t.ports, "en");
    expect(translated.ok && translated.value).toMatchObject({ translated: 3, edited: [{ kind: "agent", name: "Автор" }] });
    expect(t.names()).toEqual(expect.arrayContaining(["Editorial lead", "Editor", "Автор"]));
    const department = t.db.prepare(`SELECT d.name, pv.instructions FROM agency_department d JOIN agency_process_version pv ON pv.id = d.process_version_id WHERE d.name = 'Texts and documentation'`).get() as { name: string; instructions: string };
    expect(department.instructions.startsWith("## Purpose")).toBe(true);
    expect(translateStarterKit(t.ports, "ru").ok).toBe(true);
    expect(t.names()).toEqual(expect.arrayContaining(["Руководитель редакции", "Редактор"]));
  });

  it("recognizes records created earlier from the starter texts", () => {
    const t = setup();
    const item = STARTER_KIT.find((row) => row.key === "research")!;
    const policy = t.ports.policyVersionId();
    if (!policy.ok) throw new Error(policy.error.message);
    const lead = item.agents[0]!;
    const created = t.s.store.provisionAgent(t.s.bootstrap, {
      requestId: randomUUID(),
      name: lead.text.ru.name,
      state: "active",
      version: { version: 1, role: lead.text.ru.role, instructions: lead.text.ru.instructions, providerId: "claude-code", model: "claude-sonnet-5", skillIds: [], mcpIds: [], policyVersionId: policy.value },
    });
    if (!created.ok) throw new Error(created.error.message);
    const department = t.s.store.provisionDepartment(t.s.bootstrap, {
      requestId: randomUUID(),
      name: item.text.ru.name,
      leadAgentId: created.value.agent.id,
      process: { instructions: item.text.ru.charter, acceptance: item.text.ru.acceptance, reviewPolicy: { required: true } },
    });
    if (!department.ok) throw new Error(department.error.message);
    expect(adoptStarterRecords(t.db, NOW)).toBe(2);
    expect(starterKitView(t.db, "ru", NOW).departments.find((row) => row.key === "research")?.installed?.language).toBe("ru");
    const skipped = installStarterKit(t.ports, { keys: ["research"], language: "en" }, true);
    expect(skipped.ok && skipped.value.skipped).toEqual([{ key: "research", reason: "already installed" }]);
  });

  it("is reachable from the CLI", () => {
    expect(resolveAlias(["kit", "list"])).toBe("starterKit");
    expect(resolveAlias(["kit", "install"])).toBe("installStarterKit");
    expect(resolveAlias(["kit", "translate"])).toBe("translateStarterKit");
    expect(resolveAlias(["department", "archive"])).toBe("archiveDepartment");
    expect(resolveAlias(["department", "delete"])).toBe("deleteDepartment");
    expect(resolveAlias(["agent", "delete"])).toBe("deleteAgent");
    for (const operation of ["starterKit", "installStarterKit", "translateStarterKit", "recordLifecycle", "archiveDepartment", "restoreDepartment", "deleteDepartment", "deleteAgent"] as const) {
      expect(CLI_OPERATIONS[operation].input.safeParse(CLI_EXAMPLES[operation]).success).toBe(true);
    }
  });
});

describe("organization lifecycle", () => {
  it("archives a department only without open jobs, keeps it out of new jobs, restores it", () => {
    const t = setup();
    const job = t.s.job("Открытая", t.s.developer);
    const refused = archiveDepartment(t.db, t.s.departmentId, NOW, false);
    expect(refused.ok || refused.error.code).toBe("department_has_open_jobs");
    t.db.prepare(`UPDATE agency_job SET state = 'done' WHERE id = ?`).run(job.id);
    expect(archiveDepartment(t.db, t.s.departmentId, NOW, false).ok).toBe(true);
    expect(t.s.store.getDepartment(t.s.departmentId)?.archivedAt).toBe(NOW);
    const blocked = t.s.store.createJob(t.s.ctx, { requestId: randomUUID(), bindingId: t.s.ctx.allowedBindingIds[0]!, departmentId: t.s.departmentId, title: "Новая", brief: "Б.", acceptance: "К.", parentJobId: null, assignedAgentId: t.s.developer, priority: "normal", dueAt: null });
    expect(blocked.ok || blocked.error.code).toBe("department_archived");
    const deleted = deleteDepartment(t.db, t.s.departmentId, true);
    expect(deleted.ok || deleted.error.code).toBe("department_has_history");
    expect(restoreDepartment(t.db, t.s.departmentId).ok).toBe(true);
    expect(t.s.store.getDepartment(t.s.departmentId)?.archivedAt).toBeUndefined();
  });

  it("deletes a department and an employee that never worked, and nothing with history", () => {
    const t = setup();
    installStarterKit(t.ports, { keys: ["research"], language: "en" }, true);
    const research = t.db.prepare(`SELECT id, lead_agent_id FROM agency_department WHERE name = 'Research and analytics'`).get() as { id: string; lead_agent_id: string };
    expect(agentDeleteBlocker(t.db, research.lead_agent_id, true)).toContain("leads «Research and analytics»");
    expect(deleteDepartment(t.db, research.id, true).ok).toBe(true);
    expect(t.db.prepare(`SELECT COUNT(*) AS n FROM agency_membership WHERE department_id = ?`).get(research.id)).toEqual({ n: 0 });
    expect(deleteAgent(t.db, research.lead_agent_id, true).ok).toBe(true);
    expect(t.db.prepare(`SELECT COUNT(*) AS n FROM agency_agent_version WHERE agent_id = ?`).get(research.lead_agent_id)).toEqual({ n: 0 });
    t.s.job("Работа", t.s.developer);
    const busy = deleteAgent(t.db, t.s.developer, false);
    expect(busy.ok || busy.error.code).toBe("agent_has_history");
    expect(t.db.pragma("foreign_key_check")).toEqual([]);
  });
});
