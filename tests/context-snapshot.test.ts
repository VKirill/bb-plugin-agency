import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AGENCY_SKILL_COMMANDS,
  canonicalizeJson,
  compileContextSnapshot,
  computeHandoffHash,
  RunLauncherAdapterNotImplementedError,
  runLauncherAdapter,
  sha256Hex,
  type CompileContextSnapshotInput,
} from "../src/server/runtime/context-snapshot";
import type { CatalogMcpId, CatalogSkillId } from "../src/shared/contracts/ids";
import type { ArtifactVersion } from "../src/shared/contracts/artifact";
import type { Job } from "../src/shared/contracts/job";
import type { ProjectBinding } from "../src/shared/contracts/project-binding";
import type { AgentVersion, PolicyVersion, ProcessVersion } from "../src/shared/contracts/versions";

const AGENCY_SKILL =
  "skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff" as CatalogSkillId;
const HELPER_SKILL = `skill_${"b".repeat(64)}` as CatalogSkillId;
const METHOD_SKILL = `skill_${"c".repeat(64)}` as CatalogSkillId;
const EXTRA_SKILL = `skill_${"d".repeat(64)}` as CatalogSkillId;
const UNUSED_MCP = `mcp_${"e".repeat(64)}` as CatalogMcpId;
const SELECTED_MCP = `mcp_${"f".repeat(64)}` as CatalogMcpId;

const binding: ProjectBinding = {
  id: "bnd_selfy001",
  bbProjectId: "proj_trusted",
  environmentId: "env_ucx7sb57rs",
  hostId: "host_mini",
  canonicalRoot: "/Users/vechkasov/Documents/SelfyStudio",
  policyVersionId: "pol_bind0001",
  sectionId: null,
  revision: 2,
  updatedAt: "2026-09-14T00:00:00Z",
};

const job: Job = {
  id: "job_brief001",
  key: "AG-102",
  bindingId: "bnd_selfy001",
  departmentId: "dep_abcd1234",
  title: "Бриф посадочной",
  brief: "Собрать бриф",
  acceptance: "Есть принятая версия файла",
  state: "queued",
  parentJobId: "job_parent01",
  assignedAgentId: "agt_writer01",
  reviewerAgentIds: [],
  observerAgentIds: [],
  priority: "normal",
  dueAt: null,
  revision: 3,
  updatedAt: "2026-09-14T00:01:00Z",
};

const bindingPolicy: PolicyVersion = {
  id: "pol_bind0001",
  allowedCapabilities: ["write.files", "read.files"],
  cliHostConstraints: { providerIds: ["codex", "claude"], hostIds: ["host_mini"] },
  secretRefs: ["API_TOKEN", "SHARED_KEY"],
};

const agentPolicy: PolicyVersion = {
  id: "pol_agent001",
  allowedCapabilities: ["read.files"],
  cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_mini", "host_book"] },
  secretRefs: ["API_TOKEN"],
};

const agentVersion: AgentVersion = {
  id: "avr_writer01",
  agentId: "agt_writer01",
  version: 1,
  role: "Копирайтер",
  instructions: "Пиши бриф по фактам входов",
  providerId: "codex",
  model: "gpt-5",
  skillIds: [METHOD_SKILL],
  mcpIds: [],
  policyVersionId: "pol_agent001",
};

const processVersion: ProcessVersion = {
  id: "prc_00000001",
  departmentId: "dep_abcd1234",
  instructions: "Сначала входы, потом черновик",
  acceptance: "Есть принятый файл",
  reviewPolicy: { required: true },
};

const projectRulesText = "Писать только в canonicalRoot. Не публиковать секреты.";
const projectRulesHash = sha256Hex(projectRulesText);

