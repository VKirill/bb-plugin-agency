import {
  assertImmutableArtifactVersion,
  fail,
  ok,
  type DomainError,
  type DomainResult,
} from "../../domain";
import type { Artifact, ArtifactVersion, Job, ProjectBinding } from "../../shared/contracts";
import {
  samePublishIdentity,
  type ArtifactMetadataPort,
  type ArtifactPublishIntent,
  type ArtifactPublishReservation,
} from "./metadata-port";

export type MemoryMetadataState = {
  jobs: Job[];
  bindings: ProjectBinding[];
  artifacts: Artifact[];
  versions: ArtifactVersion[];
  intents: ArtifactPublishIntent[];
};

export function snapshotMemoryMetadata(port: MemoryMetadataPort): MemoryMetadataState {
  return structuredClone(port.state);
}

export type MemoryMetadataPort = ArtifactMetadataPort & {
  readonly state: MemoryMetadataState;
  reservePublish(draft: ArtifactPublishReservation): Promise<DomainResult<ArtifactPublishIntent>>;
};

export function createMemoryMetadataPort(seed: MemoryMetadataState = {
  jobs: [],
  bindings: [],
  artifacts: [],
  versions: [],
  intents: [],
}): MemoryMetadataPort {
  const state: MemoryMetadataState = structuredClone(seed);
  let gate: Promise<void> = Promise.resolve();

  const exclusive = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    let release: () => void = () => undefined;
    const previous = gate;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };

  const nextVersion = (artifactId: string, jobId: string): number => {
    const versionMax = state.versions
      .filter((row) => row.artifactId === artifactId && row.jobId === jobId)
      .reduce((max, row) => Math.max(max, row.version), 0);
    const intentMax = state.intents
      .filter((row) => row.artifactId === artifactId && row.jobId === jobId)
      .reduce((max, row) => Math.max(max, row.version), 0);
    return Math.max(versionMax, intentMax) + 1;
  };

  const reserveDraft = (
    draft: ArtifactPublishReservation | ArtifactPublishIntent,
  ): DomainResult<ArtifactPublishIntent> => {
    const reservation: ArtifactPublishReservation = {
      requestId: draft.requestId,
      artifactId: draft.artifactId,
      jobId: draft.jobId,
      bindingId: draft.bindingId,
      hostId: draft.hostId,
      canonicalRoot: draft.canonicalRoot,
      bindingRevision: draft.bindingRevision,
      relativePath: draft.relativePath,
      mime: draft.mime,
      size: draft.size,
      hash: draft.hash,
      author: draft.author,
    };
    const existing = state.intents.find((row) => row.requestId === draft.requestId);
    if (existing) {
      if (!samePublishIdentity(existing, reservation)) {
        return fail("request_conflict", `request ${draft.requestId} already reserved with a different identity`);
      }
      return ok(existing);
    }
    const intent: ArtifactPublishIntent = {
      ...draft,
      canonicalRoot: draft.canonicalRoot,
      bindingRevision: draft.bindingRevision,
      version: nextVersion(draft.artifactId, draft.jobId),
      state: "pending",
    };
    state.intents.push(intent);
    return ok(intent);
  };

  const port: MemoryMetadataPort = {
    state,
    async getJob(jobId) {
      return state.jobs.find((row) => row.id === jobId);
    },
    async getBinding(bindingId) {
      return state.bindings.find((row) => row.id === bindingId);
    },
    async getArtifact(artifactId) {
      return state.artifacts.find((row) => row.id === artifactId);
    },
    async ensureArtifact(artifact) {
      const existing = state.artifacts.find((row) => row.id === artifact.id);
      if (existing) {
        if (existing.jobId !== artifact.jobId) {
          return fail("artifact_scope_mismatch", `artifact ${artifact.id} belongs to ${existing.jobId}`);
        }
        return ok(existing);
      }
      state.artifacts.push(artifact);
      return ok(artifact);
    },
    async listVersions(scope) {
      return state.versions.filter((row) => row.artifactId === scope.artifactId && row.jobId === scope.jobId);
    },
    async getVersion(scope, version) {
      return state.versions.find((row) => (
        row.artifactId === scope.artifactId && row.jobId === scope.jobId && row.version === version
      ));
    },
    async getIntent(requestId) {
      return state.intents.find((row) => row.requestId === requestId);
    },
    async reservePublish(draft: ArtifactPublishReservation) {
      return exclusive((): DomainResult<ArtifactPublishIntent> => reserveDraft(draft));
    },
    async putIntent(intent) {
      return exclusive((): DomainResult<ArtifactPublishIntent> => reserveDraft(intent));
    },
    async commitVersion(intent, version) {
      return exclusive((): DomainResult<ArtifactVersion> => {
        const stored = state.intents.find((row) => row.requestId === intent.requestId);
        if (!stored) {
          return fail("intent_missing", `publish intent ${intent.requestId} is missing`);
        }
        if (stored.version !== version.version || stored.artifactId !== version.artifactId || stored.jobId !== version.jobId) {
          return fail("request_conflict", "commit version does not match the reserved intent");
        }
        const duplicate = state.versions.find((row) => (
          row.artifactId === version.artifactId && row.jobId === version.jobId && row.version === version.version
        ));
        if (duplicate) {
          const same = assertImmutableArtifactVersion(duplicate, version);
          if (!same.ok) return same;
          stored.state = "committed";
          delete stored.failureCode;
          return ok(duplicate);
        }
        state.versions.push(version);
        stored.state = "committed";
        delete stored.failureCode;
        return ok(version);
      });
    },
    async markIntentFailed(requestId, failureCode) {
      return exclusive((): DomainResult<ArtifactPublishIntent> => {
        const stored = state.intents.find((row) => row.requestId === requestId);
        if (!stored) {
          return fail("intent_missing", `publish intent ${requestId} is missing`);
        }
        if (stored.state === "committed") {
          return fail("request_conflict", `request ${requestId} already committed`);
        }
        stored.state = "failed";
        stored.failureCode = failureCode;
        return ok(stored);
      });
    },
    async listPendingIntents() {
      return state.intents.filter((row) => row.state === "pending");
    },
  };
  return port;
}

export function withCommitFailure(
  inner: ArtifactMetadataPort,
  error: DomainError,
): ArtifactMetadataPort {
  return {
    getJob: (jobId) => inner.getJob(jobId),
    getBinding: (bindingId) => inner.getBinding(bindingId),
    getArtifact: (artifactId) => inner.getArtifact(artifactId),
    ensureArtifact: (artifact) => inner.ensureArtifact(artifact),
    listVersions: (scope) => inner.listVersions(scope),
    getVersion: (scope, version) => inner.getVersion(scope, version),
    getIntent: (requestId) => inner.getIntent(requestId),
    reservePublish: (draft) => inner.reservePublish(draft),
    putIntent: (intent) => inner.putIntent(intent),
    commitVersion: async () => fail(error.code, error.message),
    markIntentFailed: (requestId, failureCode) => inner.markIntentFailed(requestId, failureCode),
    listPendingIntents: () => inner.listPendingIntents(),
  };
}
