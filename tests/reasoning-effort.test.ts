import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { bindOfficialThreads } from "../src/server/runtime/isolated-sdk/bind-official-threads";
import {
  OFFICIAL_SPAWN_HAS_REASONING_LEVEL,
} from "../src/server/runtime/isolated-sdk/sdk-isolation-contract";
import { spawnArgsFromContract } from "../src/server/runtime/isolated-sdk/spawn-args";
import type { ContextSnapshot } from "../src/server/runtime/context-snapshot/types";
import type { IsolatedThreadSpawnArgs } from "../src/server/runtime/isolated-sdk/sdk-isolation-contract";
import { openMigratedDatabase, type SqlDatabase } from "../src/server/db";
import { createDomainStore, type ServiceContext } from "../src/server/services";
import {
  agentVersionSchema,
  createAgentVersionCommandSchema,
} from "../src/shared/contracts";

const tempDirs: string[] = [];
const skillId = "skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff";

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function requestId(): string {
  return randomUUID();
}

function openFileDb(): { db: SqlDatabase; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agy-effort-"));
  tempDirs.push(dir);
  const db = openMigratedDatabase(new Database(join(dir, "agency.sqlite")));
  return { db, close: () => db.close() };
}

const versionBody = {
  id: "ver_agent001",
  agentId: "agt_writer01",
  version: 1,
  role: "copywriter",
  instructions: "Пиши кратко",
  providerId: "claude",
  model: "opus",
  skillIds: [skillId],
  mcpIds: [] as string[],
  policyVersionId: "pol_00000001",
};

function spawnArgs(over: Partial<IsolatedThreadSpawnArgs> = {}): IsolatedThreadSpawnArgs {
  return {
    projectId: "proj_trusted",
    providerId: "claude-code",
    model: "sonnet",
    prompt: "Собрать карточку.",
    environment: {
      type: "host",
      hostId: "host_mini",
      workspace: { type: "unmanaged", path: "/tmp/agy-bind" },
    },
    isolatedSkillDelivery: true,
    skillIds: [skillId],
    visibility: "hidden",
    experimental_callerLaunchId: "11111111-1111-4111-8111-111111111111",
    experimental_callerAttemptId: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
    experimental_callerJobId: "job_aaaaaaaaaaaaaaaaaaaaaaaa",
    ...over,
  };
}

function snapshot(over: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    schemaVersion: 2,
    digest: "d".repeat(64),
    prompt: {
      digest: "p".repeat(64),
      levels: {
        platform: "p",
        agency: "a",
        project: "pr",
        department: "d",
        agent: "ag",
        job: "Job brief for worker.",
        handoff: "",
      },
    },
    binding: {
      id: "bnd_aaaaaaaa",
      hostId: "host_mini",
      canonicalRoot: "/tmp/agency-root",
      revision: 1,
      bbProjectId: "proj_trusted",
      environmentId: "env_1",
      policyVersionId: "pol_aaaaaaaa",
    },
    ...over,
  } as ContextSnapshot;
}

