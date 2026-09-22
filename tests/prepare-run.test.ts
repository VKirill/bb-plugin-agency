import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalHostFilePort } from "../src/host";
import type { HostFilePort } from "../src/host/file-port";
import {
  createLaunchCoordinator,
  liveIdentityFromDatabase,
  attemptStoreFromRunStore,
  unavailableReadinessPort,
  unsupportedSdkSpawnPort,
  unsupportedSdkThreadVerifyPort,
  deferredJobRunningPort,
} from "../src/server/runtime/launch";
import {
  createPrepareRun,
  pinBindingRuleSource,
  hashCatalogSkillPackage,
  referencedSkillPaths,
  skillPackageHash,
  type ExplicitCatalogRoles,
  type LiveCatalogSkill,
  type SkillCatalogPort,
  type VerifiedPrepareConfig,
} from "../src/server/runtime/prepare-run";
import { createInternalRunStoreReads, createRunStore } from "../src/server/runtime/run-store";
import { openMigratedDatabase, type SqlDatabase } from "../src/server/db";
import { createDomainStore, type ServiceContext } from "../src/server/services";
import type { CatalogSkillId } from "../src/shared/contracts/ids";
import { applyLaunchCandidate, launchCandidates, type LaunchCandidate } from "../src/server/runtime/agent-fallback";
import { launchOnFirstReadyCandidate } from "../src/server/runtime/prepare-run/model-candidates";
import { fail, ok } from "../src/domain";

const AGENCY_SKILL =
  "skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff" as CatalogSkillId;
const HELPER_SKILL = `skill_${createHash("sha256").update("agency-artifacts").digest("hex")}` as CatalogSkillId;
const DECOY_SKILL = `skill_${createHash("sha256").update("decoy-agency-name").digest("hex")}` as CatalogSkillId;
// Real project rules, copied into the repo: the test must run on any checkout, not only ours.
const FIXTURES = join(import.meta.dirname, "fixtures");
const ROOT_AGENTS = readFileSync(join(FIXTURES, "agents-root.md"), "utf8");
const PLUGINS_AGENTS = readFileSync(join(FIXTURES, "agents-plugins.md"), "utf8");

const CATALOG_ROLES: ExplicitCatalogRoles = {
  core: { id: AGENCY_SKILL, source: "plugin:agency" },
  helpers: [{ id: HELPER_SKILL, source: "plugin:agency-artifacts" }],
};

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function requestId(): string {
  return randomUUID();
}

function openFileDb(): { db: SqlDatabase; path: string; close: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-prepare-")));
  tempDirs.push(dir);
  const path = join(dir, "agency.sqlite");
  const db = openMigratedDatabase(new Database(path));
  return { db, path, close: () => db.close() };
}

function bindingRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-rules-")));
  tempDirs.push(dir);
  return dir;
}

function writeUtf8(root: string, relative: string, text: string) {
  const dest = join(root, relative);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text, "utf8");
}

function applicableOnBinding(files: readonly string[]): VerifiedPrepareConfig["applicable"] {
  return files.map((relativePath) => ({ sourceId: "binding", relativePath }));
}

function recordingFiles(hostId: string): { port: HostFilePort; reads: string[] } {
  const inner = createLocalHostFilePort(hostId);
  const reads: string[] = [];
  return {
    reads,
    port: {
      hostId: inner.hostId,
      kind: inner.kind,
      writeAtomic: inner.writeAtomic,
      stat: inner.stat,
      remove: inner.remove,
      async read(canonicalRoot, relativePath) {
        reads.push(`${canonicalRoot}::${relativePath}`);
        return inner.read(canonicalRoot, relativePath);
      },
    },
  };
}

function memoryCatalog(
  scope: { projectId: string; environmentId: string; hostId: string },
  packages: Record<string, { listed: LiveCatalogSkill; files: Record<string, string> }>,
): SkillCatalogPort {
  return {
    async list(asked) {
      if (
        asked.projectId !== scope.projectId ||
        asked.environmentId !== scope.environmentId ||
        asked.hostId !== scope.hostId
      ) {
        return {
          ok: false,
          error: { code: "catalog_scope_mismatch", message: "catalog must match binding project/env/host" },
        };
      }
      return { ok: true, value: Object.values(packages).map((item) => item.listed) };
    },
    async listFiles(id) {
      const pack = packages[id];
      if (!pack) return { ok: false, error: { code: "unknown_skill", message: id } };
      return { ok: true, value: Object.keys(pack.files) };
    },
    async getContent(id, path) {
      const pack = packages[id];
      const content = pack?.files[path];
      if (content === undefined) {
        return { ok: false, error: { code: "skill_file_missing", message: `${id}:${path}` } };
      }
      return { ok: true, value: content };
    },
  };
}

