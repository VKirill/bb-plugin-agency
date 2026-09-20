import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrations } from "../src/server/db/migrations";
import { openMigratedDatabase, type SqlDatabase } from "../src/server/db";
import {
  AGENT_FALLBACK_LIST_MIGRATION,
  AGENT_FALLBACK_MIGRATION,
  applyLaunchCandidate,
  clearExhaustedModels,
  isUsageLimitDetail,
  launchCandidates,
  launchModelSource,
  markModelExhausted,
  MODEL_EXHAUSTED_MS,
  modelIsExhausted,
  nextFreshCandidate,
  profileFallbacks,
  profileNamesModel,
} from "../src/server/runtime/agent-fallback";
import { createDomainStore, type ServiceContext } from "../src/server/services";
import {
  AGENT_FALLBACK_LIMIT,
  agentVersionDraftSchema,
  optionalFallbackModels,
  sameFallbackModels,
  type AgentVersion,
} from "../src/shared/contracts";

const tempDirs: string[] = [];
const skillId = "skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff";

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function openFileDb(): { db: SqlDatabase; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agy-fallback-"));
  tempDirs.push(dir);
  const db = openMigratedDatabase(new Database(join(dir, "agency.sqlite")));
  return { db, close: () => db.close() };
}

const draft = {
  version: 2,
  role: "reviewer",
  instructions: "Проверяй код.",
  providerId: "codex",
  model: "gpt-5.4",
  skillIds: [skillId],
  mcpIds: [],
  policyVersionId: "policy_aaaaaaaa",
};

const version: AgentVersion = {
  id: "ver_agent001",
  agentId: "agt_reviewer",
  ...draft,
  reasoningEffort: "high",
  serviceTier: "fast",
  fallbackModels: [
    { providerId: "opencode", model: "gemini-3.8-flash", reasoningEffort: "medium" },
    { providerId: "claude-code", model: "claude-sonnet-5" },
  ],
} as AgentVersion;

describe("reserve list schema", () => {
  it("appends the list migration after the shipped single-reserve one", () => {
    const single = migrations.indexOf(AGENT_FALLBACK_MIGRATION);
    const list = migrations.indexOf(AGENT_FALLBACK_LIST_MIGRATION);
    expect(single).toBeGreaterThanOrEqual(0);
    expect(list).toBe(single + 1);
  });

  it("accepts an ordered list of up to four pairs and an absent list", () => {
    expect(agentVersionDraftSchema.safeParse(draft).success).toBe(true);
    expect(agentVersionDraftSchema.safeParse({ ...draft, fallbackModels: [] }).success).toBe(true);
    const four = ["a", "b", "c", "d"].map((model) => ({ providerId: "opencode", model }));
    expect(four).toHaveLength(AGENT_FALLBACK_LIMIT);
    expect(agentVersionDraftSchema.safeParse({ ...draft, fallbackModels: four }).success).toBe(true);
    expect(agentVersionDraftSchema.safeParse({ ...draft, fallbackModels: [...four, { providerId: "opencode", model: "e" }] }).success).toBe(false);
  });

  it("refuses a repeat of the primary, a repeated pair and the retired single-reserve fields", () => {
    expect(agentVersionDraftSchema.safeParse({ ...draft, fallbackModels: [{ providerId: "codex", model: "gpt-5.4" }] }).success).toBe(false);
    expect(
      agentVersionDraftSchema.safeParse({
        ...draft,
        fallbackModels: [
          { providerId: "opencode", model: "gemini-3.8-flash" },
          { providerId: "opencode", model: "gemini-3.8-flash", reasoningEffort: "high" },
        ],
      }).success,
    ).toBe(false);
    // Same model on another CLI is a different pair.
    expect(agentVersionDraftSchema.safeParse({ ...draft, fallbackModels: [{ providerId: "opencode", model: "gpt-5.4" }] }).success).toBe(true);
    expect(agentVersionDraftSchema.safeParse({ ...draft, fallbackProviderId: "opencode", fallbackModel: "gemini-3.8-flash" }).success).toBe(false);
  });

  it("stores nothing for an empty list and treats a reorder as a change", () => {
    expect(optionalFallbackModels(undefined)).toEqual({});
    expect(optionalFallbackModels([])).toEqual({});
    const [first, second] = version.fallbackModels!;
    expect(sameFallbackModels(undefined, [])).toBe(true);
    expect(sameFallbackModels([first!, second!], [first!, second!])).toBe(true);
    expect(sameFallbackModels([first!, second!], [second!, first!])).toBe(false);
  });
});

