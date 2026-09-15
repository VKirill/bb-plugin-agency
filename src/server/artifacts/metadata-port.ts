import type { Artifact, ArtifactAuthor, ArtifactVersion, Job, ProjectBinding } from "../../shared/contracts";
import type { ArtifactScope, DomainResult } from "../../domain";

/**
 * Metadata port for AGY-6. SQL lives in db/services; this module only defines
 * the contract. ArtifactVersion matches AGY-5. Intent rows are recovery state,
 * not a second version schema.
 *
 * reservePublish must assign the next version in the same transaction as the
 * insert (unique requestId, unique artifactId+version). Callers use the
 * returned intent.version; they must not pick a version locally after reserve.
 */
export const ARTIFACT_METADATA_PORT = "agency.artifact.metadata.v1" as const;

export type ArtifactPublishIntentState = "pending" | "committed" | "failed";

export type ArtifactPublishPayload = {
  requestId: string;
  artifactId: string;
  jobId: string;
  bindingId: string;
  hostId: string;
  relativePath: string;
  mime: string;
  size: number;
  hash: string;
  author: ArtifactAuthor;
};

export type ArtifactPublishReservation = ArtifactPublishPayload & {
  canonicalRoot: string;
  bindingRevision: number;
};

export type ArtifactPublishIntent = ArtifactPublishReservation & {
  version: number;
  state: ArtifactPublishIntentState;
  failureCode?: string;
};

export function sameAuthor(left: ArtifactAuthor, right: ArtifactAuthor): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "user" && right.kind === "user") return left.userId === right.userId;
  if (left.kind === "run" && right.kind === "run") return left.runId === right.runId;
  return left.kind === "system" && right.kind === "system";
}

export function samePublishIdentity(
  stored: ArtifactPublishReservation,
  incoming: ArtifactPublishReservation,
): boolean {
  return (
    stored.requestId === incoming.requestId &&
    stored.artifactId === incoming.artifactId &&
    stored.jobId === incoming.jobId &&
    stored.bindingId === incoming.bindingId &&
    stored.hostId === incoming.hostId &&
    stored.canonicalRoot === incoming.canonicalRoot &&
    stored.bindingRevision === incoming.bindingRevision &&
    stored.relativePath === incoming.relativePath &&
    stored.mime === incoming.mime &&
    stored.size === incoming.size &&
    stored.hash === incoming.hash &&
    sameAuthor(stored.author, incoming.author)
  );
}

export function bindingMatchesIntent(
  binding: ProjectBinding,
  intent: ArtifactPublishIntent,
): boolean {
  return (
    binding.id === intent.bindingId &&
    binding.hostId === intent.hostId &&
    binding.canonicalRoot === intent.canonicalRoot &&
    binding.revision === intent.bindingRevision
  );
}

export interface ArtifactMetadataPort {
  getJob(jobId: string): Promise<Job | undefined>;
  getBinding(bindingId: string): Promise<ProjectBinding | undefined>;
  getArtifact(artifactId: string): Promise<Artifact | undefined>;
  ensureArtifact(artifact: Artifact): Promise<DomainResult<Artifact>>;
  listVersions(scope: ArtifactScope): Promise<readonly ArtifactVersion[]>;
  getVersion(scope: ArtifactScope, version: number): Promise<ArtifactVersion | undefined>;
  getIntent(requestId: string): Promise<ArtifactPublishIntent | undefined>;
  /** Assigns version atomically. Callers must use the returned intent. */
  reservePublish(draft: ArtifactPublishReservation): Promise<DomainResult<ArtifactPublishIntent>>;
  /**
   * AGY-6 implements atomic reservation here and ignores caller version.
   * Prefer reservePublish once both sides ship it.
   */
  putIntent(intent: ArtifactPublishIntent): Promise<DomainResult<ArtifactPublishIntent>>;
  commitVersion(intent: ArtifactPublishIntent, version: ArtifactVersion): Promise<DomainResult<ArtifactVersion>>;
  markIntentFailed(requestId: string, failureCode: string): Promise<DomainResult<ArtifactPublishIntent>>;
  listPendingIntents(): Promise<readonly ArtifactPublishIntent[]>;
}