describe("AgentVersion reasoningEffort", () => {
  it("accepts omitted or medium and rejects unknown values", () => {
    expect(agentVersionSchema.safeParse(versionBody).success).toBe(true);
    expect(agentVersionSchema.safeParse({ ...versionBody, reasoningEffort: "medium" }).success).toBe(true);
    expect(agentVersionSchema.safeParse({ ...versionBody, reasoningEffort: "fable" }).success).toBe(false);
    expect(createAgentVersionCommandSchema.safeParse({
      requestId: requestId(),
      agentId: "agt_writer01",
      version: 1,
      role: "copywriter",
      instructions: "Пиши кратко",
      providerId: "claude",
      model: "opus",
      skillIds: [skillId],
      mcpIds: [],
      policyVersionId: "pol_00000001",
      reasoningEffort: "medium",
    }).success).toBe(true);
  });

  it("persists optional reasoningEffort on a new AgentVersion and leaves omitted rows without the field", () => {
    const { db, close } = openFileDb();
    try {
      const store = createDomainStore(db);
      const bootstrap: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [] };
      const policy = store.createPolicyVersion(bootstrap, {
        requestId: requestId(),
        allowedCapabilities: ["read.files"],
        cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_mini"] },
        secretRefs: [],
      });
      if (!policy.ok) throw new Error(policy.error.message);
      const agent = store.provisionAgent(bootstrap, {
        requestId: requestId(),
        name: "Редактор",
        state: "active",
        version: {
          version: 1,
          role: "editor",
          instructions: "Править тексты по брифу.",
          providerId: "codex",
          model: "gpt-5.6",
          skillIds: [skillId],
          mcpIds: [],
          policyVersionId: policy.value.id,
        },
      });
      if (!agent.ok) throw new Error(agent.error.message);
      expect(agent.value.version.reasoningEffort).toBeUndefined();
      const storedOmit = store.getAgentVersion(agent.value.version.id);
      expect(storedOmit?.reasoningEffort).toBeUndefined();

      const withEffort = store.createAgentVersion(bootstrap, {
        requestId: requestId(),
        agentId: agent.value.agent.id,
        version: 2,
        role: "editor",
        instructions: "Править тексты по брифу.",
        providerId: "codex",
        model: "gpt-5.6-luna",
        skillIds: [skillId],
        mcpIds: [],
        policyVersionId: policy.value.id,
        reasoningEffort: "medium",
        serviceTier: "fast",
      });
      if (!withEffort.ok) throw new Error(withEffort.error.message);
      expect(withEffort.value.reasoningEffort).toBe("medium");
      expect(store.getAgentVersion(withEffort.value.id)?.reasoningEffort).toBe("medium");
      expect(store.getAgentVersion(withEffort.value.id)?.serviceTier).toBe("fast");
      expect(storedOmit?.serviceTier).toBeUndefined();

      // The policy names Codex only: a profile on another CLI could never launch, so it is refused on save.
      const otherCli = store.createAgentVersion(bootstrap, {
        requestId: requestId(),
        agentId: agent.value.agent.id,
        version: 3,
        role: "editor",
        instructions: "Править тексты по брифу.",
        providerId: "claude-code",
        model: "claude-sonnet-5",
        skillIds: [skillId],
        mcpIds: [],
        policyVersionId: policy.value.id,
      });
      expect(otherCli).toMatchObject({ ok: false, error: { code: "provider_not_allowed_by_policy" } });
    } finally {
      close();
    }
  });
});

describe("typed spawn reasoningLevel", () => {
  it("pins the official spawn field name reasoningLevel", () => {
    expect(OFFICIAL_SPAWN_HAS_REASONING_LEVEL).toBe(true);
  });

  it("maps frozen snapshot execution to threads.spawn reasoningLevel as explicit, not prompt", () => {
    const contract = {
      snapshotId: "snp_aaaaaaaaaaaaaaaaaaaaaaaa",
      digest: "d".repeat(64),
      attemptId: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      launchId: "11111111-1111-4111-8111-111111111111",
      providerId: "claude-code",
      model: "sonnet",
      skillIds: [skillId],
      mcpIds: [] as string[],
      hostId: "host_mini",
      canonicalRoot: "/tmp/agency-root",
      environmentId: "env_1",
      bbProjectId: "proj_trusted",
    };
    const without = spawnArgsFromContract(contract, snapshot(), "job_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(without.ok).toBe(true);
    if (without.ok) {
      expect(without.value.reasoningLevel).toBeUndefined();
      expect(without.value.executionInputSources).toBeUndefined();
      expect("reasoningEffort" in without.value).toBe(false);
    }

    const built = spawnArgsFromContract(
      contract,
      snapshot({ execution: { reasoningLevel: "medium" } }),
      "job_aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.reasoningLevel).toBe("medium");
    expect(built.value.executionInputSources).toEqual({ reasoningLevel: "explicit" });
    expect(built.value.prompt).toContain("## Job (job)\nJob brief for worker.");
    expect("reasoningEffort" in built.value).toBe(false);
  });

  it("forwards reasoningLevel to official threads.spawn", async () => {
    const spawned: unknown[] = [];
    const threads = {
      async spawn(args: unknown) {
        spawned.push(args);
        return { id: "thr_bound01" };
      },
      async get() {
        return { id: "thr_bound01" };
      },
      async list() {
        return { threads: [] };
      },
    };
    const bound = bindOfficialThreads(threads as never);
    await bound.spawn(spawnArgs({
      reasoningLevel: "medium",
      executionInputSources: { reasoningLevel: "explicit" },
    }));
    const first = spawned[0] as Record<string, unknown>;
    expect(first.reasoningLevel).toBe("medium");
    expect(first.executionInputSources).toEqual({
      providerId: "explicit",
      model: "explicit",
      reasoningLevel: "explicit",
    });
    expect(first.reasoningEffort).toBeUndefined();
  });
});
