import { mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Job, ProjectBinding } from "../src/shared/contracts";
import {
  createMemoryMetadataPort,
  createArtifactStorage,
  snapshotMemoryMetadata,
  withCommitFailure,
} from "../src/server/artifacts";
import {
  createLocalHostFilePort,
  createSdkHostFilePort,
  handleHostFileOp,
  originalRelativePath,
  previewFileExtension,
  previewRelativePath,
} from "../src/host";
import type { HostFileOpInput } from "../src/host";

const requestId = "11111111-1111-4111-8111-111111111111";
const bytes = Buffer.from("# offer\n", "utf8");
const hash = createHash("sha256").update(bytes).digest("hex");

const binding: ProjectBinding = {
  id: "bnd_selfy001",
  bbProjectId: "proj_trusted",
  environmentId: "env_ucx7sb57rs",
  hostId: "host_mini",
  canonicalRoot: "/tmp/unused",
  policyVersionId: "pol_00000001",
  sectionId: null,
  revision: 1,
  updatedAt: "2026-09-14T00:00:00Z",
};

const job: Job = {
  id: "job_brief001",
  key: "AG-102",
  bindingId: "bnd_selfy001",
  departmentId: "dep_abcd1234",
  title: "Бриф",
  brief: "Собрать бриф",
  acceptance: "Файл принят",
  state: "backlog",
  parentJobId: null,
  assignedAgentId: "agt_writer01",
  reviewerAgentIds: [],
  observerAgentIds: [],
  priority: "normal",
  dueAt: null,
  revision: 1,
  updatedAt: "2026-09-14T00:00:00Z",
};

const roots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function command(overrides: Record<string, unknown> = {}) {
  return {
    requestId,
    artifactId: "art_brief001",
    jobId: "job_brief001",
    hostId: "host_mini",
    relativePath: "briefs/offer.md",
    mime: "text/markdown",
    size: bytes.byteLength,
    hash,
    author: { kind: "user" as const, userId: "usr_owner" },
    bytes,
    ...overrides,
  };
}

async function setup(hostId = "host_mini") {
  const canonicalRoot = await tempDir("agency-art-");
  const previewRoot = await tempDir("agency-prev-");
  const metadata = createMemoryMetadataPort({
    jobs: [job],
    bindings: [{ ...binding, canonicalRoot, hostId }],
    artifacts: [],
    versions: [],
    intents: [],
  });
  const files = createLocalHostFilePort(hostId);
  const previewFiles = createLocalHostFilePort(hostId);
  const storage = createArtifactStorage({ metadata, files, previewFiles, previewRoot });
  return { canonicalRoot, previewRoot, metadata, files, previewFiles, storage };
}

