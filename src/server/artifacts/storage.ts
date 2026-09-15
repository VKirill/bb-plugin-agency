import { fail, ok, type DomainResult } from "../../domain";
import {
  artifactVersionSchema,
  publishArtifactVersionCommandSchema,
  type ArtifactVersion,
  type PublishArtifactVersionCommand,
} from "../../shared/contracts";
import { assertAdapterMatchesBinding, type HostFilePort } from "../../host/file-port";
import { hashBytes } from "../../host/guarded-fs";
import { originalRelativePath, previewFileExtension, previewRelativePath } from "../../host/safe-path";
import {
  bindingMatchesIntent,
  type ArtifactMetadataPort,
  type ArtifactPublishIntent,
  type ArtifactPublishReservation,
} from "./metadata-port";

export type ArtifactStorageDeps = {
  metadata: ArtifactMetadataPort;
  files: HostFilePort;
  previewFiles: HostFilePort;
  previewRoot: string;
};

export type PublishArtifactInput = PublishArtifactVersionCommand & {
  bytes: Uint8Array;
};

export type ArtifactBytes = {
  version: ArtifactVersion;
  bytes: Uint8Array;
  physicalPath: string;
};

export type PreviewRef = {
  hash: string;
  relativePath: string;
};

export function createArtifactStorage(deps: ArtifactStorageDeps) {
  return {
    publish: (input: PublishArtifactInput) => publishArtifactVersion(deps, input),
    openOriginal: (artifactId: string, jobId: string, version: number) => (
      openOriginal(deps, artifactId, jobId, version)
    ),
    createPreview: (artifactId: string, jobId: string, version: number) => (
      materializePreview(deps, artifactId, jobId, version)
    ),
    materializePreview: (artifactId: string, jobId: string, version: number) => (
      materializePreview(deps, artifactId, jobId, version)
    ),
    cleanupPreviews: (artifactId?: string) => cleanupPreviews(deps, artifactId),
    reconcile: () => reconcile(deps),
  };
}

export type ArtifactStorage = ReturnType<typeof createArtifactStorage>;

async function publishArtifactVersion(
  deps: ArtifactStorageDeps,
  input: PublishArtifactInput,
): Promise<DomainResult<ArtifactVersion>> {
  const command = publishArtifactVersionCommandSchema.safeParse(stripBytes(input));
  if (!command.success) {
    return fail("invalid_publish", command.error.issues[0]?.message ?? "invalid publish command");
  }
  const job = await deps.metadata.getJob(command.data.jobId);
  if (!job) return fail("job_missing", `job ${command.data.jobId} is missing`);
  const binding = await deps.metadata.getBinding(job.bindingId);
  if (!binding) return fail("binding_missing", `binding ${job.bindingId} is missing`);
  if (job.bindingId !== binding.id) {
    return fail("binding_mismatch", `job ${job.id} is not bound to ${binding.id}`);
  }

  const actualHash = hashBytes(input.bytes);
  if (actualHash !== command.data.hash || input.bytes.byteLength !== command.data.size) {
    return fail(
      "artifact_hash_mismatch",
      `claimed ${command.data.size}/${command.data.hash} != actual ${input.bytes.byteLength}/${actualHash}`,
    );
  }

  const artifact = await deps.metadata.ensureArtifact({
    id: command.data.artifactId,
    jobId: command.data.jobId,
  });
  if (!artifact.ok) return artifact;

  const existing = await deps.metadata.getIntent(command.data.requestId);
  const reservedHostId = existing?.hostId ?? binding.hostId;
  if (command.data.hostId !== reservedHostId) {
    return fail("host_mismatch", `command host ${command.data.hostId} is not reserved host ${reservedHostId}`);
  }
  const adapter = assertAdapterMatchesBinding(deps.files, reservedHostId);
  if (!adapter.ok) return adapter;

  const draft: ArtifactPublishReservation = {
    requestId: command.data.requestId,
    artifactId: command.data.artifactId,
    jobId: command.data.jobId,
    bindingId: existing?.bindingId ?? binding.id,
    hostId: reservedHostId,
    canonicalRoot: existing?.canonicalRoot ?? binding.canonicalRoot,
    bindingRevision: existing?.bindingRevision ?? binding.revision,
    relativePath: command.data.relativePath,
    mime: command.data.mime,
    size: command.data.size,
    hash: command.data.hash,
    author: command.data.author,
  };
  const reserved = await reservePublish(deps.metadata, draft);
  if (!reserved.ok) return reserved;
  const intent = reserved.value;
  if (intent.state === "failed") {
    return fail(intent.failureCode ?? "intent_failed", `request ${intent.requestId} already failed`);
  }
  if (intent.state === "committed") {
    const stored = await deps.metadata.getVersion(intent, intent.version);
    if (!stored) return fail("artifact_file_missing", "committed intent has no version row");
    const root = reservedRoot(intent);
    if (!root.ok) return root;
    return verifyOriginal(deps, root.value, stored);
  }
  return finishPendingPublish(deps, intent, input.bytes);
}