describe("launch candidates", () => {
  it("gives the primary alone when the owner named no reserves", () => {
    const { db, close } = openFileDb();
    try {
      const { fallbackModels: _none, ...plain } = version;
      const list = launchCandidates(db, plain.agentId, plain, "2026-09-20T00:00:00.000Z");
      expect(list.map((item) => item.source)).toEqual(["primary"]);
      expect(list[0]).toMatchObject({ providerId: "codex", model: "gpt-5.4", reasoningEffort: "high", serviceTier: "fast" });
    } finally {
      close();
    }
  });

  it("orders primary first, then reserves by priority", () => {
    const { db, close } = openFileDb();
    try {
      const list = launchCandidates(db, version.agentId, version, "2026-09-20T00:00:00.000Z");
      expect(list.map((item) => `${item.source}:${item.providerId}/${item.model}`)).toEqual([
        "primary:codex/gpt-5.4",
        "fallback 1:opencode/gemini-3.8-flash",
        "fallback 2:claude-code/claude-sonnet-5",
      ]);
    } finally {
      close();
    }
  });

  it("overlays a reserve for this launch only and leaves the primary as it is", () => {
    expect(profileFallbacks(version)).toHaveLength(2);
    const onPrimary = applyLaunchCandidate(version, { source: "primary", providerId: "codex", model: "gpt-5.4" });
    expect(onPrimary).toBe(version);
    const onReserve = applyLaunchCandidate(version, { source: "fallback 1", ...version.fallbackModels![0]! });
    expect(onReserve).toMatchObject({ id: version.id, providerId: "opencode", model: "gemini-3.8-flash", reasoningEffort: "medium" });
    // Fast mode belongs to the primary's CLI; the reserve did not ask for it.
    expect(onReserve.serviceTier).toBeUndefined();
    expect(version.providerId).toBe("codex");
    expect(launchModelSource(version, onReserve)).toBe("fallback 1");
    expect(launchModelSource(version, { providerId: "claude-code", model: "claude-sonnet-5" })).toBe("fallback 2");
    expect(launchModelSource(version, version)).toBe("primary");
  });

  it("names only the primary and the owner's reserves as launchable", () => {
    expect(profileNamesModel(version, { providerId: "codex", model: "gpt-5.4" })).toBe(true);
    expect(profileNamesModel(version, { providerId: "opencode", model: "gemini-3.8-flash" })).toBe(true);
    // The catalog's closest model of the same family is not a reserve until the owner lists it.
    expect(profileNamesModel(version, { providerId: "codex", model: "gpt-5.5" })).toBe(false);
  });

  it("treats usage/quota text as a limit and leaves overload alone", () => {
    expect(isUsageLimitDetail("You have hit your usage limit")).toBe(true);
    expect(isUsageLimitDetail("Subscription window exhausted")).toBe(true);
    expect(isUsageLimitDetail("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage")).toBe(true);
    expect(isUsageLimitDetail("usageLimitExceeded")).toBe(true);
    expect(isUsageLimitDetail("Исчерпан лимит подписки")).toBe(true);
    expect(isUsageLimitDetail("Достигнут лимит запросов к провайдеру")).toBe(true);
    expect(isUsageLimitDetail("overloaded_error")).toBe(false);
    expect(isUsageLimitDetail(null)).toBe(false);
  });

  it("moves an exhausted pair behind the fresh ones for six hours, per pair", () => {
    const { db, close } = openFileDb();
    try {
      const now = "2026-09-20T00:00:00.000Z";
      markModelExhausted(db, { agentId: version.agentId, providerId: "codex", model: "gpt-5.4", now });
      expect(modelIsExhausted(db, version.agentId, version, now)).toBe(true);
      expect(modelIsExhausted(db, "agt_other", version, now)).toBe(false);
      expect(launchCandidates(db, version.agentId, version, now).map((item) => item.source)).toEqual(["fallback 1", "fallback 2", "primary"]);
      expect(nextFreshCandidate(db, version.agentId, version, version, now)?.source).toBe("fallback 1");

      // The first reserve hits its own limit: the second one is next, and after it nothing is fresh.
      markModelExhausted(db, { agentId: version.agentId, ...version.fallbackModels![0]!, now });
      expect(nextFreshCandidate(db, version.agentId, version, version.fallbackModels![0]!, now)?.source).toBe("fallback 2");
      markModelExhausted(db, { agentId: version.agentId, ...version.fallbackModels![1]!, now });
      expect(nextFreshCandidate(db, version.agentId, version, version.fallbackModels![1]!, now)).toBeNull();
      // Everything exhausted: the order is the profile's again, the primary first.
      expect(launchCandidates(db, version.agentId, version, now).map((item) => item.source)).toEqual(["primary", "fallback 1", "fallback 2"]);

      const later = new Date(Date.parse(now) + MODEL_EXHAUSTED_MS + 1).toISOString();
      expect(modelIsExhausted(db, version.agentId, version, later)).toBe(false);
      clearExhaustedModels(db, version.agentId);
      expect(modelIsExhausted(db, version.agentId, version, now)).toBe(false);
    } finally {
      close();
    }
  });
});

