import { newOpaqueId } from "../db/ids";
import { assertImmutableArtifactVersion, fail, ok, type DomainResult } from "../../domain";
import type { ArtifactVersion, ProjectBinding } from "../../shared/contracts";
import {
  samePublishIdentity,
  type ArtifactPublishIntent,
  type ArtifactPublishReservation,
} from "../artifacts/metadata-port";
import type { DurablePublishIntent, Repositories } from "../db/repositories";
import { actorToActivity, nowUtc, type ServiceContext } from "./context";

export function bindingMatchesLive(binding: ProjectBinding, draft: ArtifactPublishReservation): boolean {
  return (
    binding.id === draft.bindingId &&
    binding.hostId === draft.hostId &&
    binding.canonicalRoot === draft.canonicalRoot &&
    binding.revision === draft.bindingRevision
  );
}

export function toPortIntent(row: DurablePublishIntent): ArtifactPublishIntent {
  return {
    requestId: row.requestId,
    artifactId: row.artifactId,
    jobId: row.jobId,
    bindingId: row.bindingId,
    hostId: row.hostId,
    canonicalRoot: row.canonicalRoot,
    bindingRevision: row.bindingRevision,
    relativePath: row.relativePath,
    mime: row.mime,
    size: row.size,
    hash: row.hash,
    author: row.author,
    version: row.version,
    state: row.state,
    failureCode: row.failureCode,
  };
}

export function reservePublishIntent(
  repos: Repositories,
  ctx: ServiceContext,
  draft: ArtifactPublishReservation,
  liveBinding: ProjectBinding,
): DomainResult<DurablePublishIntent> {
  const existing = repos.publishIntent.get(draft.requestId);
  if (existing) {
    if (!samePublishIdentity(existing, draft)) {
      return fail("request_conflict", `request ${draft.requestId} already reserved with a different identity`);
    }
    return ok(existing);
  }
  const job = repos.job.get(draft.jobId);
  if (job && ["done", "canceled"].includes(job.state)) return fail("job_closed", "Return the closed job before publishing a new version");
  if (!bindingMatchesLive(liveBinding, draft)) {
    return fail(
      "binding_snapshot_mismatch",
      "first reservation must match the live binding host/root/revision",
    );
  }
  const committedMax = repos.artifactVersion
    .listByScope(draft.artifactId, draft.jobId)
    .reduce((max, row) => Math.max(max, row.version), 0);
  const reservedMax = repos.publishIntent.maxReservedVersion(draft.artifactId, draft.jobId);
  const version = Math.max(committedMax, reservedMax) + 1;
  const row: DurablePublishIntent = {
    ...draft,
    version,
    state: "pending",
    createdAt: nowUtc(ctx),
  };
  try {
    repos.publishIntent.insert(row);
  } catch (error) {
    return fail("version_reservation_conflict", error instanceof Error ? error.message : "version slot taken");
  }
  return ok(row);
}

export function commitPublishIntent(
  repos: Repositories,
  intent: ArtifactPublishIntent,
  version: ArtifactVersion,
  ctx: ServiceContext,
): DomainResult<ArtifactVersion> {
  const stored = repos.publishIntent.get(intent.requestId);
  if (!stored) return fail("intent_missing", `publish intent ${intent.requestId} is missing`);
  if (intent.canonicalRoot === undefined || intent.bindingRevision === undefined) {
    return fail("binding_snapshot_mismatch", "commit requires host/root/revision snapshot");
  }
  if (!samePublishIdentity(stored, intent) || stored.version !== intent.version) {
    return fail("request_conflict", `request ${intent.requestId} does not match reserved intent`);
  }
  if (stored.state === "failed") {
    return fail("intent_failed", `publish intent ${intent.requestId} is failed and cannot commit`);
  }
  if (stored.version !== version.version || stored.artifactId !== version.artifactId || stored.jobId !== version.jobId) {
    return fail("request_conflict", "commit version does not match the reserved intent");
  }
  if (
    stored.hostId !== version.hostId ||
    stored.relativePath !== version.relativePath ||
    stored.mime !== version.mime ||
    stored.size !== version.size ||
    stored.hash !== version.hash ||
    JSON.stringify(stored.author) !== JSON.stringify(version.author)
  ) {
    return fail("request_conflict", "committed version does not match reserved intent payload");
  }
  const duplicate = repos.artifactVersion.get(version.artifactId, version.jobId, version.version);
  if (duplicate) {
    const same = assertImmutableArtifactVersion(duplicate, version);
    if (!same.ok) return same;
    if (stored.state !== "committed") {
      repos.publishIntent.update({ ...stored, state: "committed", failureCode: undefined });
    }
    return ok(duplicate);
  }
  if (stored.state === "committed") {
    return fail("intent_missing", `committed intent ${intent.requestId} has no version row`);
  }
  const job = repos.job.get(version.jobId);
  if (job && ["done", "canceled"].includes(job.state)) return fail("job_closed", "The job closed before this publication committed");
  try {
    repos.artifactVersion.insert(version);
  } catch (error) {
    return fail("artifact_immutable", error instanceof Error ? error.message : "artifact version insert failed");
  }
  repos.publishIntent.update({ ...stored, state: "committed", failureCode: undefined });
  repos.activity.insert({ id: newOpaqueId("activity"), jobId: version.jobId, kind: "artifact_published",
    actor: actorToActivity(ctx.caller?.agentId ? { kind: "agent", agentId: ctx.caller.agentId } : ctx.actor),
    causationId: null, timestamp: nowUtc(ctx), references: [{ type: "artifact", id: version.artifactId }, { type: "artifact_hash", id: version.hash }],
  });
  return ok(version);
}

export function failPublishIntent(
  repos: Repositories,
  requestId: string,
  failureCode: string,
): DomainResult<DurablePublishIntent> {
  const stored = repos.publishIntent.get(requestId);
  if (!stored) return fail("intent_missing", `publish intent ${requestId} is missing`);
  if (stored.state === "committed") {
    return fail("request_conflict", `request ${requestId} already committed`);
  }
  const next: DurablePublishIntent = { ...stored, state: "failed", failureCode };
  repos.publishIntent.update(next);
  return ok(next);
}
