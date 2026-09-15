import { describe, expect, it } from "vitest";
import { createRpcAgencyApi } from "../src/app/data/rpc-agency-api";
import { parseDomainResult, UNKNOWN_CALLER_MESSAGE } from "../src/app/data/envelope";
import { artifactAuthorLabel, bytesToBase64, fileBytes, sha256Hex } from "../src/app/data/content-hash";
import { canCreateJob, failureNotice, openPersistedArtifact, persistAgentPatch, persistArtifactUpload, persistDepartmentPatch, persistJobPatch, persistProjectPatch } from "../src/app/data/persist";
import { bindingPlacementLabel } from "../src/app/data/persist-create";
import { capabilityStatusLabel } from "../src/app/data/capability-catalog";
import { mapAgents, mapDepartments, mapProjects } from "../src/app/data/view-models";
import { agentDraftStale, isOwnProfileEcho, unsupportedAgentFieldChanges } from "../src/app/data/agent-profile-fields";
import { applyDraftsAfterSave, canLeaveAfterSave, commitDocumentSave } from "../src/app/data/document-save";
import { assigneeChoiceOptions, assigneeFields, assigneesForDepartment, canConfirmPlacement, departmentsForBinding, JOB_CREATE_HINT, placementFields, sanitizeDepartmentId, selectedAgentId, selectedBindingId, selectedDepartmentId, UNASSIGNED_AGENT } from "../src/app/data/job-placement";
import { productServerReason, PRODUCT_ASSIGNEE_REQUIRED, PRODUCT_CLAUDE_ONLY, PRODUCT_HANDSHAKE_UNREADY } from "../src/app/data/product-reasons";
import {
  applyRestoredSaveResult,
  commitRestoredDocumentSave,
  openerHostId,
  restoreDocumentFromPreview,
  shouldUseHostOriginal,
  startRestoredSave,
} from "../src/app/data/document-restore";
import {
  claimDocumentPanel,
  documentVisibilityId,
  isDocumentPanelVisible,
  releaseDocumentPanel,
  resetDocumentVisibility,
} from "../src/app/data/document-visibility";
import { clearFileDraft, jobNeedsServerPatch } from "../src/app/data/job-record-patch";
import { mapActivity, mapJobs, queueCounts, countsMatchJobs, nextJobKey } from "../src/app/data/view-models";
import { mergeCapabilityChoices, normalizeBbCatalog } from "../src/app/data/capability-catalog";
import { advancedCatalogPolicies, environmentPlacementLabel, policyVersionIdForCreate } from "../src/app/data/persist-create";
import { nativePreviewFromOpen } from "../src/app/data/native-preview";
import { STAGE1_RPC } from "../src/app/data/methods";
import type { WorkspaceSnapshot } from "../src/app/data/snapshot";
import type { Activity } from "../src/shared/contracts";
import {
  LAUNCH_LIST_UNREGISTERED,
  LAUNCH_HANDSHAKE_HINT,
  completionNeverSucceeded,
  jobCanRequestLaunch,
  jobLaunchableState,
  launchNeedsReconcile,
  mustNotRespawn,
  nextLaunchAction,
  parseCompletion,
  canLaunchFromReadiness,
  parseIsolationReadiness,
  parseJobAttempts,
  parsePrepareLaunch,
  parseRunAttempt,
  launchStateLabel,
  LAUNCH_STATE_UNSUPPORTED,
  LAUNCH_STATE_AWAITING_REVIEW,
  LAUNCH_STATE_SUCCEEDED,
  UNSUPPORTED_ATTEMPT_STATE,
  KNOWN_ACTIVE_ATTEMPT_STATES,
  readinessAllowsProvider,
  launchAssigneeProviderId,
  jobLaunchAllowedFromReadiness,
  launchReadinessNotice,
  LAUNCH_PROVIDER_UNAVAILABLE,
  type IsolationReadiness,
} from "../src/app/data/launch-rpc";
import { formatPrepareLaunchOutcome, jobLaunchRefreshKey, liveJobLaunchReady, openLiveLaunch, resolveLiveLaunchRoute } from "../src/app/data/persist-launch";
import {
  LIVE_RUNS_COPY,
  createLiveRunsFetchGate,
  liveLaunchFromReceipt,
  liveRunsListCopy,
  liveRunsPageDescription,
  nextLiveRunsCatalog,
} from "../src/app/data/live-runs";
import { STAGE1_UNAVAILABLE } from "../src/app/data/runtime-unavailable";

const gated = { ok: false as const, error: { code: "unknown_caller", message: "untrusted caller" } };

const snapshot: WorkspaceSnapshot = {
  contractVersion: "agency.domain.stage1.v1",
  isolation: { catalogSkillsIsolated: false, catalogMcpIsolated: false, execution: "unavailable", reason: "closed" },
  bindings: [{
    id: "bnd_project01",
    bbProjectId: "proj_selfy",
    bbProjectName: "SelfyStudio",
    environmentName: "локально",
    hostName: "Mac mini",
    environmentId: "env_local",
    hostId: "host_mini",
    canonicalRoot: "/agency/selfy",
    policyVersionId: "pol_default1",
    sectionId: null,
    revision: 1,
    updatedAt: "2026-09-14T00:00:00Z",
  }],
  departments: [{
    id: "dep_editorial",
    name: "Редакция",
    leadAgentId: "agt_writer01",
    processVersionId: "prc_editorial",
    revision: 1,
    updatedAt: "2026-09-14T00:00:00Z",
  }],
  agents: [{
    id: "agt_writer01",
    name: "Анна",
    state: "active",
    currentVersionId: "ver_writer01",
    revision: 1,
    updatedAt: "2026-09-14T00:00:00Z",
  }],
  jobs: [{
    id: "job_offer0001",
    key: "AG-102",
    bindingId: "bnd_project01",
    departmentId: "dep_editorial",
    title: "Подготовить оффер",
    brief: "Текст оффера",
    acceptance: "Файл приложен",
    state: "review",
    parentJobId: null,
    assignedAgentId: "agt_writer01",
    priority: "high",
    dueAt: "2026-09-18T00:00:00Z",
    revision: 3,
    updatedAt: "2026-09-14T00:00:00Z",
  }],
  counts: { review: 1, backlog: 0, queued: 0, running: 0, waiting_input: 0, blocked: 0, done: 0, canceled: 0 },
  memberships: [{ departmentId: "dep_editorial", agentId: "agt_writer01", role: "lead" }],
  agentVersions: [{
    id: "ver_writer01",
    agentId: "agt_writer01",
    version: 1,
    role: "Редактор",
    instructions: "Править тексты.",
    providerId: "codex",
    model: "gpt-5.6",
    skillIds: ["ru-text"],
    mcpIds: ["Документы"],
    policyVersionId: "pol_default1",
  }],
  processVersions: [{
    id: "prc_editorial",
    departmentId: "dep_editorial",
    instructions: "Черновик, затем проверка.",
    acceptance: "Есть принятая версия файла.",
    reviewPolicy: { required: true },
  }],
  projectDepartments: [{ bindingId: "bnd_project01", departmentId: "dep_editorial" }],
  policies: [{
    id: "pol_default1",
    allowedCapabilities: ["read.files"],
    cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_mini"] },
    secretRefs: ["OPENAI_API_KEY"],
  }],
};

const emptySnapshot: WorkspaceSnapshot = {
  contractVersion: "agency.domain.stage1.v1",
  isolation: { catalogSkillsIsolated: false, catalogMcpIsolated: false, execution: "unavailable", reason: "closed" },
  bindings: [],
  departments: [],
  agents: [],
  jobs: [],
  counts: {},
  memberships: [],
  agentVersions: [],
  processVersions: [],
  projectDepartments: [],
  policies: [],
};