describe("reserve list in the employee profile", () => {
  function seed(db: SqlDatabase) {
    const store = createDomainStore(db);
    const ctx: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [] };
    const policy = store.createPolicyVersion(ctx, {
      requestId: randomUUID(),
      allowedCapabilities: ["read.files"],
      cliHostConstraints: { providerIds: ["codex", "opencode"], hostIds: ["host_mini"] },
      secretRefs: [],
    });
    if (!policy.ok) throw new Error(policy.error.message);
    const agent = store.provisionAgent(ctx, {
      requestId: randomUUID(),
      name: "Проверяющий",
      state: "active",
      version: { ...draft, version: 1, policyVersionId: policy.value.id },
    });
    if (!agent.ok) throw new Error(agent.error.message);
    return { store, ctx, policyId: policy.value.id, agent: agent.value.agent, versionId: agent.value.version.id };
  }

  it("saves the ordered list as a new profile version, and a reorder as another one", () => {
    const { db, close } = openFileDb();
    try {
      const { store, ctx, policyId, agent, versionId } = seed(db);
      expect(store.getAgentVersion(versionId)?.fallbackModels).toBeUndefined();
      const reserves = [
        { providerId: "opencode", model: "gemini-3.8-flash", reasoningEffort: "medium" as const },
        { providerId: "codex", model: "gpt-5.5" },
      ];
      const saved = store.saveAgentProfile(ctx, {
        requestId: randomUUID(),
        expectedRevision: agent.revision,
        agentId: agent.id,
        name: agent.name,
        state: "active",
        version: { ...draft, policyVersionId: policyId, fallbackModels: reserves },
      });
      if (!saved.ok) throw new Error(saved.error.message);
      expect(saved.value.version.id).not.toBe(versionId);
      expect(store.getAgentVersion(saved.value.version.id)?.fallbackModels).toEqual(reserves);
      // The first version is history: it keeps no reserves.
      expect(store.getAgentVersion(versionId)?.fallbackModels).toBeUndefined();

      const same = store.saveAgentProfile(ctx, {
        requestId: randomUUID(),
        expectedRevision: saved.value.agent.revision,
        agentId: agent.id,
        name: agent.name,
        state: "active",
        version: { ...draft, version: 3, policyVersionId: policyId, fallbackModels: reserves },
      });
      if (!same.ok) throw new Error(same.error.message);
      expect(same.value.version.id).toBe(saved.value.version.id);

      const reordered = store.saveAgentProfile(ctx, {
        requestId: randomUUID(),
        expectedRevision: same.value.agent.revision,
        agentId: agent.id,
        name: agent.name,
        state: "active",
        version: { ...draft, version: 3, policyVersionId: policyId, fallbackModels: [reserves[1]!, reserves[0]!] },
      });
      if (!reordered.ok) throw new Error(reordered.error.message);
      expect(reordered.value.version.id).not.toBe(saved.value.version.id);
      expect(store.getAgentVersion(reordered.value.version.id)?.fallbackModels?.map((item) => item.model)).toEqual(["gpt-5.5", "gemini-3.8-flash"]);
    } finally {
      close();
    }
  });

  it("refuses a reserve on a CLI the policy does not allow, and a repeat of the primary", () => {
    const { db, close } = openFileDb();
    try {
      const { store, ctx, policyId, agent } = seed(db);
      const base = { expectedRevision: agent.revision, agentId: agent.id, name: agent.name, state: "active" as const };
      const foreign = store.saveAgentProfile(ctx, {
        requestId: randomUUID(),
        ...base,
        version: { ...draft, policyVersionId: policyId, fallbackModels: [{ providerId: "cursor", model: "grok-4.6" }] },
      });
      expect(foreign.ok).toBe(false);
      if (!foreign.ok) expect(foreign.error.code).toBe("provider_not_allowed_by_policy");
      const repeat = store.saveAgentProfile(ctx, {
        requestId: randomUUID(),
        ...base,
        version: { ...draft, policyVersionId: policyId, fallbackModels: [{ providerId: "codex", model: "gpt-5.4" }] },
      });
      expect(repeat.ok).toBe(false);
      if (!repeat.ok) expect(repeat.error.code).toBe("invalid_command");
    } finally {
      close();
    }
  });

  it("reads a single reserve written before the list existed as the first entry", () => {
    const { db, close } = openFileDb();
    try {
      const { store, versionId } = seed(db);
      // agency_agent_version is append-only; a legacy row is a new row with the retired columns set.
      db.prepare(
        `INSERT INTO agency_agent_version (id, agent_id, version, role, instructions, provider_id, model, skill_ids, mcp_ids, policy_version_id, fallback_provider_id, fallback_model, fallback_reasoning_effort)
         SELECT 'ver_legacy01', agent_id, 99, role, instructions, provider_id, model, skill_ids, mcp_ids, policy_version_id, 'opencode', 'gemini-3.8-flash', 'medium'
         FROM agency_agent_version WHERE id = ?`,
      ).run(versionId);
      expect(store.getAgentVersion("ver_legacy01")?.fallbackModels).toEqual([
        { providerId: "opencode", model: "gemini-3.8-flash", reasoningEffort: "medium" },
      ]);
    } finally {
      close();
    }
  });
});
