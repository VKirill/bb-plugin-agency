import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { catalogRolesFromListed, resolveCatalogRoles } from "../src/server/runtime/isolated-sdk/catalog-port";
import { interpretVerifiedCompletion, verifyOpenedCurrentVersion } from "../src/server/runtime/isolated-sdk/completion";
import { createIsolatedThreadVerifyPort, type IsolatedThreadView } from "../src/server/runtime/isolated-sdk/sdk-ports";
import { spawnArgsFromContract } from "../src/server/runtime/isolated-sdk/spawn-args";
import type { LaunchContract } from "../src/server/runtime/launch/ports";
import type { ContextSnapshot } from "../src/server/runtime/context-snapshot/types";
import type { CatalogSkillId } from "../src/shared/contracts/ids";
import { interpretWorkerCompletionRpcSchema } from "../src/shared/rpc-contract";
import { hashBytes } from "../src/host/guarded-fs";
import type { ArtifactVersion } from "../src/shared/contracts/artifact";

const AGENCY =
  "skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff" as CatalogSkillId;
const HELPER =
  "skill_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as CatalogSkillId;
function launchContract(): LaunchContract {
  return {
    snapshotId: "snp_aaaaaaaaaaaaaaaaaaaaaaaa",
    digest: "d".repeat(64),
    attemptId: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
    launchId: randomUUID(),
    providerId: "codex",
    model: "gpt-5.6",
    skillIds: [AGENCY, HELPER],
    mcpIds: [],
    hostId: "host_mini",
    canonicalRoot: "/tmp/agency-root",
    environmentId: "env_1",
    bbProjectId: "proj_trusted",
  };
}

function snapshot(): ContextSnapshot {
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
    job: {
      id: "job_aaaaaaaaaaaa",
      key: "AG-1",
      title: "T",
      revision: 1,
      departmentId: "dep_aaaaaaaa",
      assignedAgentId: "agt_aaaaaaaa",
      briefHash: "b".repeat(64),
      acceptanceHash: "c".repeat(64),
    },
    agentVersion: {
      id: "avr_aaaaaaaa",
      agentId: "agt_aaaaaaaa",
      version: 1,
      providerId: "codex",
      model: "gpt-5.6",
      role: "editor",
      instructionsHash: "i".repeat(64),
    },
    selectedSkills: [],
    selectedMcps: [],
  } as unknown as ContextSnapshot;
}

function serverThread(
  input: Partial<IsolatedThreadView> & { launchId?: string; jobId?: string } = {},
): IsolatedThreadView {
  const { launchId, jobId, ...over } = input;
  return {
    id: "thr_aaaaaaaa",
    status: "idle",
    projectId: "proj_trusted",
    providerId: "codex",
    model: "gpt-5.6",
    environmentId: "env_1",
    pluginMetadata: {
      ...(launchId ? { agencyLaunchId: launchId } : {}),
      agencyAttemptId: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      agencyJobId: jobId ?? "job_aaaaaaaaaaaa",
    },
    host: { id: "host_mini" },
    environment: { id: "env_1", hostId: "host_mini", path: "/tmp/agency-root" },
    ...over,
  };
}

function threadsApi(getImpl: () => Promise<IsolatedThreadView>) {
  return {
    async spawn() {
      throw new Error("unused");
    },
    get: getImpl,
    async list() {
      return [];
    },
  };
}