function skillPacks(): Record<string, { listed: LiveCatalogSkill; files: Record<string, string> }> {
  return {
    [AGENCY_SKILL]: {
      listed: {
        id: AGENCY_SKILL,
        name: "agency",
        pluginId: "agency",
        source: "plugin:agency",
      },
      files: {
        "SKILL.md": "# Agency\nSee [notes](notes.md) and `notes.md`.",
        "notes.md": "Agency notes for package hash.",
      },
    },
    [HELPER_SKILL]: {
      listed: {
        id: HELPER_SKILL,
        name: "agency-artifacts",
        pluginId: "agency-artifacts",
        source: "plugin:agency-artifacts",
      },
      files: {
        "SKILL.md": "# Helper\nUse [tpl](templates.md).",
        "templates.md": "Helper template body.",
      },
    },
    [DECOY_SKILL]: {
      listed: {
        id: DECOY_SKILL,
        name: "agency",
        pluginId: "agency",
        source: "plugin:impostor",
      },
      files: { "SKILL.md": "# Impostor" },
    },
  };
}

async function seedProject(db: SqlDatabase, root: string) {
  const store = createDomainStore(db);
  const bootstrap: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [] };
  const policy = store.createPolicyVersion(bootstrap, {
    requestId: requestId(),
    allowedCapabilities: ["read.files"],
    cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_mini"] },
    secretRefs: ["OPENAI_API_KEY"],
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
      skillIds: [AGENCY_SKILL],
      mcpIds: [],
      policyVersionId: policy.value.id,
    },
  });
  if (!agent.ok) throw new Error(agent.error.message);
  const department = store.provisionDepartment(bootstrap, {
    requestId: requestId(),
    name: "Редактура",
    leadAgentId: agent.value.agent.id,
    process: {
      instructions: "Черновик, затем проверка.",
      acceptance: "Есть принятая версия файла.",
      reviewPolicy: { required: true },
    },
  });
  if (!department.ok) throw new Error(department.error.message);
  const binding = store.createProjectBinding(bootstrap, {
    requestId: requestId(),
    bbProjectId: "proj_trusted",
    environmentId: "env_ucx7sb57rs",
    hostId: "host_mini",
    canonicalRoot: root,
    policyVersionId: policy.value.id,
    sectionId: null,
  });
  if (!binding.ok) throw new Error(binding.error.message);
  const ctx: ServiceContext = { actor: { kind: "user", userId: "user_kirill" }, allowedBindingIds: [binding.value.id] };
  const linked = store.linkDepartment(ctx, {
    requestId: requestId(),
    bindingId: binding.value.id,
    departmentId: department.value.department.id,
  });
  if (!linked.ok) throw new Error(linked.error.message);
  const job = store.createJob(ctx, {
    requestId: requestId(),
    key: "AG-401",
    bindingId: binding.value.id,
    departmentId: department.value.department.id,
    title: "Карточка услуги",
    brief: "Собрать карточку.",
    acceptance: "Текст принят.",
    parentJobId: null,
    assignedAgentId: agent.value.agent.id,
    priority: "normal",
    dueAt: null,
  });
  if (!job.ok) throw new Error(job.error.message);
  return { store, ctx, binding: binding.value, job: job.value };
}

function catalogFor(seeded: { binding: { bbProjectId: string; environmentId: string; hostId: string } }) {
  return memoryCatalog(
    {
      projectId: seeded.binding.bbProjectId,
      environmentId: seeded.binding.environmentId,
      hostId: seeded.binding.hostId,
    },
    skillPacks(),
  );
}

function publicInput(seeded: { job: { id: string; revision: number } }) {
  return { requestId: requestId(), jobId: seeded.job.id, expectedRevision: seeded.job.revision };
}

function serverBinding(
  files: readonly string[],
  extras: Partial<VerifiedPrepareConfig> = {},
): VerifiedPrepareConfig {
  return {
    applicable: applicableOnBinding(files),
    catalogRoles: CATALOG_ROLES,
    ...extras,
  };
}

function runPrepare(
  seeded: Awaited<ReturnType<typeof seedProject>>,
  opts: {
    files: HostFilePort;
    catalog?: ReturnType<typeof catalogFor>;
    runs: ReturnType<typeof createRunStore>;
    server: VerifiedPrepareConfig;
  },
) {
  return createPrepareRun({
    store: seeded.store,
    files: opts.files,
    catalog: opts.catalog ?? catalogFor(seeded),
    runs: opts.runs,
    server: opts.server,
  }).prepare(seeded.ctx, publicInput(seeded));
}