function catalogHash(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

function skillEntry(id: CatalogSkillId, name: string, source = "plugin:agency") {
  return { id, hash: catalogHash(id), name, source };
}

function mcpEntry(id: CatalogMcpId, source = "bb-user") {
  return { id, hash: catalogHash(id), source };
}

function artifact(overrides: Partial<ArtifactVersion> = {}): ArtifactVersion {
  return {
    artifactId: "art_brief001",
    jobId: "job_brief001",
    version: 1,
    hostId: "host_mini",
    relativePath: "briefs/offer.md",
    mime: "text/markdown",
    size: 120,
    hash: "a".repeat(64),
    author: { kind: "system" },
    ...overrides,
  };
}

function inputRef(item: ArtifactVersion) {
  return {
    artifactId: item.artifactId,
    version: item.version,
    hash: item.hash,
    jobId: item.jobId,
    hostId: item.hostId,
    relativePath: item.relativePath,
  };
}

function handoffPackage(overrides: Partial<Parameters<typeof computeHandoffHash>[0]> = {}) {
  const body = {
    priorRunAttemptId: "run_00000001",
    fromSnapshotDigest: "1".repeat(64),
    acceptedArtifacts: [inputRef(artifact())],
    openQuestions: ["Нужен тон?"],
    returnReason: null as string | null,
    ...overrides,
  };
  return { ...body, hash: computeHandoffHash(body) };
}

function baseInput(overrides: Partial<CompileContextSnapshotInput> = {}): CompileContextSnapshotInput {
  return {
    binding,
    job,
    agentVersion,
    processVersion,
    bindingPolicyVersion: bindingPolicy,
    agentPolicyVersion: agentPolicy,
    projectRules: {
      versionId: "rul_project1",
      text: projectRulesText,
      hash: projectRulesHash,
    },
    inputArtifactVersions: [artifact()],
    authorizedInputJobIds: ["job_parent01"],
    catalogSkills: [
      skillEntry(EXTRA_SKILL, "unused-method"),
      skillEntry(METHOD_SKILL, "copy-method"),
      skillEntry(HELPER_SKILL, "ru-check"),
      skillEntry(AGENCY_SKILL, "agency"),
    ],
    catalogMcps: [mcpEntry(UNUSED_MCP)],
    coreSkillIds: [AGENCY_SKILL],
    helperSkillIds: [HELPER_SKILL],
    providerLimits: { contextWindow: 128000, maxOutputTokens: 8192 },
    handoff: null,
    ...overrides,
  };
}

function compileOk(input: CompileContextSnapshotInput = baseInput()) {
  const result = compileContextSnapshot(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.snapshot;
}

describe("compileContextSnapshot schema 2", () => {
  it("compiles launch fields: model, two policies, MCP none, explicit handoff none", () => {
    const snapshot = compileOk();

    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.binding).toMatchObject({
      id: "bnd_selfy001",
      hostId: "host_mini",
      bbProjectId: "proj_trusted",
      environmentId: "env_ucx7sb57rs",
      policyVersionId: "pol_bind0001",
    });
    expect(snapshot.agentVersion.model).toBe("gpt-5");
    expect(snapshot.policy.binding.id).toBe("pol_bind0001");
    expect(snapshot.policy.agent.id).toBe("pol_agent001");
    expect(snapshot.policy.effective.allowedCapabilities).toEqual(["read.files"]);
    expect(snapshot.policy.effective.secretGrants).toEqual(["API_TOKEN"]);
    expect(snapshot.policy.effective.secretDependencies).toEqual(["API_TOKEN", "SHARED_KEY"]);
    expect(JSON.stringify(snapshot)).not.toContain("secret-value");
    expect(snapshot.selectedMcps).toEqual([]);
    expect(snapshot.handoff).toBeNull();
    expect(snapshot.prompt.levels.handoff).toBe("handoff none");
    expect(snapshot.prompt.levels.agent).toContain("model=gpt-5");
    expect(snapshot.prompt.levels.agent).toContain("MCP none");
    expect(snapshot.execution).toBeUndefined();
    expect("execution" in snapshot).toBe(false);
    expect(snapshot.provenance).toEqual({ recordsVerifiedBy: "caller", compilerAttestsAuth: false });
    expect(snapshot.selectedSkills.map((skill) => skill.id)).toEqual([AGENCY_SKILL, HELPER_SKILL, METHOD_SKILL]);
    expect(snapshot.inputArtifacts[0]).toMatchObject({
      artifactId: "art_brief001",
      jobId: "job_brief001",
      hostId: "host_mini",
      relativePath: "briefs/offer.md",
    });
    for (const command of AGENCY_SKILL_COMMANDS) {
      expect(snapshot.prompt.levels.agency).toContain(command);
    }
    expect(() => {
      snapshot.selectedSkills.push({ id: EXTRA_SKILL, hash: catalogHash(EXTRA_SKILL), role: "method" });
    }).toThrow();
  });

  it("changes digest when model changes", () => {
    const a = compileOk();
    const b = compileOk(baseInput({ agentVersion: { ...agentVersion, model: "gpt-5.1" } }));
    expect(b.agentVersion.model).toBe("gpt-5.1");
    expect(b.digest).not.toBe(a.digest);
  });

  it("puts the agency rules on top of the agency layer and pins their version", () => {
    const plain = compileOk();
    expect("agencyRules" in plain).toBe(false);
    const ruled = compileOk(baseInput({ agencyRules: { versionId: "rul_v2", version: 2, hash: "ab".repeat(32), text: "Секреты не печатать." } }));
    expect(ruled.agencyRules).toEqual({ versionId: "rul_v2", hash: "ab".repeat(32) });
    expect(ruled.prompt.levels.agency.startsWith("agencyRules version=2")).toBe(true);
    expect(ruled.prompt.levels.agency).toContain("Секреты не печатать.");
    expect(ruled.digest).not.toBe(plain.digest);
  });

  it("pins the execution contract in the job prompt and the digest, and leaves contract-less jobs unchanged", () => {
    const plain = compileOk();
    expect("contractHash" in plain.job).toBe(false);
    expect(plain.prompt.levels.job).not.toContain("Execution contract");
    const bound = compileOk(baseInput({ job: { ...job, contract: { mayChange: ["src/cards/**"], mustNotTouch: ["src/billing/**"], checks: ["npm test"] } } }));
    expect(bound.job.contractHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bound.prompt.levels.job).toContain("Нельзя трогать:\n- src/billing/**");
    expect(bound.digest).not.toBe(plain.digest);
  });

  it("freezes AgentVersion reasoningEffort as spawn reasoningLevel without writing it into prompt", () => {
    const without = compileOk();
    const withEffort = compileOk(baseInput({
      agentVersion: { ...agentVersion, reasoningEffort: "medium" },
    }));
    expect(withEffort.execution).toEqual({ reasoningLevel: "medium" });
    expect(withEffort.prompt.levels.agent).not.toContain("reasoningLevel");
    expect(withEffort.prompt.levels.job).not.toContain("reasoningLevel");
    expect(JSON.stringify(withEffort.prompt)).not.toContain("medium");
    expect(withEffort.digest).not.toBe(without.digest);
    expect(without.execution).toBeUndefined();
  });

  it("records selected MCP hash in snapshot and digest", () => {
    const without = compileOk();
    const withMcp = compileOk(
      baseInput({
        agentVersion: { ...agentVersion, mcpIds: [SELECTED_MCP] },
        catalogMcps: [mcpEntry(UNUSED_MCP), mcpEntry(SELECTED_MCP)],
      }),
    );
    expect(withMcp.selectedMcps).toEqual([{ id: SELECTED_MCP, hash: catalogHash(SELECTED_MCP) }]);
    expect(withMcp.prompt.levels.agent).toContain(`MCP ${SELECTED_MCP} hash=${catalogHash(SELECTED_MCP)}`);
    expect(withMcp.digest).not.toBe(without.digest);
    expect(withMcp.exclusions.some((item) => item.id === UNUSED_MCP)).toBe(true);
    expect(
      compileContextSnapshot(baseInput({ agentVersion: { ...agentVersion, mcpIds: [SELECTED_MCP] } })),
    ).toMatchObject({ ok: false, error: { code: "unknown_mcp" } });
  });

  it("keeps effective capabilities in snapshot and changes digest when they change", () => {
    const a = compileOk();
    const b = compileOk(
      baseInput({
        agentPolicyVersion: { ...agentPolicy, allowedCapabilities: ["read.files", "write.files"] },
      }),
    );
    expect(a.policy.effective.allowedCapabilities).toEqual(["read.files"]);
    expect(b.policy.effective.allowedCapabilities).toEqual(["read.files", "write.files"]);
    expect(b.digest).not.toBe(a.digest);
  });

  it("allows different policy ids with the same payload", () => {
    const samePayload: PolicyVersion = { ...bindingPolicy, id: "pol_agent001" };
    const snapshot = compileOk(
      baseInput({
        agentPolicyVersion: samePayload,
        agentVersion: { ...agentVersion, policyVersionId: "pol_agent001" },
      }),
    );
    expect(snapshot.policy.binding.contentHash).toBe(snapshot.policy.agent.contentHash);
    expect(snapshot.policy.effective.allowedCapabilities).toEqual(["read.files", "write.files"]);
  });

  it("intersects policy payloads and fails on empty capability intersection", () => {
    expect(compileOk().policy.effective.cliHostConstraints.providerIds).toEqual(["codex"]);
    expect(
      compileContextSnapshot(
        baseInput({
          agentPolicyVersion: { ...agentPolicy, allowedCapabilities: ["notify.send"] },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "policy_effective_empty" } });
  });

  it("fails when two non-empty constraint lists are disjoint instead of treating [] as unrestricted", () => {
    expect(
      compileContextSnapshot(
        baseInput({
          agentPolicyVersion: {
            ...agentPolicy,
            cliHostConstraints: { providerIds: ["claude"], hostIds: ["host_mini"] },
          },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "provider_constraint_mismatch" } });
    expect(
      compileContextSnapshot(
        baseInput({
          agentPolicyVersion: {
            ...agentPolicy,
            cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_book"] },
          },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "host_constraint_mismatch" } });
  });

  it("intersects secret grants and does not union them into a hidden grant", () => {
    const snapshot = compileOk();
    expect(snapshot.policy.effective.secretGrants).toEqual(["API_TOKEN"]);
    expect(snapshot.policy.effective.secretDependencies).toContain("SHARED_KEY");
    expect(snapshot.policy.effective.secretGrants).not.toContain("SHARED_KEY");
    expect(
      compileContextSnapshot(
        baseInput({
          agentPolicyVersion: { ...agentPolicy, secretRefs: ["OTHER_KEY"] },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "secret_grant_mismatch" } });
    const malformedName = compileContextSnapshot(
      baseInput({
        agentPolicyVersion: { ...agentPolicy, secretRefs: ["not-a-name"] },
      }),
    );
    expect(malformedName).toMatchObject({ ok: false, error: { code: "secret_ref_name_invalid" } });
  });

  it("redacts invalid secretRefs entries and does not claim secret detection", () => {
    const sentinel = "API_TOKEN=sentinel-secret-do-not-echo-9f3a2c1b";
    const result = compileContextSnapshot(
      baseInput({
        agentPolicyVersion: { ...agentPolicy, secretRefs: [sentinel] },
      }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "secret_ref_name_invalid" } });
    if (result.ok) throw new Error("expected fail");
    expect(result.error.message).toMatch(/secretRefs\[\d+] is not a valid name/);
    expect(result.error.message).not.toMatch(/secret value|detected|распозна/i);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("sentinel-secret-do-not-echo");
    expect(serialized).not.toContain("9f3a2c1b");
  });

  it("allows parent-job artifacts only when authorized and rejects strangers", () => {
    const parentArt = artifact({
      artifactId: "art_parent01",
      jobId: "job_parent01",
      relativePath: "briefs/parent.md",
      hash: "b".repeat(64),
    });
    const ok = compileOk(baseInput({ inputArtifactVersions: [artifact(), parentArt] }));
    expect(ok.inputArtifacts.map((item) => item.jobId).sort()).toEqual(["job_brief001", "job_parent01"]);
    expect(
      compileContextSnapshot(
        baseInput({
          inputArtifactVersions: [artifact({ jobId: "job_other001" })],
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "artifact_job_unauthorized" } });
  });

  it("distinguishes explicit handoff none from a prior package and checks identity not only hash", () => {
    const none = compileOk();
    const packed = compileOk(baseInput({ handoff: handoffPackage() }));
    expect(none.digest).not.toBe(packed.digest);
    expect(packed.prompt.levels.handoff).toContain("run_00000001");
    expect(packed.prompt.levels.handoff).not.toContain("handoff/");
    expect(compileContextSnapshot(baseInput({ handoff: { ...handoffPackage(), hash: "0".repeat(64) } }))).toMatchObject({
      ok: false,
      error: { code: "handoff_hash_mismatch" },
    });
    expect(
      compileContextSnapshot(
        baseInput({
          handoff: handoffPackage({
            acceptedArtifacts: [inputRef(artifact({ jobId: "job_other001", hash: "a".repeat(64) }))],
          }),
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "handoff_artifact_unauthorized" } });
    expect(
      compileContextSnapshot(
        baseInput({
          handoff: {
            priorRunAttemptId: "run_00000001",
            fromSnapshotDigest: "",
            acceptedArtifacts: [],
            openQuestions: [],
            returnReason: null,
            hash: "0".repeat(64),
          },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "handoff_required_fields" } });
  });

  it("fails catalog provenance conflicts and is stable under catalog/allowlist shuffle", () => {
    expect(
      compileContextSnapshot(
        baseInput({
          catalogSkills: [skillEntry(AGENCY_SKILL, "agency", "plugin:agency"), skillEntry(AGENCY_SKILL, "agency", "bb-user")],
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "catalog_skill_provenance_conflict" } });

    const first = compileOk();
    const shuffledPolicies = compileOk(
      baseInput({
        bindingPolicyVersion: {
          ...bindingPolicy,
          allowedCapabilities: ["read.files", "write.files"],
          secretRefs: ["SHARED_KEY", "API_TOKEN"],
          cliHostConstraints: { providerIds: ["claude", "codex"], hostIds: ["host_mini"] },
        },
        catalogSkills: [...baseInput().catalogSkills].reverse(),
        catalogMcps: [mcpEntry(UNUSED_MCP)],
      }),
    );
    expect(shuffledPolicies.digest).toBe(first.digest);
    expect(shuffledPolicies.policy.effective.allowedCapabilities).toEqual(first.policy.effective.allowedCapabilities);
  });

  it("does not inject the whole catalog and keeps relation fail-closed", () => {
    const snapshot = compileOk();
    expect(snapshot.selectedSkills.some((skill) => skill.id === EXTRA_SKILL)).toBe(false);
    expect(snapshot.exclusions.some((item) => item.id === EXTRA_SKILL)).toBe(true);
    expect(compileContextSnapshot(baseInput({ job: { ...job, bindingId: "bnd_other001" } }))).toMatchObject({
      ok: false,
      error: { code: "binding_mismatch" },
    });
    expect(compileContextSnapshot(baseInput({ job: { ...job, assignedAgentId: null } }))).toMatchObject({
      ok: false,
      error: { code: "assignee_required" },
    });
    expect(
      compileContextSnapshot(baseInput({ agentVersion: { ...agentVersion, policyVersionId: "pol_other001" } })),
    ).toMatchObject({ ok: false, error: { code: "policy_mismatch" } });
    expect(compileContextSnapshot(baseInput({ coreSkillIds: [`skill_${"1".repeat(64)}`] }))).toMatchObject({
      ok: false,
      error: { code: "unknown_skill" },
    });
    expect(
      compileContextSnapshot(baseInput({ inputArtifactVersions: [artifact({ hostId: "host_other" })] })),
    ).toMatchObject({ ok: false, error: { code: "host_mismatch" } });
  });
});

describe("runLauncherAdapter contract", () => {
  it("is not implemented and does not persist or launch", async () => {
    expect(runLauncherAdapter.status).toBe("not_implemented");
    await expect(runLauncherAdapter.persistSnapshot({ snapshot: compileOk() })).rejects.toBeInstanceOf(
      RunLauncherAdapterNotImplementedError,
    );
    await expect(
      runLauncherAdapter.launchPreparedRun({ snapshotId: "snp_00000001", digest: "a".repeat(64) }),
    ).rejects.toMatchObject({ code: "run_launcher_not_implemented" });
  });
});

describe("compileContextSnapshot plugins", () => {
  const withPlugin = { ...agentVersion, pluginIds: ["file-gateway"] };

  it("keeps snapshots without plugins unchanged", () => {
    const snapshot = compileOk();
    expect(snapshot.plugins).toBeUndefined();
    expect(snapshot.prompt.levels.agent).not.toContain("BB plugins for this launch");
  });

  it("delivers a selected plugin's tools and skills and names them in the agent layer", () => {
    const snapshot = compileOk(
      baseInput({
        agentVersion: withPlugin,
        pluginGrants: [{ pluginId: "file-gateway", toolNames: ["bb_file_gateway"], skillIds: [EXTRA_SKILL] }],
      }),
    );
    expect(snapshot.plugins).toEqual({ ids: ["file-gateway"], toolNames: ["bb_file_gateway"] });
    expect(snapshot.selectedSkills.map((skill) => skill.id)).toContain(EXTRA_SKILL);
    expect(snapshot.prompt.levels.agent).toContain("BB plugins for this launch: file-gateway. Allowed tools: bb_file_gateway.");
    expect(snapshot.digest).not.toBe(compileOk(baseInput({ agentVersion: withPlugin })).digest);
  });

  it("refuses a plugin the profile does not select", () => {
    const result = compileContextSnapshot(
      baseInput({ pluginGrants: [{ pluginId: "env-catalog", toolNames: ["env_get"], skillIds: [] }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("plugin_not_selected");
  });
});

describe("compileContextSnapshot placement", () => {
  it("writes other folders, workplaces and the main job's folder into the job layer", () => {
    const plain = compileOk();
    expect(plain.prompt.levels.job).not.toContain("Other folders of this project");
    const snapshot = compileOk(
      baseInput({
        placement: {
          projectFolders: [{ bindingId: "bnd_mini0001", hostId: "host_mini", root: "/Users/me/site" }],
          workplaces: [{ agentId: "agt_tester01", name: "Тестировщик", bindingId: "bnd_desk0001", hostId: "host_mini", root: "/Users/me/desk" }],
          parentFolder: { jobKey: "AG-10", bindingId: "bnd_ovh00001", hostId: "host_ovh", root: "/home/app" },
        },
      }),
    );
    expect(snapshot.prompt.levels.job).toContain("folder bindingId=bnd_mini0001 host=host_mini root=/Users/me/site");
    expect(snapshot.prompt.levels.job).toContain("workplace Тестировщик agent=agt_tester01 bindingId=bnd_desk0001");
    expect(snapshot.prompt.levels.job).toContain("Main job AG-10 lives in another folder: bindingId=bnd_ovh00001 host=host_ovh root=/home/app.");
    expect(snapshot.digest).not.toBe(plain.digest);
  });
});

describe("compileContextSnapshot role", () => {
  it("puts the role guidance before the brief in the job layer", () => {
    const snapshot = compileOk(baseInput({ roleInstructions: "## Your role: executor of AG-1\n- Hand in a version." }));
    const layer = snapshot.prompt.levels.job;
    expect(layer.indexOf("## Your role: executor of AG-1")).toBeLessThan(layer.indexOf("## Brief"));
    expect(compileOk().prompt.levels.job).not.toContain("## Brief");
  });
});
