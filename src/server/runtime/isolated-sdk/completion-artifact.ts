import { fail, ok, type DomainResult } from "../../../domain";
import { createSdkHostFilePortFromBinding, type HostFileRpcClient } from "../../../host";
import { createArtifactStorage } from "../../artifacts";
import { createArtifactMetadataPort } from "../../services";
import type { DomainStore, ServiceContext } from "../../services";
import type { SqlDatabase } from "../../db/sql";
import { listArtifactIdsForJob } from "../../api/catalog";
import { interpretVerifiedCompletion, verifyOpenedCurrentVersion, type CompletionReading } from "./completion.js";

export async function readJobPublishedArtifact(
  deps: {
    isActive?: () => boolean;
    ctx: ServiceContext;
    store: DomainStore;
    db: SqlDatabase;
    documents: HostFileRpcClient;
  },
  jobId: string,
): Promise<DomainResult<{ publishedVerified: boolean; acceptedVerified: boolean; publishedHash: string | null }>> {
  if (deps.isActive?.() === false) return fail("runtime_disposed", "Runtime was disposed");
  const job = deps.store.getJob(jobId);
  if (!job) return fail("not_found", `job ${jobId} not found`);
  const binding = deps.store.getBinding(job.bindingId);
  if (!binding) return fail("not_found", `binding ${job.bindingId} not found`);
  const artifactIds = listArtifactIdsForJob(deps.db, jobId);
  if (artifactIds.length === 0) {
    return ok({ publishedVerified: false, acceptedVerified: false, publishedHash: null });
  }
  const files = createSdkHostFilePortFromBinding(deps.documents, binding);
  if (!files.ok) return files;
  const storage = createArtifactStorage({
    metadata: createArtifactMetadataPort(deps.db, deps.ctx),
    files: files.value,
    previewFiles: files.value,
    previewRoot: binding.canonicalRoot,
  });
  // Existing gap: acceptedVerified is true if any current artifact is accepted.
  // Not "all artifacts". Do not silently tighten until a product contract says so.
  let publishedVerified = false;
  let acceptedVerified = false;
  let publishedHash: string | null = null;
  for (const artifactId of artifactIds) {
    const artifact = deps.store.getArtifact(artifactId);
    if (!artifact || artifact.jobId !== jobId) {
      return fail("artifact_scope_mismatch", "artifact does not belong to this job");
    }
    const versions = deps.store.listArtifactVersions(artifactId, jobId);
    const current = versions.at(-1) ?? null;
    if (!current) continue;
    const opened = await storage.openOriginal(artifactId, jobId, current.version);
    if (deps.isActive?.() === false) return fail("runtime_disposed", "Runtime was disposed");
    const acceptance = deps.db
      .prepare(`SELECT version, hash FROM agency_artifact_acceptance WHERE artifact_id = ? AND job_id = ?`)
      .get(artifactId, jobId) as { version: number; hash: string } | undefined;
    if (!opened.ok) {
      return fail(opened.error.code, opened.error.message);
    }
    const verified = verifyOpenedCurrentVersion({
      version: current,
      opened: { bytes: opened.value.bytes, hash: opened.value.version.hash, size: opened.value.version.size },
      acceptance: acceptance ?? null,
      jobId,
    });
    if (!verified.ok) return verified;
    publishedVerified = true;
    publishedHash = verified.value.version.hash;
    if (verified.value.acceptedVerified) acceptedVerified = true;
  }
  return ok({ publishedVerified, acceptedVerified, publishedHash });
}

export async function readCompletionFromCore(input: {
  threadStatus: string | null;
  jobId: string;
  ctx: ServiceContext;
  store: DomainStore;
  db: SqlDatabase;
  documents: HostFileRpcClient;
}): Promise<DomainResult<CompletionReading>> {
  const published = await readJobPublishedArtifact(input, input.jobId);
  if (!published.ok) {
    return ok({
      ...interpretVerifiedCompletion({
        threadStatus: input.threadStatus,
        publishedVerified: false,
        acceptedVerified: false,
      }),
      reason: published.error.message,
    });
  }
  return ok(
    interpretVerifiedCompletion({
      threadStatus: input.threadStatus,
      publishedVerified: published.value.publishedVerified,
      acceptedVerified: published.value.acceptedVerified,
    }),
  );
}