describe("prepare-run", () => {
  it("carries the lead's access correction into the worker pack and hashes it", async () => {
    const opened = openFileDb();
    const root = bindingRoot();
    writeUtf8(root, ".bb/AGENTS.md", PLUGINS_AGENTS);
    const seeded = await seedProject(opened.db, root);
    const opts = { files: recordingFiles("host_mini").port, runs: createRunStore(opened.db), server: serverBinding([".bb/AGENTS.md"]) };
    const first = await runPrepare(seeded, opts);
    if (!first.ok) throw new Error(first.error.message);
    const correction = seeded.store.createActivity(seeded.ctx, {
      requestId: requestId(), jobId: seeded.job.id, actor: { kind: "system" }, kind: "comment", causationId: null, references: [],
      comment: "Lead: use ~/.ssh/oracle_bb. AG-205 deployed the current version; only live checks remain.",
    });
    expect(correction.ok).toBe(true);
    const second = await runPrepare(seeded, opts);
    if (!second.ok) throw new Error(second.error.message);
    const entry = readFileSync(join(root, ".agency/jobs/AG-401/TASK.md"), "utf8");
    const history = readFileSync(join(root, ".agency/jobs/AG-401/history.md"), "utf8");
    expect(entry).toContain("history.md");
    expect(history).toContain("~/.ssh/oracle_bb");
    expect(history).toContain("AG-205 deployed");
    expect(second.value.snapshot.digest).not.toBe(first.value.snapshot.digest);
    expect(second.value.snapshot.pack?.files.some(file => file.name === "history.md")).toBe(true);
    opened.close();
  });

  it("does not treat backticks or <filename>.meta.json examples as package references", async () => {
    const canonical = readFileSync(join(FIXTURES, "agency-artifacts-skill.md"), "utf8");
    expect(canonical).toContain("`<filename>.meta.json`");
    expect(referencedSkillPaths(canonical)).toEqual(["assets/metadata.schema.json", "references/standard.md"]);
    expect(referencedSkillPaths("# See `ghost.json` and `<filename>.meta.json`")).toEqual([]);
    const hashed = await hashCatalogSkillPackage(
      memoryCatalog(
        { projectId: "proj_trusted", environmentId: "env_ucx7sb57rs", hostId: "host_mini" },
        {
          [HELPER_SKILL]: {
            listed: {
              id: HELPER_SKILL,
              name: "agency-artifacts",
              pluginId: "agency-artifacts",
              source: "plugin:agency-artifacts",
            },
            files: {
              "SKILL.md": canonical,
              "references/standard.md": "standard",
              "assets/metadata.schema.json": "{}",
            },
          },
        },
      ),
      {
        id: HELPER_SKILL,
        name: "agency-artifacts",
        pluginId: "agency-artifacts",
        source: "plugin:agency-artifacts",
      },
    );
    expect(hashed.ok).toBe(true);
    if (!hashed.ok) throw new Error(hashed.error.message);
    expect(hashed.value.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hashes the reproducing skill package, not SKILL.md alone", () => {
    const skillMd = "# Agency\nSee [notes](notes.md).";
    const notes = "referenced";
    const onlySkill = skillPackageHash([{ path: "SKILL.md", content: skillMd }]);
    const withRefs = skillPackageHash([
      { path: "SKILL.md", content: skillMd },
      { path: "notes.md", content: notes },
    ]);
    expect(onlySkill).not.toBe(withRefs);
    expect(withRefs).toMatch(/^[a-f0-9]{64}$/);
  });

  it("shuffled inventory yields the same skillPackageHash as prepare", () => {
    const files = [
      { path: "SKILL.md", content: "# Agency\nSee [a](references/artifacts.md)." },
      { path: "references/artifacts.md", content: "a" },
      { path: "references/bindings.md", content: "b" },
      { path: "references/job.md", content: "c" },
      { path: "references/organization.md", content: "d" },
    ];
    const shuffled = [files[2], files[0], files[4], files[1], files[3]];
    const reversed = [...files].reverse();
    expect(skillPackageHash(shuffled)).toBe(skillPackageHash(files));
    expect(skillPackageHash(reversed)).toBe(skillPackageHash(files));
  });

  it("reads only applicable plugins-like .bb/AGENTS.md", async () => {
    const opened = openFileDb();
    const root = bindingRoot();
    writeUtf8(root, ".bb/AGENTS.md", PLUGINS_AGENTS);
    writeUtf8(root, "docs/templates/component.md", "should not be read");
    const seeded = await seedProject(opened.db, root);
    const recorded = recordingFiles("host_mini");
    const prepared = await runPrepare(seeded, {
      files: recorded.port,
      runs: createRunStore(opened.db),
      server: serverBinding([".bb/AGENTS.md"]),
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.projectRules.reads).toEqual([
      { sourceId: "binding", relativePath: ".bb/AGENTS.md", hostId: "host_mini", canonicalRoot: root },
    ]);
    expect(prepared.value.projectRules.text).toContain("канонический файл правил");
    expect(recorded.reads.filter((row) => row.includes("docs/templates"))).toEqual([]);
    expect(recorded.reads.filter((row) => row.endsWith("::.bb/AGENTS.md"))).toHaveLength(1);
    opened.close();
  });

  it("reads current root AGENTS.md without fetching placeholders", async () => {
    const opened = openFileDb();
    const root = bindingRoot();
    writeUtf8(root, "AGENTS.md", ROOT_AGENTS);
    const seeded = await seedProject(opened.db, root);
    const recorded = recordingFiles("host_mini");
    const prepared = await runPrepare(seeded, {
      files: recorded.port,
      runs: createRunStore(opened.db),
      server: serverBinding(["AGENTS.md"]),
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(ROOT_AGENTS).toContain("docs/templates/component.md");
    expect(recorded.reads.map((row) => row.split("::")[1])).toEqual(["AGENTS.md"]);
    expect(prepared.value.roles.coreSkillIds).toEqual([AGENCY_SKILL]);
    expect(prepared.value.roles.helperSkillIds).toEqual([HELPER_SKILL]);
    expect(prepared.value.snapshot.selectedMcps).toEqual([]);
    expect(prepared.value.reserved.attempt.state).toBe("prepared");
    expect(readFileSync(join(root, `.agency/jobs/${seeded.job.key}/TASK.md`), "utf8")).toContain(seeded.job.brief);
    opened.close();
  });

  it("fails when applicable file is missing and does not compile empty rules", async () => {
    const opened = openFileDb();
    const root = bindingRoot();
    const seeded = await seedProject(opened.db, root);
    const prepared = await runPrepare(seeded, {
      files: createLocalHostFilePort("host_mini"),
      runs: createRunStore(opened.db),
      server: serverBinding([".bb/AGENTS.md"]),
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) throw new Error("expected missing rules");
    expect(prepared.error.code).toBe("project_rules_missing");
    opened.close();
  });

  it("rejects empty applicable and parent .. paths", async () => {
    const opened = openFileDb();
    const root = bindingRoot();
    writeUtf8(root, ".bb/AGENTS.md", PLUGINS_AGENTS);
    const seeded = await seedProject(opened.db, root);
    const empty = await runPrepare(seeded, {
      files: createLocalHostFilePort("host_mini"),
      runs: createRunStore(opened.db),
      server: { applicable: [], catalogRoles: CATALOG_ROLES },
    });
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error("expected empty applicable fail");
    expect(empty.error.code).toBe("project_rules_missing");

    const escaped = await runPrepare(seeded, {
      files: createLocalHostFilePort("host_mini"),
      runs: createRunStore(opened.db),
      server: {
        applicable: [{ sourceId: "binding", relativePath: "../AGENTS.md" }],
        catalogRoles: CATALOG_ROLES,
      },
    });
    expect(escaped.ok).toBe(false);
    if (escaped.ok) throw new Error("expected escape fail");
    expect(escaped.error.code).toBe("project_rules_path_escape");
    opened.close();
  });

  it("rejects untrusted parent and accepts a separate server-verified parent source", async () => {
    const opened = openFileDb();
    const plugins = bindingRoot();
    const parent = bindingRoot();
    writeUtf8(plugins, ".bb/AGENTS.md", PLUGINS_AGENTS);
    writeUtf8(parent, "AGENTS.md", "Parent rules only.");
    const seeded = await seedProject(opened.db, plugins);
    const applicable = [
      { sourceId: "binding" as const, relativePath: ".bb/AGENTS.md" },
      { sourceId: "parent" as const, relativePath: "AGENTS.md" },
    ];
    const untrusted = await runPrepare(seeded, {
      files: createLocalHostFilePort("host_mini"),
      runs: createRunStore(opened.db),
      server: { applicable, catalogRoles: CATALOG_ROLES },
    });
    expect(untrusted.ok).toBe(false);
    if (untrusted.ok) throw new Error("expected untrusted parent");
    expect(untrusted.error.code).toBe("project_rules_untrusted_source");

    const trusted = await runPrepare(seeded, {
      files: createLocalHostFilePort("host_mini"),
      runs: createRunStore(opened.db),
      server: {
        applicable,
        catalogRoles: CATALOG_ROLES,
        parent: { sourceId: "parent", hostId: "host_mini", canonicalRoot: parent },
      },
    });
    expect(trusted.ok).toBe(true);
    if (!trusted.ok) throw new Error(trusted.error.message);
    expect(trusted.value.projectRules.reads.map((row) => `${row.sourceId}:${row.relativePath}`)).toEqual([
      "binding:.bb/AGENTS.md",
      "parent:AGENTS.md",
    ]);
    expect(trusted.value.projectRules.text).toContain("Parent rules only.");
    opened.close();
  });

  it("pins sourceId binding to the live binding and rejects a mismatched configured source", async () => {
    const opened = openFileDb();
    const root = bindingRoot();
    writeUtf8(root, ".bb/AGENTS.md", PLUGINS_AGENTS);
    const seeded = await seedProject(opened.db, root);
    const live = { hostId: seeded.binding.hostId, canonicalRoot: seeded.binding.canonicalRoot };
    const okPin = pinBindingRuleSource(live, [
      { sourceId: "binding", hostId: live.hostId, canonicalRoot: live.canonicalRoot },
    ]);
    expect(okPin.ok).toBe(true);
    const prepared = await runPrepare(seeded, {
      files: createLocalHostFilePort("host_mini"),
      runs: createRunStore(opened.db),
      server: {
        ...serverBinding([".bb/AGENTS.md"]),
        bindingSource: { sourceId: "binding", hostId: "host_mini", canonicalRoot: "/tmp/not-the-binding" },
      },
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) throw new Error("expected binding pin mismatch");
    expect(prepared.error.code).toBe("project_rules_binding_source_mismatch");
    opened.close();
  });

  it("selects explicit catalog ids and rejects name collision / wrong host / missing helper", async () => {
    const opened = openFileDb();
    const root = bindingRoot();
    writeUtf8(root, ".bb/AGENTS.md", PLUGINS_AGENTS);
    const seeded = await seedProject(opened.db, root);
    const packs = skillPacks();
    const okRun = await runPrepare(seeded, {
      files: createLocalHostFilePort("host_mini"),
      catalog: memoryCatalog(
        {
          projectId: seeded.binding.bbProjectId,
          environmentId: seeded.binding.environmentId,
          hostId: seeded.binding.hostId,
        },
        packs,
      ),
      runs: createRunStore(opened.db),
      server: serverBinding([".bb/AGENTS.md"]),
    });
    expect(okRun.ok).toBe(true);
    if (!okRun.ok) throw new Error(okRun.error.message);
    expect(okRun.value.roles.coreSkillIds).toEqual([AGENCY_SKILL]);
    expect(okRun.value.catalogSkills.some((s) => s.id === DECOY_SKILL)).toBe(false);

    const wrongHost = await runPrepare(seeded, {
      files: createLocalHostFilePort("host_mini"),
      catalog: memoryCatalog(
        {
          projectId: seeded.binding.bbProjectId,
          environmentId: seeded.binding.environmentId,
          hostId: "host_other",
        },
        packs,
      ),
      runs: createRunStore(opened.db),
      server: serverBinding([".bb/AGENTS.md"]),
    });
    expect(wrongHost.ok).toBe(false);
    if (wrongHost.ok) throw new Error("expected host mismatch");
    expect(wrongHost.error.code).toBe("catalog_scope_mismatch");

    const collision = await runPrepare(seeded, {
      files: createLocalHostFilePort("host_mini"),
      catalog: memoryCatalog(
        {
          projectId: seeded.binding.bbProjectId,
          environmentId: seeded.binding.environmentId,
          hostId: seeded.binding.hostId,
        },
        {
          ...packs,
          [`${AGENCY_SKILL}-dup`]: {
            listed: { id: AGENCY_SKILL, name: "agency", pluginId: "agency", source: "plugin:other" },
            files: { "SKILL.md": "# other" },
          },
        },
      ),
      runs: createRunStore(opened.db),
      server: serverBinding([".bb/AGENTS.md"]),
    });
    expect(collision.ok).toBe(false);
    if (collision.ok) throw new Error("expected collision");
    expect(collision.error.code).toBe("catalog_skill_collision");

    const agentOnly = await runPrepare(seeded, {
      files: createLocalHostFilePort("host_mini"),
      runs: createRunStore(opened.db),
      server: serverBinding([".bb/AGENTS.md"], { catalogRoles: { core: CATALOG_ROLES.core, helpers: [] } }),
    });
    expect(agentOnly.ok).toBe(false);
    if (agentOnly.ok) throw new Error("expected helper required");
    expect(agentOnly.error.code).toBe("helper_skill_required");
    opened.close();
  });

  it("fails when a referenced skill file is missing", async () => {
    const opened = openFileDb();
    const root = bindingRoot();
    writeUtf8(root, ".bb/AGENTS.md", PLUGINS_AGENTS);
    const seeded = await seedProject(opened.db, root);
    const packs = skillPacks();
    delete packs[AGENCY_SKILL].files["notes.md"];
    const prepared = await runPrepare(seeded, {
      files: createLocalHostFilePort("host_mini"),
      catalog: memoryCatalog(
        {
          projectId: seeded.binding.bbProjectId,
          environmentId: seeded.binding.environmentId,
          hostId: seeded.binding.hostId,
        },
        packs,
      ),
      runs: createRunStore(opened.db),
      server: serverBinding([".bb/AGENTS.md"]),
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) throw new Error("expected missing skill file");
    expect(prepared.error.code).toBe("skill_package_incomplete");
    opened.close();
  });

  it("holds the reserve gate only for the reservation, after the snapshot is compiled", async () => {
    const opened = openFileDb();
    const root = bindingRoot();
    writeUtf8(root, ".bb/AGENTS.md", PLUGINS_AGENTS);
    const seeded = await seedProject(opened.db, root);
    const steps: string[] = [];
    const base = { store: seeded.store, files: createLocalHostFilePort("host_mini"), catalog: catalogFor(seeded), runs: createRunStore(opened.db), server: serverBinding([".bb/AGENTS.md"]) };
    const refused = await createPrepareRun({
      ...base,
      briefing: async () => {
        steps.push("briefing");
        return null;
      },
      reserveGate: async () => {
        steps.push("gate");
        return { ok: false, error: { code: "concurrency_limit_reached", message: "limit" } };
      },
    }).prepare(seeded.ctx, publicInput(seeded));
    // The slow part ran before the gate, and a refusal at the gate reserves nothing.
    expect(steps).toEqual(["briefing", "gate"]);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected the gate refusal");
    expect(refused.error.code).toBe("concurrency_limit_reached");
    expect((opened.db.prepare(`SELECT COUNT(*) AS n FROM agency_run_attempt`).get() as { n: number }).n).toBe(0);

    // No attempt was reserved, so the pack the refused launch left behind is replaced.
    const passed = await createPrepareRun({ ...base, hasLiveAttempt: () => false, reserveGate: async (reserve) => reserve() }).prepare(seeded.ctx, publicInput(seeded));
    if (!passed.ok) throw new Error(passed.error.message);
    expect(passed.value.reserved.attempt.state).toBe("prepared");
    opened.close();
  });

  it("verifies reserved snapshot through real coordinator without spawn", async () => {
    const opened = openFileDb();
    const root = bindingRoot();
    writeUtf8(root, ".bb/AGENTS.md", PLUGINS_AGENTS);
    const seeded = await seedProject(opened.db, root);
    const writes = createRunStore(opened.db);
    const reads = createInternalRunStoreReads(opened.db);
    const prepared = await runPrepare(seeded, {
      files: createLocalHostFilePort("host_mini"),
      runs: writes,
      server: serverBinding([".bb/AGENTS.md"]),
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const coordinator = createLaunchCoordinator({
      store: attemptStoreFromRunStore(writes, reads),
      liveIdentity: liveIdentityFromDatabase(opened.db),
      readiness: unavailableReadinessPort(),
      spawn: unsupportedSdkSpawnPort(),
      threadVerify: unsupportedSdkThreadVerifyPort(),
      jobRunning: deferredJobRunningPort(),
    });
    const launched = await coordinator.launchPreparedRun(seeded.ctx, {
      requestId: requestId(),
      snapshotId: prepared.value.reserved.snapshotId,
      digest: prepared.value.reserved.digest,
      attemptId: prepared.value.reserved.attempt.attemptId,
      attestation: {
        accessVerified: true,
        revisionsVerified: true,
        expectedJobRevision: seeded.job.revision,
        expectedBindingRevision: seeded.binding.revision,
      },
    });
    expect(launched.ok).toBe(false);
    if (launched.ok) throw new Error("expected capability unavailable");
    expect(launched.error.code).toBe("capability_unavailable");
    const attempt = reads.getAttempt(seeded.ctx, prepared.value.reserved.attempt.attemptId);
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) throw new Error(attempt.error.message);
    expect(attempt.value.state).toBe("prepared");
    expect(attempt.value.threadId).toBeNull();
    opened.close();
  });

  it("skill package hash ignores generated bytecode and changes when source changes", async () => {
    const scope = { projectId: "proj_trusted", environmentId: "env_ucx7sb57rs", hostId: "host_mini" };
    const listed = {
      id: HELPER_SKILL,
      name: "agency-artifacts",
      pluginId: "agency-artifacts",
      source: "plugin:agency-artifacts",
    };
    const files: Record<string, string> = {
      "SKILL.md": "# Helper\nUse [tpl](templates.md).",
      "templates.md": "Helper template body.",
      "tools.py": "print('ok')\n",
      "__pycache__/tools.cpython-312.pyc": "CACHE",
      "tools.pyc": "CACHE2",
    };
    const hashed = await hashCatalogSkillPackage(memoryCatalog(scope, { [HELPER_SKILL]: { listed, files } }), listed);
    expect(hashed.ok).toBe(true);
    if (!hashed.ok) throw new Error(hashed.error.message);
    const withoutCache = await hashCatalogSkillPackage(
      memoryCatalog(scope, {
        [HELPER_SKILL]: {
          listed,
          files: {
            "SKILL.md": files["SKILL.md"],
            "templates.md": files["templates.md"],
            "tools.py": files["tools.py"],
          },
        },
      }),
      listed,
    );
    expect(withoutCache.ok).toBe(true);
    if (!withoutCache.ok) throw new Error(withoutCache.error.message);
    expect(hashed.value.hash).toBe(withoutCache.value.hash);
    const edited = await hashCatalogSkillPackage(
      memoryCatalog(scope, {
        [HELPER_SKILL]: {
          listed,
          files: { ...files, "tools.py": "print('changed')\n" },
        },
      }),
      listed,
    );
    expect(edited.ok).toBe(true);
    if (!edited.ok) throw new Error(edited.error.message);
    expect(edited.value.hash).not.toBe(hashed.value.hash);
  });

  describe("reserve models of the employee", () => {
    const RESERVES = [
      { providerId: "codex", model: "gpt-5.5", reasoningEffort: "medium" as const },
      { providerId: "codex", model: "gpt-5.4-mini" },
    ];

    async function seedWithReserves(db: SqlDatabase, root: string, reserves = RESERVES) {
      const seeded = await seedProject(db, root);
      const agent = seeded.store.getAgent(seeded.job.assignedAgentId!)!;
      const current = seeded.store.getAgentVersion(agent.currentVersionId)!;
      const { id: _id, agentId: _agentId, ...draft } = current;
      const saved = seeded.store.saveAgentProfile({ actor: { kind: "system" }, allowedBindingIds: [] }, {
        requestId: requestId(),
        expectedRevision: agent.revision,
        agentId: agent.id,
        name: agent.name,
        state: "active",
        version: { ...draft, version: current.version + 1, fallbackModels: reserves },
      });
      if (!saved.ok) throw new Error(saved.error.message);
      return { ...seeded, agentId: agent.id, version: saved.value.version };
    }

    /** The launch as launch-rpc runs it: readiness per pair, then a real prepare on the pair that passed. */
    function launchWalk(
      seeded: Awaited<ReturnType<typeof seedWithReserves>>,
      db: SqlDatabase,
      runs: ReturnType<typeof createRunStore>,
      unavailable: readonly string[],
    ) {
      const base = requestId();
      return launchOnFirstReadyCandidate({
        candidates: launchCandidates(db, seeded.agentId, seeded.version, new Date().toISOString()),
        check: async (candidate: LaunchCandidate) =>
          unavailable.includes(candidate.model) ? fail("model_unavailable", `${candidate.model} is not in the machine catalog`) : ok(undefined),
        launch: (candidate) =>
          createPrepareRun({
            store: seeded.store,
            files: createLocalHostFilePort("host_mini"),
            catalog: catalogFor(seeded),
            runs,
            server: serverBinding([".bb/AGENTS.md"]),
            effectiveAgentVersion: (version) => applyLaunchCandidate(version, candidate),
          }).prepare(seeded.ctx, { requestId: base, jobId: seeded.job.id, expectedRevision: seeded.job.revision }),
        spawnRefusal: () => null,
      });
    }

    function attemptCount(db: SqlDatabase, jobId: string): number {
      return (db.prepare(`SELECT COUNT(*) AS n FROM agency_run_attempt WHERE job_id = ?`).get(jobId) as { n: number }).n;
    }

    it("launches on the primary when it is ready; the snapshot names no reserve", async () => {
      const opened = openFileDb();
      const root = bindingRoot();
      writeUtf8(root, ".bb/AGENTS.md", PLUGINS_AGENTS);
      const seeded = await seedWithReserves(opened.db, root);
      const walk = await launchWalk(seeded, opened.db, createRunStore(opened.db), []);
      if (!walk.result.ok) throw new Error(walk.result.error.message);
      expect(walk.used?.source).toBe("primary");
      expect(walk.result.value.snapshot.agentVersion).toMatchObject({ providerId: "codex", model: "gpt-5.6" });
      expect(walk.result.value.snapshot.agentVersion.modelSource).toBeUndefined();
      opened.close();
    });

    it("takes the first reserve that is ready; the snapshot holds the real model and where it came from", async () => {
      const opened = openFileDb();
      const root = bindingRoot();
      writeUtf8(root, ".bb/AGENTS.md", PLUGINS_AGENTS);
      const seeded = await seedWithReserves(opened.db, root);
      const walk = await launchWalk(seeded, opened.db, createRunStore(opened.db), ["gpt-5.6", "gpt-5.5"]);
      if (!walk.result.ok) throw new Error(walk.result.error.message);
      expect(walk.used?.source).toBe("fallback 2");
      expect(walk.tried.map((item) => item.candidate.model)).toEqual(["gpt-5.6", "gpt-5.5"]);
      const snapshot = walk.result.value.snapshot;
      expect(snapshot.agentVersion).toMatchObject({ id: seeded.version.id, providerId: "codex", model: "gpt-5.4-mini", modelSource: "fallback 2" });
      // The reserve's own reasoning level, not the primary's, and one attempt only.
      expect(snapshot.execution?.reasoningLevel).toBeUndefined();
      expect(attemptCount(opened.db, seeded.job.id)).toBe(1);
      // The profile is not rewritten: the primary stays the primary.
      const live = seeded.store.getAgentVersion(seeded.store.getAgent(seeded.agentId)!.currentVersionId)!;
      expect(live.id).toBe(seeded.version.id);
      expect(live.model).toBe("gpt-5.6");
      opened.close();
    });

    it("reserves nothing when no model is ready and names every pair it tried", async () => {
      const opened = openFileDb();
      const root = bindingRoot();
      writeUtf8(root, ".bb/AGENTS.md", PLUGINS_AGENTS);
      const seeded = await seedWithReserves(opened.db, root);
      const walk = await launchWalk(seeded, opened.db, createRunStore(opened.db), ["gpt-5.6", "gpt-5.5", "gpt-5.4-mini"]);
      expect(walk.result.ok).toBe(false);
      if (walk.result.ok) throw new Error("expected a refusal");
      expect(walk.result.error.code).toBe("fallback_models_refused");
      for (const model of ["gpt-5.6", "gpt-5.5", "gpt-5.4-mini"]) expect(walk.result.error.message).toContain(model);
      expect(attemptCount(opened.db, seeded.job.id)).toBe(0);
      opened.close();
    });

    it("without reserves the refusal is the primary's own, as before", async () => {
      const opened = openFileDb();
      const root = bindingRoot();
      writeUtf8(root, ".bb/AGENTS.md", PLUGINS_AGENTS);
      const seeded = await seedWithReserves(opened.db, root, []);
      expect(seeded.version.fallbackModels).toBeUndefined();
      const walk = await launchWalk(seeded, opened.db, createRunStore(opened.db), ["gpt-5.6"]);
      if (walk.result.ok) throw new Error("expected a refusal");
      expect(walk.result.error.code).toBe("model_unavailable");
      expect(attemptCount(opened.db, seeded.job.id)).toBe(0);
      opened.close();
    });

    it("refuses a model the owner did not list: the catalog's closest one never launches by itself", async () => {
      const opened = openFileDb();
      const root = bindingRoot();
      writeUtf8(root, ".bb/AGENTS.md", PLUGINS_AGENTS);
      const seeded = await seedWithReserves(opened.db, root);
      const prepared = await createPrepareRun({
        store: seeded.store,
        files: createLocalHostFilePort("host_mini"),
        catalog: catalogFor(seeded),
        runs: createRunStore(opened.db),
        server: serverBinding([".bb/AGENTS.md"]),
        effectiveAgentVersion: (version) => ({ ...version, model: "gpt-5.6-closest" }),
      }).prepare(seeded.ctx, publicInput(seeded));
      expect(prepared.ok).toBe(false);
      if (!prepared.ok) expect(prepared.error.code).toBe("live_version_mismatch");
      expect(attemptCount(opened.db, seeded.job.id)).toBe(0);
      opened.close();
    });

    it("does not move a job that already has a live attempt onto another model", async () => {
      const opened = openFileDb();
      const root = bindingRoot();
      writeUtf8(root, ".bb/AGENTS.md", PLUGINS_AGENTS);
      const seeded = await seedWithReserves(opened.db, root);
      const runs = createRunStore(opened.db);
      const first = await launchWalk(seeded, opened.db, runs, []);
      if (!first.result.ok) throw new Error(first.result.error.message);
      opened.db
        .prepare(`UPDATE agency_run_attempt SET state = 'running', thread_id = 'thr_live', launch_id = ? WHERE job_id = ?`)
        .run(randomUUID(), seeded.job.id);
      // The primary has since left the machine; the job's attempt is alive, so the reserve is not taken.
      const second = await launchWalk(seeded, opened.db, runs, ["gpt-5.6"]);
      expect(second.result.ok).toBe(false);
      // Whatever guard answers first, it is not a refusal of the model: the walk stops on the primary.
      if (!second.result.ok) expect(["active_attempt_exists", "artifact_immutable"]).toContain(second.result.error.code);
      expect(second.tried).toEqual([{ candidate: expect.objectContaining({ model: "gpt-5.6" }), error: expect.objectContaining({ code: "model_unavailable" }) }]);
      expect(second.used).toBeNull();
      expect(attemptCount(opened.db, seeded.job.id)).toBe(1);
      opened.close();
    });
  });
});

