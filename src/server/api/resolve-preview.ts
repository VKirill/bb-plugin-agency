import { isAbsolute, relative, resolve, sep } from "node:path";
import { fail, ok, type DomainResult } from "../../domain";
import type { ArtifactAuthor, ArtifactVersion, ProjectBinding } from "../../shared/contracts";
import { joinUnderRoot, previewFileExtension, previewRelativePath } from "../../host/safe-path";
import { parseJson } from "../db/sql";
import type { SqlDatabase } from "../db/sql";
import type { DomainStore, ServiceContext } from "../services";
import { listStoredBindings } from "./catalog";

const PREVIEW_CANDIDATE =
  /^\.agency\/preview\/([a-z][a-z0-9]*_[a-z0-9]{8,48})\/([a-f0-9]{64})\.([a-z0-9]{1,8})$/;

export type ResolvedArtifactPreview = {
  artifactId: string;
  jobId: string;
  version: number;
  hash: string;
  mime: string;
  size: number;
  relativePath: string;
  bindingId: string;
  target: { hostId: string; path: string };
};

export function computedPreviewRelativePath(version: ArtifactVersion): string {
  return previewRelativePath(
    version.artifactId,
    version.hash,
    previewFileExtension({
      mime: version.mime,
      fileName: version.relativePath.split("/").pop(),
    }),
  );
}

function asPosixRelative(root: string, candidate: string): DomainResult<string> {
  if (!isAbsolute(candidate)) return fail("preview_unresolved", "preview path must be absolute on the host");
  const rootAbs = resolve(root);
  const pathAbs = resolve(candidate);
  const rel = relative(rootAbs, pathAbs);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return fail("preview_unresolved", "path is outside the binding root");
  }
  return ok(rel.split(sep).join("/"));
}

function versionsForHash(db: SqlDatabase, artifactId: string, hash: string): ArtifactVersion[] {
  return (
    db
      .prepare(
        `SELECT artifact_id, job_id, version, host_id, relative_path, mime, size, hash, author
         FROM agency_artifact_version WHERE artifact_id = ? AND hash = ? ORDER BY version DESC`,
      )
      .all(artifactId, hash) as Array<{
      artifact_id: string;
      job_id: string;
      version: number;
      host_id: string;
      relative_path: string;
      mime: string;
      size: number;
      hash: string;
      author: string;
    }>
  ).map((row) => ({
    artifactId: row.artifact_id,
    jobId: row.job_id,
    version: row.version,
    hostId: row.host_id,
    relativePath: row.relative_path,
    mime: row.mime,
    size: row.size,
    hash: row.hash,
    author: parseJson<ArtifactAuthor>(row.author),
  }));
}

function matchBinding(
  binding: ProjectBinding,
  hostId: string,
  path: string,
  db: SqlDatabase,
): DomainResult<ResolvedArtifactPreview> {
  if (binding.hostId !== hostId) return fail("preview_unresolved", "binding host does not match");
  const relativePath = asPosixRelative(binding.canonicalRoot, path);
  if (!relativePath.ok) return relativePath;
  const parsed = PREVIEW_CANDIDATE.exec(relativePath.value);
  if (!parsed) return fail("preview_unresolved", "path is not a computed agency preview");
  const artifactId = parsed[1];
  const hash = parsed[2];
  const versions = versionsForHash(db, artifactId, hash);
  for (const version of versions) {
    if (version.hostId !== hostId) continue;
    const computedRel = computedPreviewRelativePath(version);
    const computedAbs = joinUnderRoot(binding.canonicalRoot, computedRel);
    if (!computedAbs.ok) continue;
    if (resolve(computedAbs.value) !== resolve(path)) continue;
    return ok({
      artifactId: version.artifactId,
      jobId: version.jobId,
      version: version.version,
      hash: version.hash,
      mime: version.mime,
      size: version.size,
      relativePath: version.relativePath,
      bindingId: binding.id,
      target: { hostId: version.hostId, path: computedAbs.value },
    });
  }
  return fail("preview_mismatch", "preview path does not match the stored artifact version");
}

export function resolveArtifactPreview(
  store: DomainStore,
  db: SqlDatabase,
  ctx: ServiceContext,
  input: { hostId: string; path: string },
): DomainResult<ResolvedArtifactPreview> {
  const matches: ResolvedArtifactPreview[] = [];
  let mismatch = false;
  for (const binding of listStoredBindings(db)) {
    if (binding.hostId !== input.hostId) continue;
    const access = store.assertBindingAccess(ctx, binding.id);
    if (!access.ok) continue;
    const scoped = matchBinding(binding, input.hostId, input.path, db);
    if (!scoped.ok) {
      if (scoped.error.code === "preview_mismatch") mismatch = true;
      continue;
    }
    const job = store.getJob(scoped.value.jobId);
    if (!job || job.bindingId !== binding.id) continue;
    const artifact = store.getArtifact(scoped.value.artifactId);
    if (!artifact || artifact.jobId !== scoped.value.jobId) continue;
    matches.push(scoped.value);
  }
  if (matches.length === 1) return ok(matches[0]);
  if (matches.length > 1) return fail("preview_ambiguous", "preview path matches more than one binding");
  if (mismatch) return fail("preview_mismatch", "preview path does not match the stored artifact version");
  return fail("preview_unresolved", "no stored artifact preview matches this host path");
}
