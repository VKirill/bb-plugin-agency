import { fail, ok } from "../../domain";
import type {
  ArtifactMetadataPort,
  ArtifactPublishIntent,
  ArtifactPublishReservation,
} from "../artifacts/metadata-port";
import { createRepositories } from "../db/repositories";
import type { SqlDatabase } from "../db/sql";
import { assertBindingAccess, type ServiceContext } from "./context";
import { commitPublishIntent, failPublishIntent, reservePublishIntent, toPortIntent } from "./publish-intent";

/**
 * SQLite `agency.artifact.metadata.v1`.
 * reservePublish/putIntent assign the version atomically from pending+committed slots.
 */
export function createArtifactMetadataPort(db: SqlDatabase, ctx: ServiceContext): ArtifactMetadataPort {
  const repos = createRepositories(db);

  const visibleJob = (jobId: string) => {
    const job = repos.job.get(jobId);
    if (!job) return undefined;
    return assertBindingAccess(ctx, job.bindingId).ok ? job : undefined;
  };

  const visibleBinding = (bindingId: string) => {
    if (!assertBindingAccess(ctx, bindingId).ok) return undefined;
    return repos.binding.get(bindingId);
  };

  const reserve = (draft: ArtifactPublishReservation) =>
    db.transaction(() => {
      const job = visibleJob(draft.jobId);
      if (!job) return fail("job_missing", `job ${draft.jobId} is missing`);
      const binding = visibleBinding(job.bindingId);
      if (!binding) return fail("binding_missing", `binding ${job.bindingId} is missing`);
      if (draft.bindingId !== job.bindingId) {
        return fail("binding_mismatch", `intent binding ${draft.bindingId} != job binding ${job.bindingId}`);
      }
      const reserved = reservePublishIntent(repos, ctx, draft, binding);
      return reserved.ok ? ok(toPortIntent(reserved.value)) : reserved;
    })();

  return {
    async getJob(jobId) {
      return visibleJob(jobId);
    },
    async getBinding(bindingId) {
      return visibleBinding(bindingId);
    },
    async getArtifact(artifactId) {
      const artifact = repos.artifact.get(artifactId);
      if (!artifact) return undefined;
      return visibleJob(artifact.jobId) ? artifact : undefined;
    },
    async ensureArtifact(artifact) {
      return db.transaction(() => {
        const job = visibleJob(artifact.jobId);
        if (!job) return fail("job_missing", `job ${artifact.jobId} is missing`);
        const existing = repos.artifact.get(artifact.id);
        if (existing) {
          if (existing.jobId !== artifact.jobId) {
            return fail("artifact_scope_mismatch", `artifact ${artifact.id} belongs to ${existing.jobId}`);
          }
          return ok(existing);
        }
        repos.artifact.insert(artifact);
        return ok(artifact);
      })();
    },
    async listVersions(scope) {
      if (!visibleJob(scope.jobId)) return [];
      return repos.artifactVersion.listByScope(scope.artifactId, scope.jobId);
    },
    async getVersion(scope, version) {
      if (!visibleJob(scope.jobId)) return undefined;
      return repos.artifactVersion.get(scope.artifactId, scope.jobId, version);
    },
    async getIntent(requestId) {
      const row = repos.publishIntent.get(requestId);
      if (!row || !visibleJob(row.jobId)) return undefined;
      return toPortIntent(row);
    },
    async reservePublish(draft) {
      return reserve(draft);
    },
    async putIntent(intent) {
      if (intent.canonicalRoot === undefined || intent.bindingRevision === undefined) {
        return fail("binding_snapshot_mismatch", "putIntent requires host/root/revision snapshot");
      }
      const { version: _version, state: _state, failureCode: _failure, ...draft } = intent;
      return reserve(draft);
    },
    async commitVersion(intent, version) {
      return db.transaction(() => {
        if (!visibleJob(intent.jobId)) return fail("job_missing", `job ${intent.jobId} is missing`);
        return commitPublishIntent(repos, intent, version);
      })();
    },
    async markIntentFailed(requestId, failureCode) {
      return db.transaction(() => {
        const row = repos.publishIntent.get(requestId);
        if (row && !visibleJob(row.jobId)) return fail("job_missing", `job ${row.jobId} is missing`);
        const failed = failPublishIntent(repos, requestId, failureCode);
        return failed.ok ? ok(toPortIntent(failed.value)) : failed;
      })();
    },
    async listPendingIntents() {
      return repos.publishIntent.listPending().filter((row) => visibleJob(row.jobId)).map(toPortIntent);
    },
  };
}

export type { ArtifactPublishIntent };
