import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileContextSnapshot,
  PROMPT_LAYER_ORDER,
  PROMPT_PRECEDENCE_DEPARTMENT,
  PROMPT_PRECEDENCE_JOB,
  sha256Hex,
} from "../src/server/runtime/context-snapshot";
import type { CatalogSkillId } from "../src/shared/contracts/ids";
import type { ArtifactVersion } from "../src/shared/contracts/artifact";
import type { CompileContextSnapshotInput } from "../src/server/runtime/context-snapshot";

const root = join(import.meta.dirname, "..");

function readDoc(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

const AGENCY_SKILL =
  "skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff" as CatalogSkillId;
const HELPER_SKILL = `skill_${"b".repeat(64)}` as CatalogSkillId;

function catalogHash(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

const input = {
  binding: {
    id: "bnd_selfy001",
    bbProjectId: "proj_trusted",
    environmentId: "env_ucx7sb57rs",
    hostId: "host_mini",
    canonicalRoot: "/tmp/agency-contract",
    policyVersionId: "pol_bind0001",
    sectionId: null,
    revision: 1,
    updatedAt: "2026-09-14T00:00:00Z",
  },
  job: {
    id: "job_brief001",
    key: "AG-102",
    bindingId: "bnd_selfy001",
    departmentId: "dep_abcd1234",
    title: "Бриф",
    brief: "Собрать бриф",
    acceptance: "path notes/job-file.md marker JOB_OK",
    state: "queued" as const,
    parentJobId: null,
    assignedAgentId: "agt_writer01",
    priority: "normal" as const,
    dueAt: null,
    revision: 1,
    updatedAt: "2026-09-14T00:00:00Z",
  },
  agentVersion: {
    id: "avr_writer01",
    agentId: "agt_writer01",
    version: 1,
    role: "Автор",
    instructions: "Пиши по входам",
    providerId: "codex",
    model: "gpt-5",
    skillIds: [] as CatalogSkillId[],
    mcpIds: [],
    policyVersionId: "pol_agent001",
  },
  processVersion: {
    id: "prc_00000001",
    departmentId: "dep_abcd1234",
    instructions: "Этапы отдела",
    acceptance: "schema agency-artifact/1.0; publish via Agency CLI",
    reviewPolicy: { required: true },
  },
  bindingPolicyVersion: {
    id: "pol_bind0001",
    allowedCapabilities: ["read.files"],
    cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_mini"] },
    secretRefs: [],
  },
  agentPolicyVersion: {
    id: "pol_agent001",
    allowedCapabilities: ["read.files"],
    cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_mini"] },
    secretRefs: [],
  },
  projectRules: { versionId: "prv_1", text: "Правила проекта", hash: sha256Hex("Правила проекта") },
  inputArtifactVersions: [] as ArtifactVersion[],
  authorizedInputJobIds: [],
  catalogSkills: [
    { id: AGENCY_SKILL, hash: catalogHash(AGENCY_SKILL), source: "plugin:agency" },
    { id: HELPER_SKILL, hash: catalogHash(HELPER_SKILL), source: "plugin:agency-artifacts" },
  ],
  catalogMcps: [],
  coreSkillIds: [AGENCY_SKILL],
  helperSkillIds: [HELPER_SKILL],
  providerLimits: {},
  handoff: null,
} satisfies CompileContextSnapshotInput;

describe("instruction contract", () => {
  it("keeps the rule and both sources in agency references and docs", () => {
    const organization = readDoc("skills/agency/references/organization.md");
    const job = readDoc("skills/agency/references/job.md");
    const context = readDoc("docs/instruction-context.md");
    expect(organization).toContain("ProcessVersion.acceptance");
    expect(organization).toContain("не отменяет");
    expect(organization).toContain("Job.acceptance");
    expect(job).toContain("processVersion id");
    expect(job).toContain("needs clarification");
    expect(job).toContain("не auto-pick");
    expect(job).toContain("Watcher");
    expect(job).toContain("waiting_input");
    expect(job).toContain("running");
    expect(context).toContain("prompt.levels.department");
    expect(context).toContain("waiting_input");
    expect(context).toContain("сравнивает эти тексты regex");
  });

  it("compiles both acceptances and precedence; does not compare them", () => {
    const compiled = compileContextSnapshot(input);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const department = compiled.snapshot.prompt.levels.department;
    const job = compiled.snapshot.prompt.levels.job;
    expect(PROMPT_LAYER_ORDER).toEqual([
      "platform",
      "agency",
      "project",
      "department",
      "agent",
      "job",
      "handoff",
    ]);
    expect(department).toContain(PROMPT_PRECEDENCE_DEPARTMENT);
    expect(department).toContain("prc_00000001");
    expect(department).toContain("schema agency-artifact/1.0; publish via Agency CLI");
    expect(job).toContain(PROMPT_PRECEDENCE_JOB);
    expect(job).toContain("job_brief001");
    expect(job).toContain("path notes/job-file.md marker JOB_OK");
    expect(job).toContain("does not cancel department");
    expect(job).toContain("Watcher does not set Job.waiting_input");
    expect(job).toContain("end the current provider turn");
    expect(job).toContain("Do not open AskUserQuestion");
    const compileSource = readFileSync(
      join(root, "src/server/runtime/context-snapshot/compile.ts"),
      "utf8",
    );
    expect(compileSource).not.toMatch(/processVersion\.acceptance.*match\(/);
    expect(compileSource).not.toMatch(/new RegExp/);
  });
});
