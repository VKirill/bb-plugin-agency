import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { rulesForLaunch, workRulesView, writeStoredRules } from "../src/server/rules/work-rules";
import type { ContextSnapshot } from "../src/server/runtime/context-snapshot/types";
import { bindOfficialThreads } from "../src/server/runtime/isolated-sdk/bind-official-threads";
import { spawnArgsFromContract } from "../src/server/runtime/isolated-sdk/spawn-args";
import { allowedRuleKeys, DEFAULT_WORK_RULES } from "../src/shared/contracts/work-rules";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("work rule «Запуск без песочницы»", () => {
  it("is off by default, inherits agency → department and may be set for one employee", () => {
    expect(DEFAULT_WORK_RULES.runWithoutSandbox).toBe(false);
    expect(allowedRuleKeys("agent:agt_tester01")).toContain("runWithoutSandbox");
    const dir = mkdtempSync(join(tmpdir(), "agy-sandbox-"));
    dirs.push(dir);
    const db = openMigratedDatabase(new Database(join(dir, "agency.sqlite")));
    try {
      const now = new Date().toISOString();
      expect(rulesForLaunch(db, "dep_qa0001", "agt_tester01").runWithoutSandbox).toBe(false);
      writeStoredRules(db, "department:dep_qa0001", { runWithoutSandbox: true }, 1, now);
      expect(rulesForLaunch(db, "dep_qa0001", "agt_other001").runWithoutSandbox).toBe(true);
      writeStoredRules(db, "agent:agt_tester01", { runWithoutSandbox: false }, 1, now);
      expect(rulesForLaunch(db, "dep_qa0001", "agt_tester01").runWithoutSandbox).toBe(false);
      const view = workRulesView(db, "agent:agt_tester01");
      expect(view.sources.runWithoutSandbox).toBe("agent");
    } finally {
      db.close();
    }
  });

  it("may be set for a machine: over the department, under the employee", () => {
    expect(allowedRuleKeys("host:host_ovh01")).toEqual(["runWithoutSandbox"]);
    const dir = mkdtempSync(join(tmpdir(), "agy-sandbox-host-"));
    dirs.push(dir);
    const db = openMigratedDatabase(new Database(join(dir, "agency.sqlite")));
    try {
      const now = new Date().toISOString();
      writeStoredRules(db, "host:host_ovh01", { runWithoutSandbox: true }, 1, now);
      expect(rulesForLaunch(db, "dep_qa0001", "agt_tester01", "host_ovh01").runWithoutSandbox).toBe(true);
      expect(rulesForLaunch(db, "dep_qa0001", "agt_tester01", "host_mini01").runWithoutSandbox).toBe(false);
      writeStoredRules(db, "department:dep_qa0001", { runWithoutSandbox: false }, 1, now);
      expect(rulesForLaunch(db, "dep_qa0001", "agt_tester01", "host_ovh01").runWithoutSandbox).toBe(true);
      writeStoredRules(db, "agent:agt_tester01", { runWithoutSandbox: false }, 1, now);
      expect(rulesForLaunch(db, "dep_qa0001", "agt_tester01", "host_ovh01").runWithoutSandbox).toBe(false);
      const view = workRulesView(db, "host:host_ovh01");
      expect(view.sources.runWithoutSandbox).toBe("host");
      expect(view.effective.runWithoutSandbox).toBe(true);
    } finally {
      db.close();
    }
  });

  it("sends full permissions with an explicit source only when the rule applies", async () => {
    const contract = {
      snapshotId: "snp_aaaaaaaaaaaaaaaaaaaaaaaa",
      digest: "d".repeat(64),
      attemptId: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      launchId: "11111111-1111-4111-8111-111111111111",
      providerId: "claude-code",
      model: "sonnet",
      skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
      mcpIds: [] as string[],
      hostId: "host_mini",
      canonicalRoot: "/tmp/agency-root",
      environmentId: "env_1",
      bbProjectId: "proj_trusted",
    };
    const snapshot = (execution?: ContextSnapshot["execution"]) =>
      ({
        schemaVersion: 2,
        digest: "d".repeat(64),
        job: { key: "AG-1", title: "T" },
        agentVersion: { role: "Developer" },
        prompt: { digest: "p".repeat(64), levels: { platform: "p", agency: "a", project: "pr", department: "d", agent: "ag", job: "Бриф.", handoff: "" } },
        binding: { id: "bnd_aaaaaaaa", hostId: "host_mini", canonicalRoot: "/tmp/agency-root", revision: 1, bbProjectId: "proj_trusted", environmentId: "env_1", policyVersionId: "pol_aaaaaaaa" },
        ...(execution ? { execution } : {}),
      }) as ContextSnapshot;
    const sandboxed = spawnArgsFromContract(contract, snapshot(), "job_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(sandboxed.ok && sandboxed.value.permissionMode).toBeFalsy();
    const full = spawnArgsFromContract(contract, snapshot({ permissionMode: "full" }), "job_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.value.permissionMode).toBe("full");
    expect(full.value.executionInputSources).toEqual({ permissionMode: "explicit" });
    const spawned: Record<string, unknown>[] = [];
    const threads = { spawn: async (args: Record<string, unknown>) => { spawned.push(args); return { id: "thr_1" }; }, get: async () => ({ id: "thr_1" }), list: async () => ({ threads: [] }) };
    await bindOfficialThreads(threads as never).spawn(full.value);
    expect(spawned[0]).toMatchObject({ permissionMode: "full", executionInputSources: { providerId: "explicit", model: "explicit", permissionMode: "explicit" } });
  });
});
