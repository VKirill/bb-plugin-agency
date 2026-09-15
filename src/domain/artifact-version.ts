import type { ArtifactAuthor, ArtifactVersion } from "../shared/contracts";
import { fail, ok, type DomainResult } from "./result";

export type ArtifactScope = {
  artifactId: string;
  jobId: string;
};

export type ArtifactAcceptance = ArtifactScope & {
  version: number;
  hash: string;
};

function sameAuthor(left: ArtifactAuthor, right: ArtifactAuthor): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "user" && right.kind === "user") return left.userId === right.userId;
  if (left.kind === "run" && right.kind === "run") return left.runId === right.runId;
  return left.kind === "system" && right.kind === "system";
}

export function assertArtifactScope(
  versions: readonly ArtifactVersion[],
  scope: ArtifactScope,
): DomainResult<readonly ArtifactVersion[]> {
  if (versions.some((row) => row.artifactId !== scope.artifactId || row.jobId !== scope.jobId)) {
    return fail("artifact_scope_mismatch", `versions mix artifact/job outside ${scope.artifactId}/${scope.jobId}`);
  }
  return ok(versions);
}

export function nextArtifactVersion(
  current: readonly ArtifactVersion[],
  scope: ArtifactScope,
): DomainResult<number> {
  const scoped = assertArtifactScope(current, scope);
  if (!scoped.ok) return scoped;
  return ok(scoped.value.reduce((max, row) => Math.max(max, row.version), 0) + 1);
}

export function currentArtifactVersion(
  versions: readonly ArtifactVersion[],
  scope: ArtifactScope,
): DomainResult<ArtifactVersion | undefined> {
  const scoped = assertArtifactScope(versions, scope);
  if (!scoped.ok) return scoped;
  return ok(scoped.value.reduce<ArtifactVersion | undefined>((latest, row) => {
    if (!latest || row.version > latest.version) return row;
    return latest;
  }, undefined));
}

export function assertImmutableArtifactVersion(
  stored: ArtifactVersion,
  incoming: ArtifactVersion,
): DomainResult<ArtifactVersion> {
  const same =
    stored.artifactId === incoming.artifactId &&
    stored.jobId === incoming.jobId &&
    stored.version === incoming.version &&
    stored.hostId === incoming.hostId &&
    stored.relativePath === incoming.relativePath &&
    stored.mime === incoming.mime &&
    stored.size === incoming.size &&
    stored.hash === incoming.hash &&
    sameAuthor(stored.author, incoming.author);
  if (!same) {
    return fail("artifact_immutable", `artifact version ${stored.artifactId}@${stored.version} cannot change`);
  }
  return ok(stored);
}

export function assertAcceptCurrentVersion(
  versions: readonly ArtifactVersion[],
  accepted: ArtifactAcceptance,
): DomainResult<ArtifactVersion> {
  const current = currentArtifactVersion(versions, accepted);
  if (!current.ok) return current;
  if (!current.value) {
    return fail("stale_artifact_version", "no artifact version to accept");
  }
  if (accepted.version !== current.value.version || accepted.hash !== current.value.hash) {
    return fail(
      "stale_artifact_version",
      `acceptance ${accepted.version}/${accepted.hash} is not the current ${current.value.version}/${current.value.hash}`,
    );
  }
  return ok(current.value);
}