async function finishPendingPublish(
  deps: ArtifactStorageDeps,
  intent: ArtifactPublishIntent,
  bytes: Uint8Array,
): Promise<DomainResult<ArtifactVersion>> {
  const root = reservedRoot(intent);
  if (!root.ok) return root;
  const adapter = assertAdapterMatchesBinding(deps.files, intent.hostId);
  if (!adapter.ok) return adapter;
  const physical = originalRelativePath(intent.artifactId, intent.version);
  const written = await deps.files.writeAtomic(root.value, physical, bytes);
  if (!written.ok) {
    if (written.error.code === "artifact_immutable") {
      return commitIfOnDiskMatches(deps, intent);
    }
    return written;
  }
  if (written.value.hash !== intent.hash || written.value.size !== intent.size) {
    return fail("artifact_hash_mismatch", "on-disk hash does not match published bytes");
  }
  return commitReserved(deps, intent);
}

function reservedRoot(intent: ArtifactPublishIntent): DomainResult<string> {
  return ok(intent.canonicalRoot);
}

async function commitIfOnDiskMatches(
  deps: ArtifactStorageDeps,
  intent: ArtifactPublishIntent,
): Promise<DomainResult<ArtifactVersion>> {
  const root = reservedRoot(intent);
  if (!root.ok) return root;
  const physical = originalRelativePath(intent.artifactId, intent.version);
  const stat = await deps.files.stat(root.value, physical);
  if (!stat.ok) return stat;
  if (!stat.value) return fail("artifact_file_missing", `reserved file is missing: ${physical}`);
  if (stat.value.hash !== intent.hash || stat.value.size !== intent.size) {
    return fail("artifact_immutable", "existing original does not match the reserved intent");
  }
  return commitReserved(deps, intent);
}

async function commitReserved(
  deps: ArtifactStorageDeps,
  intent: ArtifactPublishIntent,
): Promise<DomainResult<ArtifactVersion>> {
  const version: ArtifactVersion = artifactVersionSchema.parse({
    artifactId: intent.artifactId,
    jobId: intent.jobId,
    version: intent.version,
    hostId: intent.hostId,
    relativePath: intent.relativePath,
    mime: intent.mime,
    size: intent.size,
    hash: intent.hash,
    author: intent.author,
  });
  const root = reservedRoot(intent);
  if (!root.ok) return root;
  const committed = await deps.metadata.commitVersion(intent, version);
  if (!committed.ok) return committed;
  return verifyOriginal(deps, root.value, committed.value);
}

async function openOriginal(
  deps: ArtifactStorageDeps,
  artifactId: string,
  jobId: string,
  version: number,
): Promise<DomainResult<ArtifactBytes>> {
  const stored = await deps.metadata.getVersion({ artifactId, jobId }, version);
  if (!stored) return fail("artifact_version_missing", `artifact ${artifactId}@${version} is missing`);
  const job = await deps.metadata.getJob(jobId);
  if (!job) return fail("job_missing", `job ${jobId} is missing`);
  const binding = await deps.metadata.getBinding(job.bindingId);
  if (!binding) return fail("binding_missing", `binding ${job.bindingId} is missing`);
  const adapter = assertAdapterMatchesBinding(deps.files, stored.hostId);
  if (!adapter.ok) return adapter;
  if (stored.hostId !== binding.hostId) {
    return fail("host_mismatch", `version host ${stored.hostId} is not binding host ${binding.hostId}`);
  }
  return readVerified(deps, binding.canonicalRoot, stored);
}

