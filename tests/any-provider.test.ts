import { describe, expect, it, vi } from "vitest";
import type { ContextSnapshot } from "../src/server/runtime/context-snapshot/types";
import { bindOfficialThreads } from "../src/server/runtime/isolated-sdk/bind-official-threads";
import { spawnArgsFromContract } from "../src/server/runtime/isolated-sdk/spawn-args";
import { machineDirectory } from "../src/server/runtime/machines";
import { policyForAnyCli, policyWithProvider, standardAgentPolicy } from "../src/app/data/role-types";
import { allowedRuleKeys, DEFAULT_WORK_RULES } from "../src/shared/contracts/work-rules";

vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => ({ call: async () => ({ ok: false }) }) }));
const { roleDefaultsFromRules } = await import("../src/app/prototype/use-role-defaults");

const contract = {
  snapshotId: "snp_aaaaaaaaaaaaaaaaaaaaaaaa",
  digest: "d".repeat(64),
  attemptId: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
  launchId: "11111111-1111-4111-8111-111111111111",
  providerId: "codex",
  model: "gpt-5.6-luna",
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
    prompt: { digest: "p".repeat(64), levels: { platform: "p", agency: "a", project: "pr", department: "d", agent: "ag", job: "Brief.", handoff: "" } },
    ...(execution ? { execution } : {}),
  }) as ContextSnapshot;

describe("any provider connected in BB", () => {
  it("sends the profile's CLI, reasoning and fast mode with explicit sources", async () => {
    const args = spawnArgsFromContract(contract, snapshot({ reasoningLevel: "low", serviceTier: "fast" }), "job_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(args.ok).toBe(true);
    if (!args.ok) return;
    expect(args.value).toMatchObject({ providerId: "codex", model: "gpt-5.6-luna", reasoningLevel: "low", serviceTier: "fast" });
    expect(args.value.executionInputSources).toEqual({ reasoningLevel: "explicit", serviceTier: "explicit" });
    const spawned: Record<string, unknown>[] = [];
    const threads = { spawn: async (input: Record<string, unknown>) => { spawned.push(input); return { id: "thr_1" }; }, get: async () => ({ id: "thr_1" }), list: async () => ({ threads: [] }) };
    await bindOfficialThreads(threads as never).spawn(args.value);
    // Without an explicit source BB would apply the project's remembered tier instead of the profile's.
    expect(spawned[0]).toMatchObject({
      providerId: "codex",
      serviceTier: "fast",
      executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", serviceTier: "explicit" },
    });
    const plain = spawnArgsFromContract({ ...contract, providerId: "claude-code", model: "claude-sonnet-5" }, snapshot(), "job_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(plain.ok && plain.value.serviceTier).toBeFalsy();
  });

  it("adds the chosen CLI to an older one-CLI policy and opens a project to any CLI, keeping files, machines and secrets", () => {
    const older = { allowedCapabilities: ["read.files", "write.files"], cliHostConstraints: { providerIds: ["claude-code"], hostIds: ["host_mini", "host_ovh"] }, secretRefs: ["GITHUB_TOKEN"] };
    expect(standardAgentPolicy().cliHostConstraints.providerIds).toEqual([]);
    expect(policyWithProvider(older, "codex")).toEqual({ ...older, cliHostConstraints: { providerIds: ["claude-code", "codex"], hostIds: ["host_mini", "host_ovh"] } });
    expect(policyWithProvider(older, "claude-code")).toBeNull();
    expect(policyWithProvider(standardAgentPolicy(), "acp-cursor")).toBeNull();
    expect(policyForAnyCli(older)).toEqual({ ...older, cliHostConstraints: { providerIds: [], hostIds: ["host_mini", "host_ovh"] } });
    expect(policyForAnyCli(standardAgentPolicy())).toBeNull();
    // A stored record carries its id: the new version is content only.
    expect(Object.keys(policyForAnyCli({ id: "pol_old00001", ...older } as typeof older)!)).toEqual(["allowedCapabilities", "cliHostConstraints", "secretRefs"]);
  });

  it("keeps a default CLI, model, reasoning and fast mode per role type in the agency rules", () => {
    expect(allowedRuleKeys("agency")).toEqual(expect.arrayContaining(["defaultProviderExecutor", "defaultServiceTierExecutor"]));
    expect(allowedRuleKeys("department:dep_aaaaaaaa")).not.toContain("defaultProviderExecutor");
    const defaults = roleDefaultsFromRules({ ...DEFAULT_WORK_RULES, defaultProviderExecutor: "codex", defaultModelExecutor: "gpt-5.6-luna", defaultReasoningExecutor: "low", defaultServiceTierExecutor: "fast" });
    expect(defaults.executor).toEqual({ providerId: "codex", model: "gpt-5.6-luna", reasoningLevel: "low", serviceTier: "fast" });
    expect(defaults.lead).toEqual({ providerId: "claude-code", model: DEFAULT_WORK_RULES.defaultModelLead, reasoningLevel: "high" });
  });

  it("names a CLI the machine does not have before the launch", async () => {
    const providers = [
      { id: "codex", displayName: "Codex", available: true },
      { id: "acp-cursor", displayName: "Cursor", available: false, strings: { signInHint: "Sign in to Cursor." } },
    ];
    const bb = {
      sdk: {
        hosts: {
          get: async () => ({ id: "host_mini", name: "Mac mini", status: "connected", lifecycle: { phase: "ready" } }),
          providerCliStatus: async () => ({}),
        },
        providers: { list: async () => providers },
      },
      storage: { kv: { get: async () => null } },
    };
    const machines = machineDirectory(bb as never);
    expect(await machines.checkLaunch({ hostId: "host_mini", providerId: "codex" })).toEqual({ ok: true, value: undefined });
    expect(await machines.checkLaunch({ hostId: "host_mini", providerId: "acp-opencode" })).toMatchObject({ ok: false, error: { code: "provider_unavailable" } });
    const cursor = await machines.checkLaunch({ hostId: "host_mini", providerId: "acp-cursor" });
    expect(cursor).toMatchObject({ ok: false, error: { code: "provider_unavailable" } });
    expect(!cursor.ok && cursor.error.message).toContain("Sign in to Cursor.");
  });
});