describe("artifact storage", () => {
  it("publishes immutable bytes under the trusted binding root", async () => {
    const { storage, canonicalRoot } = await setup();
    const published = await storage.publish(command());
    expect(published).toMatchObject({ ok: true, value: { version: 1, hash, relativePath: "briefs/offer.md" } });
    if (!published.ok) return;
    const opened = await storage.openOriginal("art_brief001", "job_brief001", 1);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(Buffer.from(opened.value.bytes).toString("utf8")).toBe("# offer\n");
    expect(opened.value.physicalPath).toBe(originalRelativePath("art_brief001", 1));
    const onDisk = await readFile(join(canonicalRoot, opened.value.physicalPath));
    expect(onDisk.equals(bytes)).toBe(true);
  });

  it("rejects a symlink that escapes the binding root", async () => {
    const { canonicalRoot } = await setup();
    const outside = await tempDir("agency-out-");
    await symlink(outside, join(canonicalRoot, "leak"));
    const escaped = await createLocalHostFilePort("host_mini").writeAtomic(canonicalRoot, "leak/secret.md", bytes);
    expect(escaped).toMatchObject({ ok: false, error: { code: "path_escape" } });
    await expect(readFile(join(outside, "secret.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps one complete winner when two writers race the same dest", async () => {
    const root = await tempDir("agency-race-");
    const files = createLocalHostFilePort("host_mini");
    const leftBytes = Buffer.from("left-writer");
    const rightBytes = Buffer.from("right-writer");
    const [left, right] = await Promise.all([
      files.writeAtomic(root, "race/out.md", leftBytes),
      files.writeAtomic(root, "race/out.md", rightBytes),
    ]);
    const outcomes = [left, right];
    expect(outcomes.filter((row) => row.ok)).toHaveLength(1);
    expect(outcomes.filter((row) => !row.ok && row.error.code === "artifact_immutable")).toHaveLength(1);
    const onDisk = await readFile(join(root, "race/out.md"));
    expect(onDisk.equals(leftBytes) || onDisk.equals(rightBytes)).toBe(true);
    expect(onDisk.includes(Buffer.from("left-writer")) && onDisk.includes(Buffer.from("right-writer"))).toBe(false);
  });

  it("rejects a command host that is not the binding host", async () => {
    const { storage } = await setup("host_mini");
    const published = await storage.publish(command({ hostId: "host_ovh" }));
    expect(published).toMatchObject({ ok: false, error: { code: "host_mismatch" } });
  });

  it("rejects a local adapter labeled for another host", async () => {
    const canonicalRoot = await tempDir("agency-art-");
    const previewRoot = await tempDir("agency-prev-");
    const metadata = createMemoryMetadataPort({
      jobs: [job],
      bindings: [{ ...binding, canonicalRoot, hostId: "host_ovh" }],
      artifacts: [],
      versions: [],
      intents: [],
    });
    const storage = createArtifactStorage({
      metadata,
      files: createLocalHostFilePort("host_mini"),
      previewFiles: createLocalHostFilePort("host_mini"),
      previewRoot,
    });
    expect(await storage.publish(command({ hostId: "host_ovh" }))).toMatchObject({
      ok: false, error: { code: "host_adapter_mismatch" },
    });
  });

  it("hashes actual bytes and does not write on mismatch", async () => {
    const { storage, canonicalRoot } = await setup();
    const published = await storage.publish(command({ hash: "b".repeat(64) }));
    expect(published).toMatchObject({ ok: false, error: { code: "artifact_hash_mismatch" } });
    await expect(readFile(join(canonicalRoot, originalRelativePath("art_brief001", 1)))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("conflicts a reused requestId that only shares the hash", async () => {
    const { storage } = await setup();
    expect((await storage.publish(command())).ok).toBe(true);
    expect(await storage.publish(command({
      artifactId: "art_other001",
      jobId: "job_brief001",
      relativePath: "briefs/other.md",
      mime: "text/plain",
      author: { kind: "run", runId: "run_00000001" },
    }))).toMatchObject({ ok: false, error: { code: "request_conflict" } });
  });

  it("reserves distinct versions atomically for concurrent publishes", async () => {
    const { metadata } = await setup();
    const draft = {
      artifactId: "art_brief001",
      jobId: "job_brief001",
      bindingId: "bnd_selfy001",
      hostId: "host_mini",
      canonicalRoot: "/tmp/root",
      bindingRevision: 1,
      relativePath: "briefs/offer.md",
      mime: "text/markdown",
      size: bytes.byteLength,
      hash,
      author: { kind: "user" as const, userId: "usr_owner" },
    };
    const reserve = metadata.reservePublish.bind(metadata);
    const [first, second] = await Promise.all([
      reserve({ ...draft, requestId: randomUUID() }),
      reserve({ ...draft, requestId: randomUUID() }),
    ]);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(new Set([first.value.version, second.value.version])).toEqual(new Set([1, 2]));
  });

  it("retries a pending write when the original already matches", async () => {
    const canonicalRoot = await tempDir("agency-art-");
    const previewRoot = await tempDir("agency-prev-");
    const inner = createMemoryMetadataPort({
      jobs: [job],
      bindings: [{ ...binding, canonicalRoot }],
      artifacts: [],
      versions: [],
      intents: [],
    });
    const failing = createArtifactStorage({
      metadata: withCommitFailure(inner, { code: "metadata_unavailable", message: "injected" }),
      files: createLocalHostFilePort("host_mini"),
      previewFiles: createLocalHostFilePort("host_mini"),
      previewRoot,
    });
    expect(await failing.publish(command())).toMatchObject({
      ok: false, error: { code: "metadata_unavailable" },
    });
    expect(inner.state.intents[0]?.state).toBe("pending");
    const storage = createArtifactStorage({
      metadata: inner,
      files: createLocalHostFilePort("host_mini"),
      previewFiles: createLocalHostFilePort("host_mini"),
      previewRoot,
    });
    expect(await storage.publish(command())).toMatchObject({ ok: true, value: { version: 1, hash } });
    expect(inner.state.intents[0]?.state).toBe("committed");
  });

  it("leaves pending after a transport error", async () => {
    const { metadata, previewRoot } = await setup();
    const files = {
      hostId: "host_mini",
      kind: "sdk-host" as const,
      writeAtomic: async () => ({ ok: false as const, error: { code: "host_transport", message: "offline" } }),
      read: async () => ({ ok: false as const, error: { code: "host_transport", message: "offline" } }),
      stat: async () => ({ ok: false as const, error: { code: "host_transport", message: "offline" } }),
      remove: async () => ({ ok: false as const, error: { code: "host_transport", message: "offline" } }),
    };
    const storage = createArtifactStorage({
      metadata,
      files,
      previewFiles: createLocalHostFilePort("host_mini"),
      previewRoot,
    });
    expect(await storage.publish(command())).toMatchObject({
      ok: false, error: { code: "host_transport" },
    });
    expect(metadata.state.intents[0]).toMatchObject({ state: "pending" });
  });

  it("recovers a pending publish after a metadata error and restart", async () => {
    const canonicalRoot = await tempDir("agency-art-");
    const previewRoot = await tempDir("agency-prev-");
    const inner = createMemoryMetadataPort({
      jobs: [job],
      bindings: [{ ...binding, canonicalRoot }],
      artifacts: [],
      versions: [],
      intents: [],
    });
    const failing = createArtifactStorage({
      metadata: withCommitFailure(inner, { code: "metadata_unavailable", message: "injected" }),
      files: createLocalHostFilePort("host_mini"),
      previewFiles: createLocalHostFilePort("host_mini"),
      previewRoot,
    });
    expect(await failing.publish(command())).toMatchObject({
      ok: false, error: { code: "metadata_unavailable" },
    });
    const restarted = createArtifactStorage({
      metadata: createMemoryMetadataPort(snapshotMemoryMetadata(inner)),
      files: createLocalHostFilePort("host_mini"),
      previewFiles: createLocalHostFilePort("host_mini"),
      previewRoot,
    });
    const recovered = await restarted.reconcile();
    expect(recovered).toMatchObject({ ok: true, value: [{ version: 1, hash }] });
    expect(await restarted.openOriginal("art_brief001", "job_brief001", 1)).toMatchObject({ ok: true });
  });

  it("retries a pending request with getIntent snapshot after live binding changes", async () => {
    const canonicalRoot = await tempDir("agency-art-");
    const moved = await tempDir("agency-moved-");
    const previewRoot = await tempDir("agency-prev-");
    const inner = createMemoryMetadataPort({
      jobs: [job],
      bindings: [{ ...binding, canonicalRoot }],
      artifacts: [],
      versions: [],
      intents: [],
    });
    const failing = createArtifactStorage({
      metadata: withCommitFailure(inner, { code: "metadata_unavailable", message: "injected" }),
      files: createLocalHostFilePort("host_mini"),
      previewFiles: createLocalHostFilePort("host_mini"),
      previewRoot,
    });
    expect((await failing.publish(command())).ok).toBe(false);
    const reserved = inner.state.intents[0];
    expect(reserved?.canonicalRoot).toBe(canonicalRoot);
    inner.state.bindings[0] = { ...inner.state.bindings[0]!, canonicalRoot: moved, revision: 2 };
    const storage = createArtifactStorage({
      metadata: inner,
      files: createLocalHostFilePort("host_mini"),
      previewFiles: createLocalHostFilePort("host_mini"),
      previewRoot,
    });
    expect(await storage.publish(command())).toMatchObject({ ok: true, value: { version: 1, hash } });
    expect(inner.state.intents[0]).toMatchObject({
      state: "committed",
      canonicalRoot,
      bindingRevision: 1,
    });
    expect(await readFile(join(canonicalRoot, originalRelativePath("art_brief001", 1)))).toEqual(bytes);
  });

  it("skips reconcile when the binding snapshot changed", async () => {
    const canonicalRoot = await tempDir("agency-art-");
    const moved = await tempDir("agency-moved-");
    const previewRoot = await tempDir("agency-prev-");
    const inner = createMemoryMetadataPort({
      jobs: [job],
      bindings: [{ ...binding, canonicalRoot }],
      artifacts: [],
      versions: [],
      intents: [],
    });
    const failing = createArtifactStorage({
      metadata: withCommitFailure(inner, { code: "metadata_unavailable", message: "injected" }),
      files: createLocalHostFilePort("host_mini"),
      previewFiles: createLocalHostFilePort("host_mini"),
      previewRoot,
    });
    expect((await failing.publish(command())).ok).toBe(false);
    inner.state.bindings[0] = { ...inner.state.bindings[0]!, canonicalRoot: moved, revision: 2 };
    const recovered = await createArtifactStorage({
      metadata: inner,
      files: createLocalHostFilePort("host_mini"),
      previewFiles: createLocalHostFilePort("host_mini"),
      previewRoot,
    }).reconcile();
    expect(recovered).toEqual({ ok: true, value: [] });
    expect(inner.state.intents[0]?.state).toBe("pending");
    expect(await readFile(join(canonicalRoot, originalRelativePath("art_brief001", 1)))).toEqual(bytes);
  });

  it("skips a pending intent when the adapter host does not match", async () => {
    const canonicalRoot = await tempDir("agency-art-");
    const previewRoot = await tempDir("agency-prev-");
    const inner = createMemoryMetadataPort({
      jobs: [job],
      bindings: [{ ...binding, canonicalRoot }],
      artifacts: [],
      versions: [],
      intents: [],
    });
    const failing = createArtifactStorage({
      metadata: withCommitFailure(inner, { code: "metadata_unavailable", message: "injected" }),
      files: createLocalHostFilePort("host_mini"),
      previewFiles: createLocalHostFilePort("host_mini"),
      previewRoot,
    });
    expect((await failing.publish(command())).ok).toBe(false);
    const recovered = await createArtifactStorage({
      metadata: inner,
      files: createLocalHostFilePort("host_ovh"),
      previewFiles: createLocalHostFilePort("host_ovh"),
      previewRoot,
    }).reconcile();
    expect(recovered).toEqual({ ok: true, value: [] });
    expect(inner.state.intents[0]?.state).toBe("pending");
  });

  it("returns an error when metadata exists but the file is gone", async () => {
    const { storage, canonicalRoot } = await setup();
    expect((await storage.publish(command())).ok).toBe(true);
    await unlink(join(canonicalRoot, originalRelativePath("art_brief001", 1)));
    expect(await storage.openOriginal("art_brief001", "job_brief001", 1)).toMatchObject({
      ok: false, error: { code: "artifact_file_missing" },
    });
  });

  it("returns an error when on-disk bytes no longer match the stored hash", async () => {
    const { storage, canonicalRoot } = await setup();
    expect((await storage.publish(command())).ok).toBe(true);
    await writeFile(join(canonicalRoot, originalRelativePath("art_brief001", 1)), "tampered");
    expect(await storage.openOriginal("art_brief001", "job_brief001", 1)).toMatchObject({
      ok: false, error: { code: "artifact_hash_mismatch" },
    });
  });

  it("repairs a corrupt preview without touching originals", async () => {
    const { storage, canonicalRoot, previewRoot } = await setup();
    expect((await storage.publish(command())).ok).toBe(true);
    const preview = await storage.createPreview("art_brief001", "job_brief001", 1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.relativePath).toBe(`.agency/preview/art_brief001/${hash}.md`);
    expect(preview.value.relativePath).not.toContain("originals");
    await writeFile(join(previewRoot, preview.value.relativePath), "broken-preview");
    const repaired = await storage.materializePreview("art_brief001", "job_brief001", 1);
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    expect(await readFile(join(previewRoot, repaired.value.relativePath))).toEqual(bytes);
    expect(await readFile(join(canonicalRoot, originalRelativePath("art_brief001", 1)))).toEqual(bytes);
  });

  it("cleans preview cache without deleting originals", async () => {
    const { storage, canonicalRoot, previewRoot } = await setup();
    expect((await storage.publish(command())).ok).toBe(true);
    const preview = await storage.createPreview("art_brief001", "job_brief001", 1);
    expect(preview).toMatchObject({ ok: true });
    if (!preview.ok) return;
    expect(preview.value.relativePath).toBe(`.agency/preview/art_brief001/${hash}.md`);
    expect(await readFile(join(previewRoot, preview.value.relativePath))).toEqual(bytes);
    expect((await storage.cleanupPreviews("art_brief001")).ok).toBe(true);
    await expect(readFile(join(previewRoot, preview.value.relativePath))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(canonicalRoot, originalRelativePath("art_brief001", 1)))).toEqual(bytes);
  });

  it("derives one safe preview suffix from mime or basename, never a raw relativePath", () => {
    expect(previewFileExtension({ fileName: "card.md" })).toBe("md");
    expect(previewFileExtension({ mime: "application/json", fileName: "notes" })).toBe("json");
    expect(previewFileExtension({ mime: "text/plain", fileName: "../secret.exe" })).toBe("txt");
    expect(previewRelativePath("art_brief001", hash, previewFileExtension({ fileName: "offer.md" }))).toBe(
      `.agency/preview/art_brief001/${hash}.md`,
    );
    expect(previewRelativePath("art_brief001", hash, "../x")).toBe(`.agency/preview/art_brief001/${hash}.md`);
    expect(originalRelativePath("art_brief001", 1)).not.toMatch(/\.md$/);
  });

  it("maps handleHostFileOp codes through the SDK client", async () => {
    const root = await tempDir("agency-sdk-");
    const outside = await tempDir("agency-sdk-out-");
    await symlink(outside, join(root, "leak"));
    const client = {
      call: async (_method: "fileOp", input: HostFileOpInput, options: { hostId: string }) => {
        expect(options.hostId).toBe("host_mini");
        return handleHostFileOp(input);
      },
    };
    const port = createSdkHostFilePort(client, "host_mini");
    const written = await port.writeAtomic(root, originalRelativePath("art_brief001", 1), bytes);
    expect(written).toMatchObject({ ok: true, value: { hash, size: bytes.byteLength } });
    const escaped = await port.writeAtomic(root, "leak/secret.md", bytes);
    expect(escaped).toMatchObject({ ok: false, error: { code: "path_escape" } });
    const offline = createSdkHostFilePort({
      call: async () => {
        throw new Error("daemon offline");
      },
    }, "host_mini");
    expect(await offline.stat(root, originalRelativePath("art_brief001", 1))).toMatchObject({
      ok: false, error: { code: "host_transport", message: "daemon offline" },
    });
  });
});