async function materializePreview(
  deps: ArtifactStorageDeps,
  artifactId: string,
  jobId: string,
  version: number,
): Promise<DomainResult<PreviewRef>> {
  const original = await openOriginal(deps, artifactId, jobId, version);
  if (!original.ok) return original;
  const previewAdapter = assertAdapterMatchesBinding(deps.previewFiles, original.value.version.hostId);
  if (!previewAdapter.ok) return previewAdapter;
  const previewPath = previewPathFor(original.value.version);
  const expected = { hash: original.value.version.hash, size: original.value.version.size };
  const existing = await deps.previewFiles.stat(deps.previewRoot, previewPath);
  if (!existing.ok) return existing;
  if (existing.value && (existing.value.hash !== expected.hash || existing.value.size !== expected.size)) {
    const cleaned = await deps.previewFiles.remove(deps.previewRoot, previewPath);
    if (!cleaned.ok) return cleaned;
  } else if (existing.value) {
    return ok({ hash: expected.hash, relativePath: previewPath });
  }
  const written = await deps.previewFiles.writeAtomic(deps.previewRoot, previewPath, original.value.bytes);
  if (!written.ok) {
    if (written.error.code === "artifact_immutable") {
      const again = await deps.previewFiles.stat(deps.previewRoot, previewPath);
      if (again.ok && again.value && again.value.hash === expected.hash && again.value.size === expected.size) {
        return ok({ hash: expected.hash, relativePath: previewPath });
      }
    }
    return written;
  }
  if (written.value.hash !== expected.hash || written.value.size !== expected.size) {
    await deps.previewFiles.remove(deps.previewRoot, previewPath);
    return fail("artifact_hash_mismatch", "preview cache hash does not match original");
  }
  return ok({ hash: expected.hash, relativePath: previewPath });
}

async function cleanupPreviews(
  deps: ArtifactStorageDeps,
  artifactId?: string,
): Promise<DomainResult<{ removed: string[] }>> {
  if (!artifactId) {
    return fail("cleanup_scope_required", "cleanup must name an artifact; it never walks originals");
  }
  const artifact = await deps.metadata.getArtifact(artifactId);
  if (!artifact) return fail("artifact_missing", `artifact ${artifactId} is missing`);
  const scoped = await deps.metadata.listVersions({ artifactId, jobId: artifact.jobId });
  const removed: string[] = [];
  for (const row of scoped) {
    const previewPath = previewPathFor(row);
    const gone = await deps.previewFiles.remove(deps.previewRoot, previewPath);
    if (!gone.ok) return gone;
    removed.push(previewPath);
  }
  return ok({ removed });
}

async function reconcile(deps: ArtifactStorageDeps): Promise<DomainResult<ArtifactVersion[]>> {
  const pending = await deps.metadata.listPendingIntents();
  const recovered: ArtifactVersion[] = [];
  for (const intent of pending) {
    const binding = await deps.metadata.getBinding(intent.bindingId);
    if (!binding) continue;
    if (!bindingMatchesIntent(binding, intent)) continue;
    if (deps.files.hostId !== intent.hostId) continue;
    const adapter = assertAdapterMatchesBinding(deps.files, intent.hostId);
    if (!adapter.ok) continue;
    const finished = await commitIfOnDiskMatches(deps, intent);
    if (finished.ok) recovered.push(finished.value);
  }
  return ok(recovered);
}

async function verifyOriginal(
  deps: ArtifactStorageDeps,
  canonicalRoot: string,
  version: ArtifactVersion,
): Promise<DomainResult<ArtifactVersion>> {
  const checked = await readVerified(deps, canonicalRoot, version);
  if (!checked.ok) return checked;
  return ok(checked.value.version);
}

async function readVerified(
  deps: ArtifactStorageDeps,
  canonicalRoot: string,
  version: ArtifactVersion,
): Promise<DomainResult<ArtifactBytes>> {
  const physical = originalRelativePath(version.artifactId, version.version);
  const bytes = await deps.files.read(canonicalRoot, physical);
  if (!bytes.ok) return bytes;
  const hash = hashBytes(bytes.value);
  if (hash !== version.hash || bytes.value.byteLength !== version.size) {
    return fail(
      "artifact_hash_mismatch",
      `stored ${version.size}/${version.hash} != file ${bytes.value.byteLength}/${hash}`,
    );
  }
  return ok({ version, bytes: bytes.value, physicalPath: physical });
}

function reservePublish(
  metadata: ArtifactMetadataPort,
  draft: ArtifactPublishReservation,
) {
  return metadata.reservePublish(draft);
}

function previewPathFor(version: ArtifactVersion): string {
  return previewRelativePath(
    version.artifactId,
    version.hash,
    previewFileExtension({
      mime: version.mime,
      fileName: version.relativePath.split("/").pop(),
    }),
  );
}

function stripBytes(input: PublishArtifactInput): PublishArtifactVersionCommand {
  const { bytes: _bytes, ...command } = input;
  return command;
}