describe("isolated wiring", () => {
  it("builds typed spawn args with plugin origin, hidden visibility and pluginMetadata", () => {
    const contract = launchContract();
    const built = spawnArgsFromContract(contract, snapshot(), "job_aaaaaaaaaaaa");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.visibility).toBe("hidden");
    expect(built.value.origin).toBe("plugin");
    expect(built.value.originPluginId).toBe("agency");
    expect(built.value.pluginMetadata).toEqual({
      agencyLaunchId: contract.launchId,
      agencyAttemptId: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      agencyJobId: "job_aaaaaaaaaaaa",
    });
    const prompt = built.value.prompt;
    // BB titles the hidden thread from the first line, so it names the job.
    expect(prompt.split("\n")[0]).toBe("AG-1: T");
    expect(prompt).toContain(".agency/jobs/AG-1/TASK.md");
    expect(prompt).toContain("bb agency job submit");
    expect(prompt).not.toContain("leave a closing job comment");
    expect(prompt).not.toContain("## Agency rules (agency)");
    expect(prompt).not.toContain("## Job (job)");
    expect(prompt).not.toContain("(platform)");
    expect(prompt).not.toContain("handoff none");
    expect("isolatedSkillDelivery" in built.value).toBe(false);
    expect("experimental_callerLaunchId" in built.value).toBe(false);
    expect("skillIds" in built.value).toBe(false);
  });

  it("does not fill missing get host/path/project/provider from snapshot", async () => {
    const launchId = randomUUID();
    const port = createIsolatedThreadVerifyPort(
      threadsApi(async () =>
        serverThread({
          launchId,
          host: null,
          environment: { id: "env_1", hostId: "", path: null },
          projectId: undefined,
          providerId: undefined,
        }),
      ),
      true,
    );
    const outcome = await port.verifyConfirmedThread(
      {
        launchId,
        attemptId: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
        threadId: "thr_aaaaaaaa",
        jobId: "job_aaaaaaaaaaaa",
        snapshotId: "snp_aaaaaaaaaaaaaaaaaaaaaaaa",
        digest: "d".repeat(64),
      },
      snapshot(),
    );
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind === "unavailable") expect(outcome.code).toBe("live_binding_incomplete");
  });

  it("rejects foreign pluginMetadata job id", async () => {
    const launchId = randomUUID();
    const port = createIsolatedThreadVerifyPort(
      threadsApi(async () =>
        serverThread({
          pluginMetadata: {
            agencyLaunchId: launchId,
            agencyAttemptId: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
            agencyJobId: "job_foreignzzzz",
          },
        }),
      ),
      true,
    );
    const outcome = await port.verifyConfirmedThread(
      {
        launchId,
        attemptId: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
        threadId: "thr_aaaaaaaa",
        jobId: "job_aaaaaaaaaaaa",
        snapshotId: "snp_aaaaaaaaaaaaaaaaaaaaaaaa",
        digest: "d".repeat(64),
      },
      snapshot(),
    );
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") expect(outcome.code).toBe("caller_job_mismatch");
  });

  it("rejects a foreign agencyJobId", async () => {
    const launchId = randomUUID();
    const port = createIsolatedThreadVerifyPort(
      threadsApi(async () =>
        serverThread({
          launchId,
          jobId: "job_foreignzzzz",
        }),
      ),
      true,
    );
    const outcome = await port.verifyConfirmedThread(
      {
        launchId,
        attemptId: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
        threadId: "thr_aaaaaaaa",
        jobId: "job_aaaaaaaaaaaa",
        snapshotId: "snp_aaaaaaaaaaaaaaaaaaaaaaaa",
        digest: "d".repeat(64),
      },
      snapshot(),
    );
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") expect(outcome.code).toBe("caller_job_mismatch");
  });

  it("rejects model mismatch from actual get and confirms a complete server thread", async () => {
    const launchId = randomUUID();
    const bad = createIsolatedThreadVerifyPort(
      threadsApi(async () => serverThread({ launchId, model: "other-model" })),
      true,
    );
    const badOut = await bad.verifyConfirmedThread(
      {
        launchId,
        attemptId: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
        threadId: "thr_aaaaaaaa",
        jobId: "job_aaaaaaaaaaaa",
        snapshotId: "snp_aaaaaaaaaaaaaaaaaaaaaaaa",
        digest: "d".repeat(64),
      },
      snapshot(),
    );
    expect(badOut.kind).toBe("rejected");
    const okPort = createIsolatedThreadVerifyPort(
      threadsApi(async () => serverThread({ launchId })),
      true,
    );
    const okOut = await okPort.verifyConfirmedThread(
      {
        launchId,
        attemptId: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
        threadId: "thr_aaaaaaaa",
        jobId: "job_aaaaaaaaaaaa",
        snapshotId: "snp_aaaaaaaaaaaaaaaaaaaaaaaa",
        digest: "d".repeat(64),
      },
      snapshot(),
    );
    expect(okOut.kind).toBe("confirmed");
  });

  it("does not treat idle as review without a hash-verified current artifact", () => {
    const idle = interpretVerifiedCompletion({
      threadStatus: "idle",
      publishedVerified: false,
      acceptedVerified: false,
    });
    expect(idle.mayEnterReview).toBe(false);
    expect(idle.runSucceeded).toBe(false);
    const published = interpretVerifiedCompletion({
      threadStatus: "idle",
      publishedVerified: true,
      acceptedVerified: false,
    });
    expect(published.mayEnterReview).toBe(true);
    expect(published.runSucceeded).toBe(false);
  });

  it("rejects caller publishedCurrentVersion / threadStatus flags on the public schema", () => {
    expect(
      interpretWorkerCompletionRpcSchema.safeParse({
        threadStatus: "idle",
        publishedCurrentVersion: true,
      }).success,
    ).toBe(false);
    expect(
      interpretWorkerCompletionRpcSchema.safeParse({
        jobId: "job_aaaaaaaaaaaa",
        publishedCurrentVersion: true,
      }).success,
    ).toBe(false);
    expect(interpretWorkerCompletionRpcSchema.safeParse({ jobId: "job_aaaaaaaaaaaa" }).success).toBe(true);
  });

  it("fails missing or tampered artifact bytes against the stored current version", () => {
    const bytes = new TextEncoder().encode("good-bytes");
    const hash = hashBytes(bytes);
    const version: ArtifactVersion = {
      artifactId: "art_aaaaaaaa",
      jobId: "job_aaaaaaaaaaaa",
      version: 1,
      hostId: "host_mini",
      relativePath: "out.md",
      mime: "text/plain",
      size: bytes.byteLength,
      hash,
      author: { kind: "system" },
    };
    expect(verifyOpenedCurrentVersion({ version: null, opened: null, jobId: "job_aaaaaaaaaaaa" }).ok).toBe(false);
    expect(
      verifyOpenedCurrentVersion({
        version,
        opened: { bytes: new TextEncoder().encode("tampered"), hash, size: bytes.byteLength },
        jobId: "job_aaaaaaaaaaaa",
      }).ok,
    ).toBe(false);
    expect(
      verifyOpenedCurrentVersion({
        version,
        opened: { bytes, hash, size: bytes.byteLength },
        jobId: "job_aaaaaaaaaaaa",
      }).ok,
    ).toBe(true);
  });

  it("resolves catalog roles by unique plugin sources", () => {
    const roles = catalogRolesFromListed([
      { id: AGENCY, name: "agency", pluginId: "agency", source: "plugin:agency" },
      { id: HELPER, name: "agency-artifacts", pluginId: "agency-artifacts", source: "plugin:agency-artifacts" },
    ]);
    expect(roles.ok).toBe(true);
  });

  it("does not silently pick a unique bb-user helper by name", () => {
    const silent = catalogRolesFromListed([
      { id: AGENCY, name: "agency", pluginId: "agency", source: "plugin:agency" },
      { id: HELPER, name: "agency-artifacts", pluginId: "", source: "bb-user" },
    ]);
    expect(silent.ok).toBe(false);
    if (silent.ok) throw new Error("expected unresolved helper");
    expect(silent.error.code).toBe("catalog_role_unresolved");
    const explicit = resolveCatalogRoles(
      [
        { id: AGENCY, name: "agency", pluginId: "agency", source: "plugin:agency" },
        { id: HELPER, name: "agency-artifacts", pluginId: "", source: "bb-user" },
      ],
      { core: { id: AGENCY, source: "plugin:agency" }, helpers: [{ id: HELPER, source: "bb-user" }] },
    );
    expect(explicit.ok).toBe(true);
  });
});