describe("domain RPC adapter", () => {
  it("treats unknown_caller as gated, not an empty successful catalog", async () => {
    const calls: unknown[] = [];
    const api = createRpcAgencyApi({
      call: async (method, input) => {
        calls.push({ method, input });
        expect(method).toBe(STAGE1_RPC.listWorkspace);
        return gated;
      },
    });
    const result = await api.loadWorkspace({});
    expect(result.status).toBe("gated");
    if (result.status === "gated") expect(result.message).toBe(UNKNOWN_CALLER_MESSAGE);
    expect(calls[0]).toEqual({ method: "listWorkspace", input: {} });
  });

  it("treats empty bindings as a ready catalog", async () => {
    const api = createRpcAgencyApi({
      call: async () => ({ ok: true, value: emptySnapshot }),
    });
    const result = await api.loadWorkspace({});
    expect(result.status).toBe("ready");
    if (result.status === "ready") expect(result.snapshot.bindings).toEqual([]);
  });

  it("does not send actor, fileOp, canonicalRoot or other grants", async () => {
    let payload: unknown;
    const api = createRpcAgencyApi({
      call: async (_method, input) => {
        payload = input;
        return gated;
      },
    });
    await api.loadWorkspace({});
    expect(payload).toEqual({});
    expect(JSON.stringify(payload)).not.toMatch(/actor|author|fileOp|canonicalRoot|isAdmin|allowedBindings/);
    expect(Object.keys(STAGE1_RPC)).not.toContain("fileOp");
    expect(Object.keys(STAGE1_RPC)).not.toContain("getFile");
    expect(Object.keys(STAGE1_RPC)).toContain("openArtifact");
    expect(Object.keys(STAGE1_RPC)).toContain("resolveArtifactPreview");
  });

  it("opens artifacts by opaque ids and version, not host fileOp", async () => {
    let method = "";
    let payload: unknown;
    const api = createRpcAgencyApi({
      call: async (name, input) => {
        method = name;
        payload = input;
        return { ok: true, value: { hostId: "host_mini", size: 1, hash: "a".repeat(64), bytesBase64: "YQ==", target: { hostId: "host_mini", path: "/agency/preview/card.md" } } };
      },
    });
    await api.openArtifact({ artifactId: "art_brief001", jobId: "job_offer0001", version: 2 });
    expect(method).toBe("openArtifact");
    expect(payload).toEqual({ artifactId: "art_brief001", jobId: "job_offer0001", version: 2 });
    expect(JSON.stringify(payload)).not.toMatch(/actor|author|fileOp|canonicalRoot|isAdmin|allowedBindings/);
  });

  it("resolves preview restore by host path without granting a file read", async () => {
    let method = "";
    let payload: unknown;
    const api = createRpcAgencyApi({
      call: async (name, input) => {
        method = name;
        payload = input;
        return {
          ok: true,
          value: {
            artifactId: "art_brief001",
            jobId: "job_offer0001",
            version: 2,
            hash: "a".repeat(64),
            mime: "text/markdown",
            size: 1,
            relativePath: "card.md",
            bindingId: "bnd_project1",
            target: { hostId: "host_mini", path: "/tmp/agency/.agency/preview/art_brief001/" + "a".repeat(64) + ".md" },
          },
        };
      },
    });
    await api.resolveArtifactPreview({ hostId: "host_mini", path: "/tmp/agency/.agency/preview/art_brief001/aa.md" });
    expect(method).toBe("resolveArtifactPreview");
    expect(payload).toEqual({ hostId: "host_mini", path: "/tmp/agency/.agency/preview/art_brief001/aa.md" });
    expect(JSON.stringify(payload)).not.toMatch(/fileOp|getFile|bytesBase64|canonicalRoot/);
  });

  it("publishes upload with real bytesBase64 and no host grants", async () => {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const api = createRpcAgencyApi({
      call: async (method, input) => {
        calls.push({ method, input: input as Record<string, unknown> });
        if (method === "createArtifact") return { ok: true, value: { id: "art_upload01", jobId: "job_offer0001" } };
        return {
          ok: true,
          value: {
            artifactId: "art_upload01",
            jobId: "job_offer0001",
            version: 1,
            hostId: "host_mini",
            relativePath: "note.md",
            mime: "text/markdown",
            size: 3,
            hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            author: { kind: "system" },
          },
        };
      },
    });
    const file = { id: "local-note", name: "note.md", size: 3, content: "abc", kind: "text" as const };
    const result = await persistArtifactUpload(api, "job_offer0001", file);
    expect(result.ok).toBe(true);
    expect(calls.map((item) => item.method)).toEqual(["createArtifact", "publishArtifactVersion"]);
    const publish = calls[1]?.input;
    expect(publish?.bytesBase64).toBe(bytesToBase64(fileBytes(file)));
    expect(publish?.hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(publish).not.toHaveProperty("actor");
    expect(publish).not.toHaveProperty("author");
    expect(publish).not.toHaveProperty("fileOp");
    expect(publish).not.toHaveProperty("canonicalRoot");
    expect(publish).not.toHaveProperty("hostId");
  });

  it("rejects open when returned hash does not match decoded bytes", async () => {
    const api = createRpcAgencyApi({
      call: async () => ({ ok: true, value: { hostId: "host_mini", size: 3, hash: "0".repeat(64), bytesBase64: bytesToBase64(fileBytes({ content: "abc", kind: "text" })), target: { hostId: "host_mini", path: "/agency/preview/card.md" } } }),
    });
    const opened = await openPersistedArtifact(api, { artifactId: "art_brief001", jobId: "job_offer0001", version: 1 });
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.failure).toMatchObject({ kind: "domain", error: { code: "artifact_hash_mismatch" } });
  });

  it("parses unknown_caller envelope as gated failure", () => {
    const parsed = parseDomainResult(gated);
    expect(parsed).toEqual({ ok: false, failure: { kind: "gated", message: UNKNOWN_CALLER_MESSAGE } });
  });

  it("does not treat an unrecognized envelope as prepareLaunch success", () => {
    const parsed = parseDomainResult({ handshakeReady: false, reason: "" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.failure.kind).toBe("transport");
  });
});

describe("workspace view models", () => {
  it("keeps list and counters on the same job set", () => {
    const jobs = mapJobs(snapshot);
    expect(jobs.map((job) => job.id)).toEqual(["AG-102"]);
    expect(jobs[0]?.agent).toBe("Анна");
    expect(queueCounts(jobs, snapshot.counts).attention).toBe(1);
    expect(countsMatchJobs(jobs, snapshot.counts)).toBe(true);
  });

  it("renders system actor and author without user or agent lookup", () => {
    const rows: Activity[] = [
      { id: "act_system01", jobId: "job_offer0001", actor: { kind: "system" }, kind: "job_created", causationId: null, timestamp: "2026-09-14T00:00:00Z", references: [] },
      { id: "act_user0001", jobId: "job_offer0001", actor: { kind: "user", userId: "usr_owner" }, kind: "comment", causationId: null, timestamp: "2026-09-14T00:01:00Z", references: [], comment: "Проверьте условия" },
      { id: "act_agent001", jobId: "job_offer0001", actor: { kind: "agent", agentId: "agt_writer01" }, kind: "comment", causationId: null, timestamp: "2026-09-14T00:02:00Z", references: [], comment: "Готово" },
    ];
    expect(mapActivity(rows, []).map((item) => item.author)).toEqual(["Система", "Вы", "agt_writer01"]);
    expect(mapActivity(rows, [{ id: "agt_writer01", name: "Анна" }]).map((item) => item.author)).toEqual(["Система", "Вы", "Анна"]);
    expect(artifactAuthorLabel({ kind: "system" })).toBe("Система");
  });

  it("keeps job_transitioned target from typed ref and does not invent from", () => {
    const rows: Activity[] = [{
      id: "act_trans001",
      jobId: "job_offer0001",
      actor: { kind: "agent", agentId: "agt_writer01" },
      kind: "job_transitioned",
      causationId: null,
      timestamp: "2026-09-14T00:03:00Z",
      references: [{ type: "job_state", id: "running" }],
    }];
    const mapped = mapActivity(rows, [{ id: "agt_writer01", name: "Анна" }]);
    expect(mapped[0]?.text).toBe("Статус: В работе");
    expect(mapped[0]?.text).not.toMatch(/Бэклог|→|from/i);
    expect(mapped[0]?.references).toEqual([{ type: "job_state", id: "running" }]);
    expect(mapped[0]?.author).toBe("Анна");
    expect(mapActivity([{ ...rows[0]!, references: [] }], []).map((item) => item.text)).toEqual(["Изменён статус"]);
  });

  it("allocates the next job key after existing AG keys", () => {
    expect(nextJobKey(["AG-102", "AG-108"])).toBe("AG-109");
    expect(nextJobKey(["AG-1"])).toBe("AG-2");
    expect(nextJobKey([])).toBe("AG-1");
    expect(nextJobKey(["AG-1"])).not.toBe("AG-101");
  });

  it("keeps saved capability ids that left the catalog", () => {
    const rows = mergeCapabilityChoices(
      [{ id: "skill_agency01", label: "agency", source: "plugin" }],
      ["skill_agency01", "skill_missing1"],
    );
    expect(rows.find((row) => row.id === "skill_missing1")).toMatchObject({ available: false, source: "saved" });
    expect(rows.find((row) => row.id === "skill_agency01")?.available).toBe(true);
    expect(normalizeBbCatalog({ projects: [], environments: [], policies: [], skills: [{ id: "skill_agency01", label: "agency", scope: "plugin" }] }).skills).toEqual([
      { id: "skill_agency01", label: "agency", source: "plugin" },
    ]);
    expect(environmentPlacementLabel({
      label: "локально",
      hostName: "Mac mini",
      path: "/Users/vechkasov/Documents/SelfyStudio",
    })).toBe("локально · SelfyStudio · Mac mini");
    expect(environmentPlacementLabel({
      label: "локально",
      hostName: "Mac mini",
      path: "/Users/vechkasov/Documents/SelfyStudio",
    })).not.toMatch(/host_/);
    expect(environmentPlacementLabel({
      label: "SelfyStudio · OVH Server",
      hostName: "OVH Server",
      path: "/srv/selfystudio",
    })).toBe("SelfyStudio · OVH Server · selfystudio");
    expect(environmentPlacementLabel({
      label: "SelfyStudio · OVH Server",
      hostName: "OVH Server",
      path: "/srv/selfystudio",
    })).not.toMatch(/OVH Server · .*OVH Server/);
    expect(advancedCatalogPolicies([
      { id: "pol_a", label: "Политика · read.files" },
      { id: "pol_b", label: "Политика · read.files" },
      { id: "pol_c", label: "Политика · read.files, write.files" },
    ])).toEqual([{ id: "pol_c", label: "Политика · read.files, write.files" }]);
    expect(policyVersionIdForCreate("default")).toBe("");
    expect(policyVersionIdForCreate("pol_c")).toBe("pol_c");
    expect(capabilityStatusLabel(false)).toBe("нет в каталоге");
    expect(capabilityStatusLabel(true)).toBe("в каталоге");
  });

  it("labels bindings by project, folder and host, not host as lead", () => {
    const plugins = bindingPlacementLabel({
      bbProjectName: "BB-сервис",
      bbProjectId: "proj_ejbam66722",
      canonicalRoot: "/Users/vechkasov/Documents/BB-сервис/plugins",
      hostName: "MAC Mini",
    });
    const root = bindingPlacementLabel({
      bbProjectName: "BB-сервис",
      bbProjectId: "proj_ejbam66722",
      canonicalRoot: "/Users/vechkasov/Documents/BB-сервис",
      hostName: "MAC Mini",
    });
    expect(plugins).toBe("BB-сервис · plugins · MAC Mini");
    expect(root).toBe("BB-сервис · BB-сервис · MAC Mini");
    expect(plugins).not.toBe(root);
    const mapped = mapProjects({
      ...snapshot,
      bindings: [
        { ...snapshot.bindings[0]!, bbProjectName: "BB-сервис", canonicalRoot: "/Users/vechkasov/Documents/BB-сервис/plugins", hostName: "MAC Mini" },
        { ...snapshot.bindings[0]!, id: "bnd_root0001", bbProjectName: "BB-сервис", canonicalRoot: "/Users/vechkasov/Documents/BB-сервис", hostName: "MAC Mini" },
      ],
    });
    expect(mapped.map((item) => item.name)).toEqual([
      "BB-сервис · plugins · MAC Mini",
      "BB-сервис · BB-сервис · MAC Mini",
    ]);
    expect(mapped.every((item) => item.lead === "")).toBe(true);
  });

  it("rejects profile save when visible unsupported fields changed", async () => {
    const [current] = mapAgents(snapshot);
    const calls: unknown[] = [];
    const api = {
      saveAgentProfile: async (input: unknown) => {
        calls.push(input);
        return { ok: true as const, value: { agent: snapshot.agents[0]!, version: snapshot.agentVersions[0]! } };
      },
    };
    const leaked = await persistAgentPatch(api as never, snapshot, current, { ...current, hostId: "host_other", shell: true });
    expect(leaked.ok).toBe(false);
    if (!leaked.ok) expect(leaked.failure).toMatchObject({ kind: "domain", error: { code: "invalid_command" } });
    expect(unsupportedAgentFieldChanges(current, { ...current, hostId: "host_other" })).toEqual(["машина"]);
    const saved = await persistAgentPatch(api as never, snapshot, current, { ...current, role: "Редактор текстов" });
    expect(saved).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ version: { role: "Редактор текстов", providerId: "codex", model: "gpt-5.6" } });
    expect(JSON.stringify(calls[0])).not.toMatch(/hostId|reasoningLevel|serviceTier|shell|delegate|customMcps/);
  });

  it("keeps child placement on parent binding and department, not first catalog row", () => {
    expect(canCreateJob(snapshot, { bindingId: "bnd_project01", departmentId: "dep_editorial" })).toEqual({
      bindingId: "bnd_project01",
      departmentId: "dep_editorial",
    });
    expect(canCreateJob(snapshot, { bindingId: snapshot.bindings[0]?.id })).toBeNull();
    expect(canCreateJob({ ...snapshot, projectDepartments: [] }, { bindingId: "bnd_project01", departmentId: "dep_editorial" })).toBeNull();
    expect(canCreateJob(snapshot, { bindingId: "bnd_1c5b4de02364a04fe159ab50", departmentId: "dep_editorial" })).toBeNull();
  });

  it("lists only departments linked to the selected binding", () => {
    const departments = [{ id: "dep_editorial", name: "Редакция" }, { id: "dep_qa", name: "QA" }];
    const links = [{ bindingId: "bnd_project01", departmentId: "dep_editorial" }];
    expect(departmentsForBinding(departments, links, "bnd_project01")).toEqual([{ id: "dep_editorial", name: "Редакция" }]);
    expect(departmentsForBinding(departments, links, "bnd_1c5b4de02364a04fe159ab50")).toEqual([]);
    expect(sanitizeDepartmentId("dep_qa", departmentsForBinding(departments, links, "bnd_project01"))).toBe("");
    expect(JOB_CREATE_HINT).toBe("Укажите название, проект и отдел.");
  });

  it("lists assignees from department membership ids and disambiguates same names", () => {
    const departments = [
      { id: "dep_new", members: ["agt_claude01"], lead: "agt_claude01" },
      { id: "dep_other", members: ["agt_review01", "agt_claude02"], lead: "agt_review01" },
    ];
    const agents = [
      { id: "agt_claude01", name: "E2E Claude", role: "исполнитель", selection: { providerId: "claude-code" } },
      { id: "agt_claude02", name: "E2E Claude", role: "исполнитель", selection: { providerId: "claude-code" } },
      { id: "agt_review01", name: "E2E Claude", role: "рецензент", selection: { providerId: "claude-code" } },
    ];
    expect(assigneesForDepartment("dep_new", departments, agents).map((item) => item.id)).toEqual(["agt_claude01"]);
    const options = assigneeChoiceOptions("dep_new", departments, agents, null);
    expect(options.map((item) => item.value)).toEqual([UNASSIGNED_AGENT, "agt_claude01"]);
    expect(options.some((item) => item.value === "agt_review01")).toBe(false);
    const other = assigneeChoiceOptions("dep_other", departments, agents, null);
    expect(other.map((item) => item.value).sort()).toEqual([UNASSIGNED_AGENT, "agt_claude02", "agt_review01"].sort());
    expect(other.find((item) => item.value === "agt_review01")?.label).toContain("рецензент");
    expect(other.find((item) => item.value === "agt_claude02")?.label).toContain("исполнитель");
    expect(productServerReason("job.assignedAgentId is required")).toBe(PRODUCT_ASSIGNEE_REQUIRED);
    expect(failureNotice({ kind: "domain", error: { code: "assignee_required", message: "job.assignedAgentId is required" } })).toBe(PRODUCT_ASSIGNEE_REQUIRED);
    expect(productServerReason("GET /api/v1/system/experimental_thread-spawn-contract")).toBe(PRODUCT_HANDSHAKE_UNREADY);
    expect(LAUNCH_HANDSHAKE_HINT).not.toMatch(/\/api\/|Engines|SDK/);
    expect(launchReadinessNotice({
      handshakeReady: false,
      executionAvailable: false,
      isolationReady: false,
      isolatedSpawnFields: false,
      sdkTypedSpawnReady: false,
      provenIsolationProviders: [],
      assignedProvider: null,
      launchAllowedForAssigned: false,
      reason: "typed runtime capability handshake is not proven; TypeScript types and instance names are not evidence",
    }, null)).toBe(PRODUCT_HANDSHAKE_UNREADY);
  });

  it("selects live job placement and assignee by opaque ids after a name/label mismatch", async () => {
    const [job] = mapJobs(snapshot);
    const [project] = mapProjects(snapshot);
    const [department] = mapDepartments(snapshot);
    const [agent] = mapAgents(snapshot);
    expect(job?.project).toBe("SelfyStudio");
    expect(project?.name).not.toBe(job?.project);
    expect(selectedBindingId(job!, [project!])).toBe("bnd_project01");
    expect(selectedDepartmentId(job!, [department!])).toBe("dep_editorial");
    expect(selectedAgentId(job!, [agent!])).toBe("agt_writer01");
    expect(selectedAgentId({ agent: "Не назначен", assignedAgentId: null }, [agent!])).toBe(UNASSIGNED_AGENT);
    const links = [{ bindingId: "bnd_project01", departmentId: "dep_editorial" }];
    expect(canConfirmPlacement("bnd_project01", "dep_qa", links)).toBe(false);
    expect(canConfirmPlacement("bnd_project01", "dep_editorial", links)).toBe(true);
    expect(placementFields("bnd_project01", "dep_editorial", [project!], [department!])).toEqual({
      bindingId: "bnd_project01",
      departmentId: "dep_editorial",
      project: project!.name,
      department: department!.name,
    });
    expect(sanitizeDepartmentId("dep_editorial", departmentsForBinding([department!], links, "bnd_other"))).toBe("");
    expect(assigneeFields("agt_writer01", [agent!])).toEqual({ assignedAgentId: "agt_writer01", agent: agent!.name });
    const calls: unknown[] = [];
    const api = {
      updateJob: async (input: unknown) => {
        calls.push(input);
        return { ok: true as const, value: snapshot.jobs[0] };
      },
    };
    const moved = await persistJobPatch(api as never, snapshot, job!, {
      ...job!,
      ...placementFields("bnd_project01", "dep_editorial", [project!], [department!])!,
      ...assigneeFields("agt_writer01", [agent!]),
    });
    expect(moved).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({
      bindingId: "bnd_project01",
      departmentId: "dep_editorial",
      assignedAgentId: "agt_writer01",
    });
    expect(JSON.stringify(calls[0])).not.toMatch(/SelfyStudio|Редакция|Анна/);
  });

  it("adopts an own profile save echo and keeps a real external conflict", () => {
    const [current] = mapAgents(snapshot);
    const draft = { ...current!, skills: [...current!.skills, "agency"] };
    const echo = { ...draft, revision: 3 };
    expect(isOwnProfileEcho(draft, echo, { ...current!, revision: 2 })).toBe(true);
    expect(agentDraftStale({ ...current!, revision: 2 }, echo) && !isOwnProfileEcho(draft, echo, { ...current!, revision: 2 })).toBe(false);
    const external = { ...current!, instructions: "Чужая правка", revision: 3 };
    const dirtyName = { ...current!, name: "Черновик" };
    expect(isOwnProfileEcho(dirtyName, external, { ...current!, revision: 2 })).toBe(false);
    expect(agentDraftStale({ ...current!, revision: 2 }, external)).toBe(true);
  });

  it("does not flip saving off when a second click hits an in-flight save", async () => {
    const savingRef = { current: false };
    let saving = false;
    let release: ((value: { ok: true; value: { artifactId: string } }) => void) | undefined;
    const saveFile = async () => {
      if (savingRef.current) return false;
      saving = true;
      const finished = await commitDocumentSave({
        savingRef,
        persist: () => new Promise<{ ok: true; value: { artifactId: string } }>((resolve) => {
          release = resolve;
        }),
        failureMessage: failureNotice,
      });
      saving = false;
      return finished.ok;
    };
    const first = saveFile();
    await Promise.resolve();
    expect(saving).toBe(true);
    expect(await saveFile()).toBe(false);
    expect(saving).toBe(true);
    release!({ ok: true, value: { artifactId: "art_1" } });
    expect(await first).toBe(true);
    expect(saving).toBe(false);
  });

  it("keeps draft and error text when live save rejects or throws before drafts clear", async () => {
    const drafts = { art_1: "черновик" };
    const savingRef = { current: false };
    let release: ((value: { ok: true; value: { artifactId: string } }) => void) | undefined;
    const first = commitDocumentSave({
      savingRef,
      persist: () => new Promise<{ ok: true; value: { artifactId: string } }>((resolve) => {
        release = resolve;
      }),
      afterSuccess: async () => {
        drafts.art_1 = "cleared";
      },
      failureMessage: failureNotice,
    });
    await Promise.resolve();
    const blocked = await commitDocumentSave({
      savingRef,
      persist: async () => ({ ok: true, value: { artifactId: "art_1" } }),
      afterSuccess: async () => {
        drafts.art_1 = "cleared";
      },
      failureMessage: failureNotice,
    });
    expect(blocked).toEqual({ ok: false, error: null });
    expect(canLeaveAfterSave(blocked.ok)).toBe(false);
    expect(drafts.art_1).toBe("черновик");
    release!({ ok: true, value: { artifactId: "art_1" } });
    const finished = await first;
    expect(finished.ok).toBe(true);
    expect(canLeaveAfterSave(finished.ok)).toBe(true);
    drafts.art_1 = "черновик";

    const thrown = await commitDocumentSave({
      savingRef: { current: false },
      persist: () => Promise.reject(new Error("fileBytes / hash")),
      afterSuccess: async () => {
        drafts.art_1 = "cleared";
      },
      failureMessage: failureNotice,
    });
    expect(thrown).toEqual({ ok: false, error: "fileBytes / hash" });
    expect(canLeaveAfterSave(thrown.ok)).toBe(false);
    expect(drafts.art_1).toBe("черновик");

    const opened = await commitDocumentSave({
      savingRef: { current: false },
      persist: async () => ({ ok: true, value: { artifactId: "art_1" } }),
      afterSuccess: () => Promise.reject(new Error("openArtifact")),
      failureMessage: failureNotice,
    });
    expect(opened).toEqual({ ok: false, error: "openArtifact" });
    expect(drafts.art_1).toBe("черновик");

    const failed = await commitDocumentSave({
      savingRef: { current: false },
      persist: async () => ({
        ok: false as const,
        failure: { kind: "domain" as const, error: { code: "unavailable", message: "Сервер отклонил версию." } },
      }),
      afterSuccess: async () => {
        drafts.art_1 = "cleared";
      },
      failureMessage: failureNotice,
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toContain("Сервер отклонил версию");
    expect(canLeaveAfterSave(failed.ok)).toBe(false);
    expect(applyDraftsAfterSave(drafts, ["art_1"], "черновик")).toEqual({});
    expect(applyDraftsAfterSave({ art_1: "новее" }, ["art_1"], "черновик")).toEqual({ art_1: "новее" });
  });
});

describe("native preview routing", () => {
  it("opens the native tab from server target, not an invented or demo path", () => {
    const opened = nativePreviewFromOpen({
      hostId: "host_mini",
      target: { hostId: "host_mini", path: "/tmp/agency-preview/card.md" },
    });
    expect(opened).toEqual({ ok: true, target: { hostId: "host_mini", path: "/tmp/agency-preview/card.md" } });
    expect(nativePreviewFromOpen({ hostId: "host_mini", path: "/tmp/agency-preview/card.md" } as never).ok).toBe(false);
    expect(nativePreviewFromOpen({ hostId: "host_mini" }).ok).toBe(false);
    expect(nativePreviewFromOpen({
      hostId: "host_mini",
      target: { hostId: "host_mini", path: "/tmp/agency-preview/card.md" },
      demo: true,
    }).ok).toBe(false);
    expect(JSON.stringify(nativePreviewFromOpen({ hostId: "host_mini" }))).not.toMatch(/originals|prepareDemoDocument/);
  });
});

describe("workspace api identity", () => {
  it("creates a new adapter per factory call, so the hook must memoize by rpc", () => {
    const rpc = { call: async () => ({ ok: true, value: emptySnapshot }) };
    expect(createRpcAgencyApi(rpc)).not.toBe(createRpcAgencyApi(rpc));
  });
});

describe("job draft vs record patch", () => {
  it("does not treat file drafts as a server job mutation", () => {
    const [job] = mapJobs(snapshot);
    expect(job).toBeDefined();
    expect(jobNeedsServerPatch(job!, { ...job!, fileDrafts: { [job!.id]: "черновик" } })).toBe(false);
    expect(jobNeedsServerPatch(job!, { ...job!, title: "Другой заголовок" })).toBe(true);
    expect(clearFileDraft({ a: "1", b: "2" }, "a")).toEqual({ b: "2" });
  });

  it("skips updateJob when only a local draft changed", async () => {
    const [job] = mapJobs(snapshot);
    const calls: string[] = [];
    const api = createRpcAgencyApi({
      call: async (method) => {
        calls.push(method);
        return { ok: true, value: snapshot.jobs[0] };
      },
    });
    const result = await persistJobPatch(api, snapshot, job!, { ...job!, fileDrafts: { note: "abc" } });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([]);
  });

  it("explains blocked project moves without implying a silent file copy", () => {
    expect(failureNotice({ kind: "domain", error: { code: "job_has_artifacts", message: "hidden" } })).toContain("не копирует файлы");
    expect(failureNotice({ kind: "domain", error: { code: "job_has_children", message: "hidden" } })).toContain("подзадачи");
    expect(failureNotice({ kind: "domain", error: { code: "assignee_not_member", message: "hidden" } })).toContain("выбранном отделе");
  });
});

describe("content hash", () => {
  it("hashes an owned copy of the bytes", async () => {
    const bytes = fileBytes({ content: "abc", kind: "text" });
    expect(await sha256Hex(bytes)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("live membership ids and draft revision", () => {
  it("maps department lead and members as agent ids", () => {
    const [department] = mapDepartments(snapshot);
    expect(department?.lead).toBe("agt_writer01");
    expect(department?.members).toEqual(["agt_writer01"]);
    const [project] = mapProjects(snapshot);
    expect(project?.members).toEqual(["dep_editorial"]);
  });

  it("rejects department persist by name when two agents share it", async () => {
    const twins: WorkspaceSnapshot = {
      ...snapshot,
      agents: [
        snapshot.agents[0]!,
        { ...snapshot.agents[0]!, id: "agt_writer02", name: "Анна", currentVersionId: "ver_writer02" },
      ],
    };
    const [current] = mapDepartments(twins);
    const calls: unknown[] = [];
    const api = { saveDepartmentProfile: async (input: unknown) => { calls.push(input); return { ok: true as const, value: {} }; } };
    const byName = await persistDepartmentPatch(api as never, twins, current!, { ...current!, lead: "Анна", members: ["Анна"] });
    expect(byName.ok).toBe(false);
    if (!byName.ok) expect(byName.failure).toMatchObject({ kind: "domain", error: { code: "not_found" } });
    expect(calls).toEqual([]);
    const saved = await persistDepartmentPatch(api as never, twins, current!, {
      ...current!,
      lead: "agt_writer02",
      members: ["agt_writer02"],
    });
    expect(saved).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({
      expectedRevision: 1,
      leadAgentId: "agt_writer02",
      memberships: [{ agentId: "agt_writer02", role: "lead" }],
    });
  });

  it("rejects unknown project department instead of dropping it", async () => {
    const [current] = mapProjects(snapshot);
    const calls: unknown[] = [];
    const api = { linkDepartment: async (input: unknown) => { calls.push(input); return { ok: true as const, value: {} }; } };
    const dropped = await persistProjectPatch(api as never, snapshot, current!, { ...current!, members: ["Редакция"] });
    expect(dropped.ok).toBe(false);
    if (!dropped.ok) expect(dropped.failure).toMatchObject({ kind: "domain", error: { code: "not_found" } });
    expect(calls).toEqual([]);
  });

  it("links a department by binding and department id and refuses unlink", async () => {
    const withQa: WorkspaceSnapshot = {
      ...snapshot,
      departments: [
        snapshot.departments[0]!,
        { id: "dep_468af0be3f702bf15d41b2f2", name: "QA отдел", leadAgentId: "agt_writer01", processVersionId: "prc_editorial", revision: 1, updatedAt: "2026-09-14T00:00:00Z" },
      ],
    };
    const [current] = mapProjects(withQa);
    expect(current?.members).toEqual(["dep_editorial"]);
    const calls: { bindingId: string; departmentId: string }[] = [];
    const api = {
      linkDepartment: async (input: { bindingId: string; departmentId: string }) => {
        calls.push({ bindingId: input.bindingId, departmentId: input.departmentId });
        return { ok: true as const, value: { bindingId: input.bindingId, departmentId: input.departmentId } };
      },
    };
    const linked = await persistProjectPatch(api as never, withQa, current!, {
      ...current!,
      members: ["dep_editorial", "dep_468af0be3f702bf15d41b2f2"],
    });
    expect(linked).toEqual({ ok: true });
    expect(calls).toEqual([{ bindingId: "bnd_project01", departmentId: "dep_468af0be3f702bf15d41b2f2" }]);
    const removed = await persistProjectPatch(api as never, withQa, current!, { ...current!, members: ["dep_468af0be3f702bf15d41b2f2"] });
    expect(removed.ok).toBe(false);
    if (!removed.ok) expect(removed.failure).toMatchObject({ kind: "domain", error: { code: "unlink_unsupported" } });
    expect(calls).toHaveLength(1);
    expect(failureNotice({ kind: "domain", error: { code: "unlink_unsupported", message: "hidden" } })).toContain("Снять отдел");
  });

  it("refuses agent save when draft revision is behind the server record", async () => {
    const [current] = mapAgents(snapshot);
    const newer = { ...snapshot, agents: [{ ...snapshot.agents[0]!, revision: 4 }] };
    const calls: unknown[] = [];
    const api = { saveAgentProfile: async (input: unknown) => { calls.push(input); return { ok: true as const, value: {} }; } };
    const stale = await persistAgentPatch(api as never, newer, { ...current!, revision: 4 }, { ...current!, revision: 1, role: "Новая роль" });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.failure).toMatchObject({ kind: "revision_conflict", conflict: { expectedRevision: 1, actualRevision: 4 } });
    expect(calls).toEqual([]);
    expect(agentDraftStale({ ...current!, revision: 1 }, { ...current!, revision: 4 })).toBe(true);
    expect(agentDraftStale({ ...current!, revision: 1 }, { ...current!, revision: 1 })).toBe(false);
  });
});

describe("preview restore", () => {
  it("uses Original only without hostId or unresolved identity", () => {
    expect(openerHostId({})).toBeNull();
    expect(shouldUseHostOriginal(null)).toBe(true);
    expect(shouldUseHostOriginal("host_mini", "preview_unresolved")).toBe(true);
    expect(shouldUseHostOriginal("host_mini", "preview_mismatch")).toBe(false);
    expect(shouldUseHostOriginal("host_mini", "preview_ambiguous")).toBe(false);
  });

  it("opens bytes after resolve and rejects a mismatched open target", async () => {
    const previewPath = "/tmp/agency/.agency/preview/art_brief001/aa.md";
    const resolved = {
      artifactId: "art_brief001",
      jobId: "job_offer0001",
      version: 1,
      hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      mime: "text/markdown",
      size: 3,
      relativePath: "aa.md",
      bindingId: "bnd_project01",
      target: { hostId: "host_mini", path: previewPath },
    };
    const bytes = bytesToBase64(fileBytes({ content: "abc", kind: "text" }));
    const restored = await restoreDocumentFromPreview({
      resolveArtifactPreview: async () => ({ ok: true as const, value: resolved }),
      openArtifact: async () => ({
        ok: true as const,
        value: { hostId: "host_mini", size: 3, hash: resolved.hash, bytesBase64: bytes, target: resolved.target },
      }),
    } as never, { hostId: "host_mini", path: previewPath });
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.value.file.id).toBe("art_brief001");
      expect(restored.value.file.content).toBe("abc");
    }
    const mismatch = await restoreDocumentFromPreview({
      resolveArtifactPreview: async () => ({ ok: true as const, value: resolved }),
      openArtifact: async () => ({
        ok: true as const,
        value: { hostId: "host_mini", size: 3, hash: resolved.hash, bytesBase64: bytes, target: { hostId: "host_mini", path: "/other.md" } },
      }),
    } as never, { hostId: "host_mini", path: previewPath });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.failure).toMatchObject({ kind: "domain", error: { code: "preview_mismatch" } });
  });

  it("keeps the restored draft after save failure and ignores a second in-flight save", () => {
    const file = { id: "art_brief001", name: "aa.md", size: 3, content: "abc", kind: "text" as const, version: 1 };
    const started = startRestoredSave({
      document: { file, jobId: "job_offer0001", bindingId: "bnd_project01" },
      draft: "новый черновик",
      saveError: null,
      saving: false,
    });
    expect(started?.saving).toBe(true);
    expect(startRestoredSave(started!)).toBeNull();
    const failed = applyRestoredSaveResult(started!, {
      ok: false,
      failure: { kind: "domain", error: { code: "unavailable", message: "Сервер отклонил версию." } },
    });
    expect(failed.draft).toBe("новый черновик");
    expect(failed.document.file.content).toBe("abc");
    expect(failed.saving).toBe(false);
    expect(failed.saveError).toContain("Сервер отклонил версию");
  });

  it("reopens the verified target of the saved version, not the old hash path", async () => {
    const oldPath = "/tmp/agency/.agency/preview/art_brief001/old.md";
    const newPath = "/tmp/agency/.agency/preview/art_brief001/new.md";
    const draft = "abcd";
    const hash = await sha256Hex(fileBytes({ content: draft, kind: "text" }));
    const file = { id: "art_brief001", name: "aa.md", size: 3, content: "abc", kind: "text" as const, version: 1, hash: "old" };
    const calls: string[] = [];
    const saved = await commitRestoredDocumentSave({
      publishArtifactVersion: async () => {
        calls.push("publish");
        return {
          ok: true as const,
          value: {
            artifactId: "art_brief001",
            jobId: "job_offer0001",
            version: 2,
            hostId: "host_mini",
            relativePath: "aa.md",
            mime: "text/markdown",
            size: 4,
            hash,
            author: { kind: "system" },
          },
        };
      },
      openArtifact: async (input: { version: number }) => {
        calls.push(`open:${input.version}`);
        return {
          ok: true as const,
          value: {
            hostId: "host_mini",
            size: 4,
            hash,
            bytesBase64: bytesToBase64(fileBytes({ content: draft, kind: "text" })),
            target: { hostId: "host_mini", path: newPath },
          },
        };
      },
    } as never, { jobId: "job_offer0001", bindingId: "bnd_project01", file, content: draft });
    expect(calls).toEqual(["publish", "open:2"]);
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(saved.value.file.version).toBe(2);
      expect(saved.value.file.hash).toBe(hash);
      expect(saved.value.target.path).toBe(newPath);
      expect(saved.value.target.path).not.toBe(oldPath);
    }
  });

  it("hides the live rail by opaque record id, not the display key", () => {
    const live = { id: "AG-1", recordId: "job_offer0001" };
    const demo = { id: "AG-102" };
    expect(live.id).not.toBe(live.recordId);
    expect(documentVisibilityId(live, true)).toBe("job_offer0001");
    expect(documentVisibilityId(live, true)).not.toBe("AG-1");
    expect(documentVisibilityId(demo, false)).toBe("AG-102");
    resetDocumentVisibility();
    claimDocumentPanel("/tmp/agency/.agency/preview/art_brief001/v3.md", "job_offer0001");
    expect(isDocumentPanelVisible("AG-1")).toBe(false);
    expect(isDocumentPanelVisible(documentVisibilityId(live, true))).toBe(true);
    releaseDocumentPanel("/tmp/agency/.agency/preview/art_brief001/v3.md");
    expect(isDocumentPanelVisible("job_offer0001")).toBe(false);
    resetDocumentVisibility();
  });
});

describe("AGY-8 live launch UI", () => {
  const jobReady = {
    recordId: "job_offer0001",
    revision: 3,
    state: "backlog",
    bindingId: "bnd_project01",
    assignedAgentId: "agt_writer01",
  };

  it("enables prepare from job ids and revision, not BB version or instance name", () => {
    expect(liveJobLaunchReady({ ...jobReady, instanceName: "0431", bbVersion: "0.43.1" } as typeof jobReady)).toEqual({
      ok: true,
      jobId: "job_offer0001",
      expectedRevision: 3,
    });
    expect(jobCanRequestLaunch({ ...jobReady, recordId: undefined })).toBe(false);
    expect(liveJobLaunchReady({ ...jobReady, revision: 0 }).ok).toBe(false);
    expect(jobLaunchableState("backlog")).toBe(true);
    expect(jobLaunchableState("Бэклог")).toBe(true);
    expect(jobLaunchableState("К запуску")).toBe(true);
    expect(jobCanRequestLaunch({
      ...jobReady,
      state: "blocked",
      sourceState: "backlog",
    })).toBe(true);
    const mapped = mapJobs({
      ...snapshot,
      jobs: [{
        ...snapshot.jobs[0],
        id: "job_2de115e5c5e8bd8b555a71a3",
        key: "AG-1604",
        state: "backlog",
        assignedAgentId: "agt_b1fe6a357a7e8736a896c649",
        revision: 5,
      }],
    })[0];
    expect(mapped.state).toBe("backlog");
    expect(mapped.sourceState).toBe("backlog");
    const ready = liveJobLaunchReady(mapped);
    expect(ready).toEqual({
      ok: true,
      jobId: "job_2de115e5c5e8bd8b555a71a3",
      expectedRevision: 5,
    });
  });

  it("keeps exact prepareLaunch fail text with domain code", () => {
    expect(formatPrepareLaunchOutcome({
      ok: false,
      failure: { kind: "domain", error: { code: "catalog_role_unresolved", message: "core role missing" } },
    })).toContain("catalog_role_unresolved");
  });

  it("refetches launch readiness after assign and drops stale unassigned response", async () => {
    const before = { recordId: "job_offer0001", revision: 4, assignedAgentId: null as string | null };
    const after = { recordId: "job_offer0001", revision: 5, assignedAgentId: "agt_editor01" };
    expect(jobLaunchRefreshKey(before)).not.toBe(jobLaunchRefreshKey(after));
    expect(liveJobLaunchReady({ ...jobReady, revision: 4, assignedAgentId: null }).ok).toBe(false);
    expect(liveJobLaunchReady({ ...jobReady, revision: 5, assignedAgentId: "agt_editor01" }).ok).toBe(true);
    const gate = createLiveRunsFetchGate();
    let resolveA!: (value: IsolationReadiness) => void;
    const pendingA = new Promise<IsolationReadiness>((resolve) => {
      resolveA = resolve;
    });
    const tokenA = gate.begin(jobLaunchRefreshKey(before));
    const tokenB = gate.begin(jobLaunchRefreshKey(after));
    const applyA = pendingA.then((value) => (gate.accept(tokenA) ? value : null));
    resolveA({
      handshakeReady: false,
      executionAvailable: false,
      isolationReady: false,
      isolatedSpawnFields: false,
      sdkTypedSpawnReady: false,
      provenIsolationProviders: [],
      assignedProvider: null,
      launchAllowedForAssigned: false,
      reason: "job.assignedAgentId is required",
    });
    expect(await applyA).toBeNull();
    expect(gate.accept(tokenA)).toBe(false);
    expect(gate.accept(tokenB)).toBe(true);
    expect(nextLaunchAction({
      jobReady: true,
      handshakeReady: true,
      lastPrepare: null,
      hasLaunchId: false,
    })).toBe("prepare");
  });

  const liveLaunchRows = [{
    jobKey: "AG-102",
    jobRecordId: "job_offer0001",
    attempt: {
      attemptId: "att_1",
      jobId: "job_offer0001",
      attemptNo: 1,
      snapshotId: "snp_1",
      digest: "d",
      threadId: "thr_1",
      launchId: "11111111-1111-4111-8111-111111111111",
      state: "running",
      reportedState: "running",
      revision: 1,
    },
    receipt: {
      launchId: "11111111-1111-4111-8111-111111111111",
      attemptId: "att_1",
      jobId: "job_offer0001",
      snapshotId: "snp_1",
      digest: "d",
      threadId: "thr_1",
      spawnKind: "spawned",
      persistError: null,
      jobBindState: "bound",
      needsReconciliation: false,
    },
  }];

  it("treats unknown as reconcile, never a second spawn", () => {
    expect(mustNotRespawn({ attempt: { state: "unknown" }, launchedKind: "unknown" })).toBe(true);
    expect(launchNeedsReconcile({
      attempt: { state: "unknown" },
      receipt: { needsReconciliation: true, launchId: "11111111-1111-4111-8111-111111111111" },
      launchedKind: "unknown",
    })).toBe(true);
    expect(nextLaunchAction({
      jobReady: true,
      handshakeReady: true,
      lastPrepare: null,
      attemptState: "unknown",
      launchedKind: "unknown",
      hasLaunchId: true,
    })).toBe("reconcile");
    expect(nextLaunchAction({
      jobReady: true,
      handshakeReady: true,
      lastPrepare: null,
      attemptState: "unknown",
      launchedKind: "unknown",
      hasLaunchId: false,
    })).toBe("blocked");
  });

  it("blocks prepare for unknown future_state and keeps attempt fields", () => {
    const raw = {
      attemptId: "att_future",
      jobId: "job_offer0001",
      attemptNo: 2,
      snapshotId: "snp_1",
      digest: "d".repeat(64),
      threadId: "thr_1",
      launchId: "11111111-1111-4111-8111-111111111111",
      state: "future_state",
      revision: 4,
    };
    const parsed = parseRunAttempt(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.attemptId).toBe("att_future");
    expect(parsed?.jobId).toBe("job_offer0001");
    expect(parsed?.attemptNo).toBe(2);
    expect(parsed?.revision).toBe(4);
    expect(parsed?.launchId).toBe(raw.launchId);
    expect(parsed?.reportedState).toBe("future_state");
    expect(parsed?.state).toBe(UNSUPPORTED_ATTEMPT_STATE);
    expect(launchStateLabel(parsed!.state)).toBe(LAUNCH_STATE_UNSUPPORTED);
    expect(launchStateLabel("future_state")).toBe(LAUNCH_STATE_UNSUPPORTED);
    expect(launchStateLabel("future_state")).not.toBe("future_state");
    expect(launchStateLabel("future_state")).not.toBe("");
    const listed = parseJobAttempts({ jobId: "job_offer0001", attempts: [raw] });
    expect(listed).toHaveLength(1);
    expect(listed?.[0]?.attempt.reportedState).toBe("future_state");
    const blocked = {
      jobReady: true,
      handshakeReady: true,
      lastPrepare: null,
      hasLaunchId: true,
    } as const;
    expect(nextLaunchAction({ ...blocked, attemptState: parsed!.state })).toBe("blocked");
    expect(nextLaunchAction({ ...blocked, attemptState: "future_state" })).toBe("blocked");
    expect(nextLaunchAction({ ...blocked, attemptState: "future_state" })).not.toBe("prepare");
    expect(nextLaunchAction({ ...blocked, attemptState: "future_state" })).not.toBe("reconcile");
    for (const state of KNOWN_ACTIVE_ATTEMPT_STATES) {
      expect(nextLaunchAction({ ...blocked, attemptState: state })).toBe("wait");
      expect(nextLaunchAction({ ...blocked, attemptState: state })).not.toBe("prepare");
    }
  });

  it("treats awaiting_review as wait with review label, not spawn or raw wire", () => {
    const raw = {
      attemptId: "att_review",
      jobId: "job_offer0001",
      attemptNo: 1,
      snapshotId: "snp_1",
      digest: "d".repeat(64),
      threadId: "thr_1",
      launchId: "11111111-1111-4111-8111-111111111111",
      state: "awaiting_review",
      revision: 4,
    };
    const parsed = parseRunAttempt(raw);
    expect(parsed?.state).toBe("awaiting_review");
    expect(parsed?.reportedState).toBe("awaiting_review");
    expect(parsed?.attemptId).toBe("att_review");
    expect(launchStateLabel("awaiting_review")).toBe(LAUNCH_STATE_AWAITING_REVIEW);
    expect(launchStateLabel("awaiting_review")).not.toBe("В работе");
    expect(launchStateLabel("awaiting_review")).not.toBe("Готово");
    expect(launchStateLabel("awaiting_review")).not.toBe("awaiting_review");
    expect(launchStateLabel("succeeded")).toBe(LAUNCH_STATE_SUCCEEDED);
    expect(launchStateLabel("succeeded")).not.toBe("Attempt succeeded (сервер)");
    expect(launchStateLabel("succeeded")).not.toBe("succeeded");
    expect(nextLaunchAction({
      jobReady: true,
      handshakeReady: true,
      lastPrepare: null,
      attemptState: "awaiting_review",
      hasLaunchId: true,
      jobState: "done",
    })).toBe("wait");
    expect(mustNotRespawn({ attempt: { state: "awaiting_review" } })).toBe(true);
    const action = nextLaunchAction({
      jobReady: true,
      handshakeReady: true,
      lastPrepare: null,
      attemptState: parsed!.state,
      hasLaunchId: true,
    });
    expect(action).toBe("wait");
    expect(action).not.toBe("prepare");
    expect(action).not.toBe("reconcile");
  });

  it("does not invent succeeded from interpret or idle thread", () => {
    const parsed = parseCompletion({
      runSucceeded: true,
      runFailed: false,
      mayEnterReview: false,
      publishedVerified: false,
      acceptedVerified: false,
      threadStatus: "idle",
      reason: "thread idle is not success",
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.runSucceeded).toBe(false);
    expect(completionNeverSucceeded(parsed!)).toBe(true);
    expect(parsed?.threadStatus).toBe("idle");
  });

  it("parses prepareLaunch and keeps launched null when handshake is unproven", () => {
    const parsed = parsePrepareLaunch({
      handshakeReady: false,
      snapshotId: "snp_1",
      digest: "d".repeat(64),
      attemptId: "att_1",
      launched: null,
      reason: "runtime handshake is not proven; spawn is not called",
    });
    expect(parsed?.handshakeReady).toBe(false);
    expect(parsed?.launched).toBeNull();
    expect(nextLaunchAction({ jobReady: true, handshakeReady: true, lastPrepare: parsed, hasLaunchId: false })).toBe("blocked");
  });

  it("does not enable launch from instance name when handshake bits are false", () => {
    const readiness = parseIsolationReadiness({
      handshakeReady: false,
      executionAvailable: false,
      isolationReady: false,
      isolatedSpawnFields: false,
      sdkTypedSpawnReady: false,
      reason: "runtime handshake is not proven; spawn is not called",
    });
    expect(canLaunchFromReadiness(readiness)).toBe(false);
    expect(readinessAllowsProvider(readiness, "cursor")).toBe(false);
    expect(readinessAllowsProvider({
      handshakeReady: true,
      executionAvailable: true,
      isolationReady: true,
      isolatedSpawnFields: true,
      sdkTypedSpawnReady: true,
      provenIsolationProviders: ["claude-code"],
      assignedProvider: null,
      launchAllowedForAssigned: false,
      reason: "GET proven",
    }, "cursor")).toBe(false);
    expect(readinessAllowsProvider({
      handshakeReady: true,
      executionAvailable: true,
      isolationReady: true,
      isolatedSpawnFields: true,
      sdkTypedSpawnReady: true,
      provenIsolationProviders: ["claude-code"],
      assignedProvider: {
        jobId: "job_offer0001",
        agentId: "agt_writer01",
        agentVersionId: "ver_writer01",
        providerId: "claude-code",
        source: "live_assigned_agent_version",
      },
      launchAllowedForAssigned: true,
      reason: "GET proven",
    }, "claude-code")).toBe(true);
    expect(nextLaunchAction({
      jobReady: true,
      handshakeReady: canLaunchFromReadiness(readiness),
      lastPrepare: null,
      hasLaunchId: false,
    })).toBe("blocked");
  });

  it("gates launch on assignee providerId and does not default provenIsolationProviders", () => {
    const claudeNote = "isolation proven only for claude-code; readiness does not grant launch for other providers";
    const missingField = parseIsolationReadiness({
      handshakeReady: true,
      executionAvailable: true,
      isolationReady: true,
      isolatedSpawnFields: true,
      sdkTypedSpawnReady: true,
      reason: claudeNote,
    });
    expect(missingField).toBeNull();
    expect(readinessAllowsProvider(missingField, "claude-code")).toBe(false);
    expect(readinessAllowsProvider(missingField, null)).toBe(false);
    const assignedCodex = {
      jobId: "job_offer0001",
      agentId: "agt_writer01",
      agentVersionId: "ver_writer01",
      providerId: "codex",
      source: "live_assigned_agent_version" as const,
    };
    const readyBitsWrongAssignee = parseIsolationReadiness({
      handshakeReady: true,
      executionAvailable: true,
      isolationReady: true,
      isolatedSpawnFields: true,
      sdkTypedSpawnReady: true,
      provenIsolationProviders: ["claude-code"],
      assignedProvider: assignedCodex,
      launchAllowedForAssigned: false,
      reason: claudeNote,
    });
    expect(readinessAllowsProvider(readyBitsWrongAssignee, "codex")).toBe(false);
    expect(launchReadinessNotice(readyBitsWrongAssignee, "codex")).toBe(PRODUCT_CLAUDE_ONLY);
    expect(launchAssigneeProviderId(readyBitsWrongAssignee)).toBe("codex");
    const assignedClaude = { ...assignedCodex, providerId: "claude-code" };
    const readyClaude = parseIsolationReadiness({
      handshakeReady: true,
      executionAvailable: true,
      isolationReady: true,
      isolatedSpawnFields: true,
      sdkTypedSpawnReady: true,
      provenIsolationProviders: ["claude-code"],
      assignedProvider: assignedClaude,
      launchAllowedForAssigned: true,
      reason: claudeNote,
    });
    expect(readinessAllowsProvider(readyClaude, "claude-code")).toBe(true);
    expect(launchReadinessNotice(readyClaude, "claude-code")).toBeNull();
    expect(launchAssigneeProviderId(null)).toBeNull();
    expect(nextLaunchAction({
      jobReady: true,
      handshakeReady: jobLaunchAllowedFromReadiness(readyBitsWrongAssignee),
      lastPrepare: null,
      hasLaunchId: false,
    })).toBe("blocked");
  });

  it("keeps an empty launch list when the method is missing, never fake rows", async () => {
    expect(parseJobAttempts({ jobId: "job_offer0001", attempts: [] })).toEqual([]);
    expect(parseJobAttempts({ items: [] })).toBeNull();
    const api = createRpcAgencyApi({
      call: async () => {
        throw new Error("unknown rpc method listJobAttempts");
      },
    });
    const listed = await api.listJobAttempts({ jobId: "job_offer0001" });
    expect(listed.ok).toBe(false);
    if (!listed.ok && listed.failure.kind === "unavailable") {
      expect(listed.failure.message).toBe(LAUNCH_LIST_UNREGISTERED);
    }
  });

  it("routes a live launch by launchId or attemptId only", () => {
    expect(resolveLiveLaunchRoute("11111111-1111-4111-8111-111111111111", liveLaunchRows).kind).toBe("detail");
    expect(resolveLiveLaunchRoute("att_1", liveLaunchRows).kind).toBe("detail");
    expect(resolveLiveLaunchRoute("RUN-204", liveLaunchRows)).toEqual({ kind: "missing" });
  });

  it("separates loading, error, unavailable and empty from a ready list", () => {
    const start = { status: "loading" as const, items: [] };
    expect(nextLiveRunsCatalog(start, { kind: "ok", items: [] })).toEqual({ status: "empty", items: [] });
    expect(nextLiveRunsCatalog(start, { kind: "unavailable" }).status).toBe("unavailable");
    expect(nextLiveRunsCatalog(start, { kind: "error" })).toEqual({ status: "error", items: [] });
    expect(nextLiveRunsCatalog({ status: "ready", items: liveLaunchRows }, { kind: "error" })).toEqual({
      status: "error",
      items: liveLaunchRows,
    });
    expect(nextLiveRunsCatalog(start, { kind: "ok", items: liveLaunchRows }).status).toBe("ready");
    expect(liveRunsListCopy("error").title).not.toBe(liveRunsListCopy("empty").title);
    expect(liveRunsPageDescription("error", false)).toBe(LIVE_RUNS_COPY.error.description);
    expect(liveRunsPageDescription("error", true)).toBe(LIVE_RUNS_COPY.error.description);
    expect(liveRunsPageDescription("ready", true)).toBe(LIVE_RUNS_COPY.ready.description);
    expect(liveRunsPageDescription("ready", true)).not.toContain("listJobAttempts");
    expect(liveRunsPageDescription("unavailable", false)).not.toBe(STAGE1_UNAVAILABLE.runs);
  });

  it("keeps a receipt as receipt when the attempt is not in the scoped list", () => {
    const receipt = liveLaunchRows[0]!.receipt!;
    const view = liveLaunchFromReceipt(receipt, [], "AG-102");
    expect(view.kind).toBe("receipt");
    if (view.kind === "receipt") {
      expect(view.receipt.jobBindState).toBe("bound");
      expect("attempt" in view).toBe(false);
    }
    expect(liveLaunchFromReceipt(receipt, liveLaunchRows, "AG-102").kind).toBe("attempt");
    const matched = liveLaunchFromReceipt(receipt, liveLaunchRows, "AG-102");
    if (matched.kind === "attempt") {
      expect(matched.row.attempt.attemptNo).toBe(1);
      expect(matched.row.attempt.revision).toBe(1);
      expect(matched.row.attempt.state).toBe("running");
    }
  });

  it("drops stale list A after jobsKey B even if A resolves later", async () => {
    const gate = createLiveRunsFetchGate();
    let resolveA!: (value: { kind: "ok"; items: typeof liveLaunchRows }) => void;
    const pendingA = new Promise<{ kind: "ok"; items: typeof liveLaunchRows }>((resolve) => {
      resolveA = resolve;
    });
    const tokenA = gate.begin("jobs-a");
    const tokenB = gate.begin("jobs-b");
    const applyA = pendingA.then((load) => (
      gate.accept(tokenA) ? nextLiveRunsCatalog({ status: "loading", items: [] }, load) : null
    ));
    resolveA({ kind: "ok", items: liveLaunchRows });
    expect(await applyA).toBeNull();
    expect(gate.accept(tokenA)).toBe(false);
    expect(gate.accept(tokenB)).toBe(true);
    expect(nextLiveRunsCatalog({ status: "loading", items: [] }, { kind: "ok", items: liveLaunchRows }).status).toBe("ready");
    gate.unmount();
    expect(gate.accept(tokenB)).toBe(false);
    gate.begin("jobs-c");
    expect(gate.accept({ generation: 3, jobsKey: "jobs-c" })).toBe(false);
  });

  it("opens a live launch from getLaunch plus listJobAttempts, not invented attempt fields", async () => {
    const receipt = liveLaunchRows[0]!.receipt!;
    const api = createRpcAgencyApi({
      call: async (method) => {
        if (method === "getLaunch") return { ok: true, value: receipt };
        if (method === "listJobAttempts") {
          return { ok: true, value: { jobId: receipt.jobId, attempts: [liveLaunchRows[0]!.attempt] } };
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    const opened = await openLiveLaunch(api, receipt.launchId, [{ id: "AG-102", recordId: "job_offer0001" }]);
    expect(opened.status).toBe("ok");
    if (opened.status === "ok" && opened.view.kind === "attempt") {
      expect(opened.view.row.attempt.attemptNo).toBe(1);
      expect(opened.view.row.attempt.state).not.toBe(receipt.jobBindState);
    }
    const receiptOnly = createRpcAgencyApi({
      call: async (method) => {
        if (method === "getLaunch") return { ok: true, value: receipt };
        if (method === "listJobAttempts") return { ok: true, value: { jobId: receipt.jobId, attempts: [] } };
        throw new Error(`unexpected ${method}`);
      },
    });
    const openedReceipt = await openLiveLaunch(receiptOnly, receipt.launchId, [{ id: "AG-102", recordId: "job_offer0001" }]);
    expect(openedReceipt).toEqual({ status: "ok", view: { kind: "receipt", receipt, jobKey: "AG-102" } });
    const missing = await openLiveLaunch(createRpcAgencyApi({
      call: async () => ({ ok: false, error: { code: "not_found", message: "missing" } }),
    }), receipt.launchId, []);
    expect(missing.status).toBe("missing");
  });
});
