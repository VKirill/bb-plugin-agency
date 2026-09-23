import { fail, ok, type DomainResult } from "../../../domain";
import { hashBytes } from "../../../host/guarded-fs.js";
import { inputCopyRelativePath } from "../../../host/safe-path.js";
import type { HostFilePort } from "../../../host/file-port.js";
import {
  attachJobInputCommandSchema,
  type AttachJobInputCommand,
  type ArtifactVersion,
} from "../../../shared/contracts";
import { createArtifactStorage } from "../../artifacts";
import { createRepositories } from "../../db/repositories.js";
import type { SqlDatabase } from "../../db/sql";
import { parseJson, toJson } from "../../db/sql";
import { createArtifactMetadataPort } from "../../services/artifact-metadata.js";
import { assertBindingAccess, nowUtc, type ServiceContext } from "../../services/context.js";
import type { DomainStore } from "../../services";
import { payloadWithoutRequestId, sameActor, sameCanonical } from "../../services/request-identity.js";
import { createInternalRunStoreReads } from "../run-store";
import { computeHandoffHash } from "../context-snapshot/compile.js";
import type { HandoffPackage, InputArtifactRef } from "../context-snapshot/types.js";
import { recordTrace } from "../trace/store.js";

export { attachJobInputCommandSchema, attachJobInputHandoffSchema } from "../../../shared/contracts";
export type { AttachJobInputCommand } from "../../../shared/contracts";

export type AttachedJobInput = {
  targetJobId: string;
  sourceJobId: string;
  artifactId: string;
  version: number;
  hash: string;
  hostId: string;
  relativePath: string;
  publishedVerified: true;
  accepted: boolean;
  authorizedInputJobIds: string[];
};

export type PreparedJobInputs = {
  inputArtifactVersions: ArtifactVersion[];
  authorizedInputJobIds: string[];
  handoff: HandoffPackage | null;
};

export type JobInputPort = {
  loadForPrepare(ctx: ServiceContext, jobId: string): Promise<DomainResult<PreparedJobInputs>>;
};

type InputRow = {
  target_job_id: string;
  source_job_id: string;
  artifact_id: string;
  version: number;
  hash: string;
  host_id: string;
  relative_path: string;
  accepted: number;
};

function rememberAttach<T>(
  db: SqlDatabase,
  ctx: ServiceContext,
  identity: { requestId: string; payload: unknown; scopeBindingIds: readonly string[] },
  run: () => DomainResult<T>,
): DomainResult<T> {
  const repos = createRepositories(db);
  const payload = payloadWithoutRequestId(identity.payload);
  const existing = repos.request.get(identity.requestId);
  if (existing) {
    for (const bindingId of existing.scopeBindingIds) {
      const access = assertBindingAccess(ctx, bindingId);
      if (!access.ok) return access;
    }
    if (
      existing.kind !== "attachJobInput" ||
      !sameCanonical(existing.payload, payload) ||
      !sameActor(existing.actor, ctx.actor) ||
      !sameCanonical(existing.scopeBindingIds, identity.scopeBindingIds)
    ) {
      return fail("request_conflict", `request ${identity.requestId} already used with a different attach payload`);
    }
    return existing.result as DomainResult<T>;
  }
  const result = run();
  repos.request.insert(
    identity.requestId,
    "attachJobInput",
    result,
    payload,
    ctx.actor,
    identity.scopeBindingIds,
    nowUtc(ctx),
  );
  return result;
}

async function openPinnedVersion(input: {
  store: DomainStore;
  db: SqlDatabase;
  files: HostFilePort;
  ctx: ServiceContext;
  artifactId: string;
  sourceJobId: string;
  version: number;
  hash: string;
}): Promise<DomainResult<ArtifactVersion & { accepted: boolean; bytes: Uint8Array }>> {
  const sourceJob = input.store.getJob(input.sourceJobId);
  if (!sourceJob) return fail("not_found", `source job ${input.sourceJobId} not found`);
  const sourceBinding = input.store.getBinding(sourceJob.bindingId);
  if (!sourceBinding) return fail("not_found", `source binding ${sourceJob.bindingId} not found`);
  const artifact = input.store.getArtifact(input.artifactId);
  if (!artifact) return fail("not_found", `artifact ${input.artifactId} not found`);
  if (artifact.jobId !== input.sourceJobId) {
    return fail("artifact_scope_mismatch", "artifact does not belong to sourceJobId");
  }
  const pinned = input.store.getArtifactVersion(input.artifactId, input.sourceJobId, input.version);
  if (!pinned) {
    return fail("not_found", `artifact ${input.artifactId} version ${input.version} is missing`);
  }
  if (pinned.hash !== input.hash) {
    return fail(
      "artifact_hash_mismatch",
      `pinned ${pinned.hash} !== requested ${input.hash}; version is not latest-lookup`,
    );
  }
  if (input.files.hostId !== sourceBinding.hostId) {
    return fail("host_mismatch", `file port host ${input.files.hostId} !== artifact binding ${sourceBinding.hostId}`);
  }
  const storage = createArtifactStorage({
    metadata: createArtifactMetadataPort(input.db, input.ctx),
    files: input.files,
    previewFiles: input.files,
    previewRoot: sourceBinding.canonicalRoot,
  });
  const opened = await storage.openOriginal(input.artifactId, input.sourceJobId, input.version);
  if (!opened.ok) return opened;
  const actual = hashBytes(opened.value.bytes);
  if (actual !== pinned.hash || opened.value.bytes.byteLength !== pinned.size) {
    return fail("artifact_hash_mismatch", "opened bytes do not match the pinned ArtifactVersion");
  }
  const acceptance = input.db
    .prepare(`SELECT version, hash FROM agency_artifact_acceptance WHERE artifact_id = ? AND job_id = ?`)
    .get(input.artifactId, input.sourceJobId) as { version: number; hash: string } | undefined;
  const accepted = Boolean(
    acceptance && acceptance.version === pinned.version && acceptance.hash === pinned.hash,
  );
  return ok({ ...pinned, accepted, bytes: opened.value.bytes });
}

/**
 * Host file RPC carries at most 8 MiB of base64: 6 MiB of bytes. Publishing has the
 * same cap (ARTIFACT_UPLOAD_MAX_BASE64), so every published version fits one copy and
 * no chunked transfer is needed; this guard only protects against a future larger cap.
 */
export const INPUT_COPY_MAX_BYTES = 6 * 1024 * 1024;

/**
 * An input from another folder of the same job tree is copied next to the target job, so the
 * launch reads it on its own machine. The copy is verified by hash on write and on every prepare.
 */
async function copyInputToTarget(input: {
  files: HostFilePort;
  targetRoot: string;
  artifactId: string;
  version: number;
  hash: string;
  bytes: Uint8Array;
}): Promise<DomainResult<{ relativePath: string; reused: boolean }>> {
  if (input.bytes.byteLength > INPUT_COPY_MAX_BYTES) {
    return fail(
      "input_copy_too_large",
      `Версия больше ${INPUT_COPY_MAX_BYTES / 1024 / 1024} МБ не копируется между папками: перенесите файл через File Gateway и опишите путь в брифе.`,
    );
  }
  const relativePath = inputCopyRelativePath(input.artifactId, input.version);
  const written = await input.files.writeAtomic(input.targetRoot, relativePath, input.bytes);
  // Copies are shared by every job in this folder. A later (or concurrent) review
  // may already have materialized this pinned version. Never overwrite it: only
  // reuse an immutable collision after reading and verifying the actual bytes.
  if (!written.ok && written.error.code !== "artifact_immutable") return written;
  const check = await input.files.read(input.targetRoot, relativePath);
  if (!check.ok) return check;
  if (check.value.byteLength !== input.bytes.byteLength || hashBytes(check.value) !== input.hash) {
    return fail("artifact_hash_mismatch", "input copy on the target machine does not match the pinned hash");
  }
  return ok({ relativePath, reused: !written.ok });
}

function validateHandoff(
  db: SqlDatabase,
  ctx: ServiceContext,
  sourceJobId: string,
  handoff: NonNullable<AttachJobInputCommand["handoff"]>,
): DomainResult<{ priorAttemptId: string; fromSnapshotDigest: string; reason: string | null; questions: string[] }> {
  const reads = createInternalRunStoreReads(db);
  const attempt = reads.getAttempt(ctx, handoff.priorAttemptId);
  if (!attempt.ok) return attempt;
  if (attempt.value.jobId !== sourceJobId) {
    return fail("handoff_scope_mismatch", "priorAttemptId is not an attempt of sourceJobId");
  }
  if (attempt.value.digest !== handoff.sourceSnapshotDigest) {
    return fail(
      "handoff_digest_mismatch",
      "sourceSnapshotDigest does not match the stored attempt digest",
    );
  }
  return ok({
    priorAttemptId: handoff.priorAttemptId,
    fromSnapshotDigest: handoff.sourceSnapshotDigest,
    reason: handoff.reason ?? null,
    questions: handoff.questions ?? [],
  });
}

export async function attachJobInput(
  deps: {
    store: DomainStore;
    db: SqlDatabase;
    files: HostFilePort;
    /** File port of the target job's folder; needed when the source job lives in another folder. */
    targetFiles?: HostFilePort;
  },
  ctx: ServiceContext,
  raw: AttachJobInputCommand,
): Promise<DomainResult<AttachedJobInput>> {
  const parsed = attachJobInputCommandSchema.safeParse(raw);
  if (!parsed.success) return fail("invalid_command", parsed.error.message);
  const input = parsed.data;
  const target = deps.store.getJob(input.targetJobId);
  if (!target) return fail("not_found", `target job ${input.targetJobId} not found`);
  const targetAccess = deps.store.assertBindingAccess(ctx, target.bindingId);
  if (!targetAccess.ok) return targetAccess;
  if (target.revision !== input.expectedRevision) {
    return fail("revision_conflict", "expectedRevision does not match the live target job revision");
  }
  if (input.sourceJobId === input.targetJobId) {
    return fail("invalid_command", "sourceJobId must be a different job than targetJobId");
  }
  const source = deps.store.getJob(input.sourceJobId);
  if (!source) return fail("not_found", `source job ${input.sourceJobId} not found`);
  const sourceAccess = deps.store.assertBindingAccess(ctx, source.bindingId);
  if (!sourceAccess.ok) return sourceAccess;
  const crossFolder = source.bindingId !== target.bindingId;
  // Another folder is allowed only inside one job tree: every subtask there passed the placement rules.
  if (crossFolder && !deps.store.sameJobTree(source.id, target.id)) {
    return fail("foreign_scope", "source job is outside the target job binding; parentJobId is not a grant");
  }
  const targetBinding = crossFolder ? deps.store.getBinding(target.bindingId) : undefined;
  if (crossFolder && !targetBinding) return fail("not_found", `target binding ${target.bindingId} not found`);
  const ownWork = deps.store.assertNotSelfReview(target, [source.id]);
  if (!ownWork.ok) return ownWork;
  const opened = await openPinnedVersion({
    store: deps.store,
    db: deps.db,
    files: deps.files,
    ctx,
    artifactId: input.artifactId,
    sourceJobId: input.sourceJobId,
    version: input.version,
    hash: input.hash,
  });
  if (!opened.ok) return opened;
  let placed = { hostId: opened.value.hostId, relativePath: opened.value.relativePath };
  if (crossFolder && targetBinding) {
    if (!deps.targetFiles || deps.targetFiles.hostId !== targetBinding.hostId) {
      return fail("host_mismatch", "a file port for the target job's machine is required to copy the input");
    }
    const copied = await copyInputToTarget({
      files: deps.targetFiles,
      targetRoot: targetBinding.canonicalRoot,
      artifactId: input.artifactId,
      version: input.version,
      hash: opened.value.hash,
      bytes: opened.value.bytes,
    });
    recordTrace(deps.db, {
      jobId: target.id, step: "input.copy", outcome: copied.ok ? "succeeded" : "failed",
      reason: copied.ok ? (copied.value.reused ? "verified_existing" : "created") : copied.error.code,
      requestId: input.requestId, relatedJobId: source.id, artifactHash: input.hash,
      facts: { version: input.version },
    });
    if (!copied.ok) return copied;
    placed = { hostId: targetBinding.hostId, relativePath: copied.value.relativePath };
  }
  let handoff: ReturnType<typeof validateHandoff> extends DomainResult<infer T> ? T | undefined : never;
  if (input.handoff) {
    const checked = validateHandoff(deps.db, ctx, input.sourceJobId, input.handoff);
    if (!checked.ok) return checked;
    handoff = checked.value;
  }
  return rememberAttach(deps.db, ctx, {
    requestId: input.requestId,
    payload: input,
    scopeBindingIds: [target.bindingId, source.bindingId],
  }, () => {
    const existing = deps.db
      .prepare(
        `SELECT hash FROM agency_job_input_ref WHERE target_job_id = ? AND artifact_id = ? AND version = ?`,
      )
      .get(input.targetJobId, input.artifactId, input.version) as { hash: string } | undefined;
    if (existing && existing.hash !== opened.value.hash) {
      return fail("request_conflict", "input ref already pinned to a different hash");
    }
    deps.db
      .prepare(
        `INSERT INTO agency_job_input_ref (
           target_job_id, source_job_id, artifact_id, version, hash, host_id, relative_path, accepted, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(target_job_id, artifact_id, version) DO UPDATE SET
           hash = excluded.hash,
           host_id = excluded.host_id,
           relative_path = excluded.relative_path,
           accepted = excluded.accepted`,
      )
      .run(
        input.targetJobId,
        input.sourceJobId,
        input.artifactId,
        input.version,
        opened.value.hash,
        placed.hostId,
        placed.relativePath,
        opened.value.accepted ? 1 : 0,
        nowUtc(ctx),
      );
    if (handoff) {
      deps.db
        .prepare(
          `INSERT INTO agency_job_handoff (
             target_job_id, prior_attempt_id, from_snapshot_digest, return_reason, open_questions
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(target_job_id) DO UPDATE SET
             prior_attempt_id = excluded.prior_attempt_id,
             from_snapshot_digest = excluded.from_snapshot_digest,
             return_reason = excluded.return_reason,
             open_questions = excluded.open_questions`,
        )
        .run(
          input.targetJobId,
          handoff.priorAttemptId,
          handoff.fromSnapshotDigest,
          handoff.reason,
          toJson(handoff.questions),
        );
    }
    const sourceIds = deps.db
      .prepare(`SELECT DISTINCT source_job_id FROM agency_job_input_ref WHERE target_job_id = ?`)
      .all(input.targetJobId) as Array<{ source_job_id: string }>;
    return ok({
      targetJobId: input.targetJobId,
      sourceJobId: input.sourceJobId,
      artifactId: input.artifactId,
      version: input.version,
      hash: opened.value.hash,
      hostId: placed.hostId,
      relativePath: placed.relativePath,
      publishedVerified: true as const,
      accepted: opened.value.accepted,
      authorizedInputJobIds: [input.targetJobId, ...sourceIds.map((row) => row.source_job_id)],
    });
  });
}

/** A copied input is verified in the target folder; null when the row points at the source folder. */
async function openInputCopy(
  deps: { store: DomainStore; files: HostFilePort },
  job: { bindingId: string },
  row: InputRow,
): Promise<DomainResult<ArtifactVersion> | null> {
  const source = deps.store.getJob(row.source_job_id);
  if (!source || source.bindingId === job.bindingId) return null;
  const binding = deps.store.getBinding(job.bindingId);
  if (!binding) return fail("not_found", `binding ${job.bindingId} not found`);
  const pinned = deps.store.getArtifactVersion(row.artifact_id, row.source_job_id, row.version);
  if (!pinned || pinned.hash !== row.hash) {
    return fail("artifact_hash_mismatch", `input ${row.artifact_id} v${row.version} no longer matches its pinned version`);
  }
  if (row.host_id !== binding.hostId || deps.files.hostId !== binding.hostId) {
    return fail("host_mismatch", `input copy ${row.artifact_id} v${row.version} is not on the job's machine; attach it again`);
  }
  const bytes = await deps.files.read(binding.canonicalRoot, row.relative_path);
  if (!bytes.ok) return bytes;
  if (hashBytes(bytes.value) !== row.hash || bytes.value.byteLength !== pinned.size) {
    return fail("artifact_hash_mismatch", `input copy ${row.relative_path} was changed; attach the version again`);
  }
  return ok({ ...pinned, hostId: binding.hostId, relativePath: row.relative_path });
}

export async function loadJobInputsForPrepare(
  deps: { store: DomainStore; db: SqlDatabase; files: HostFilePort },
  ctx: ServiceContext,
  jobId: string,
): Promise<DomainResult<PreparedJobInputs>> {
  const job = deps.store.getJob(jobId);
  if (!job) return fail("not_found", `job ${jobId} not found`);
  const access = deps.store.assertBindingAccess(ctx, job.bindingId);
  if (!access.ok) return access;
  const rows = deps.db
    .prepare(
      `SELECT target_job_id, source_job_id, artifact_id, version, hash, host_id, relative_path, accepted
       FROM agency_job_input_ref WHERE target_job_id = ?`,
    )
    .all(jobId) as InputRow[];
  const inputArtifactVersions: ArtifactVersion[] = [];
  const authorized = new Set<string>([jobId]);
  const inputRefs: InputArtifactRef[] = [];
  for (const row of rows) {
    const copied = await openInputCopy(deps, job, row);
    if (copied) {
      if (!copied.ok) return copied;
      authorized.add(row.source_job_id);
      inputArtifactVersions.push(copied.value);
      inputRefs.push({
        artifactId: copied.value.artifactId,
        version: copied.value.version,
        hash: copied.value.hash,
        jobId: copied.value.jobId,
        hostId: copied.value.hostId,
        relativePath: copied.value.relativePath,
      });
      continue;
    }
    const opened = await openPinnedVersion({
      store: deps.store,
      db: deps.db,
      files: deps.files,
      ctx,
      artifactId: row.artifact_id,
      sourceJobId: row.source_job_id,
      version: row.version,
      hash: row.hash,
    });
    if (!opened.ok) return opened;
    authorized.add(row.source_job_id);
    const { accepted: _accepted, bytes: _bytes, ...version } = opened.value;
    inputArtifactVersions.push(version);
    inputRefs.push({
      artifactId: opened.value.artifactId,
      version: opened.value.version,
      hash: opened.value.hash,
      jobId: opened.value.jobId,
      hostId: opened.value.hostId,
      relativePath: opened.value.relativePath,
    });
  }
  const handoffRow = deps.db
    .prepare(
      `SELECT prior_attempt_id, from_snapshot_digest, return_reason, open_questions
       FROM agency_job_handoff WHERE target_job_id = ?`,
    )
    .get(jobId) as
    | {
        prior_attempt_id: string;
        from_snapshot_digest: string;
        return_reason: string | null;
        open_questions: string;
      }
    | undefined;
  let handoff: HandoffPackage | null = null;
  if (handoffRow) {
    const acceptedArtifacts = rows
      .filter((row) => row.accepted === 1)
      .map((row) => {
        const match = inputRefs.find(
          (ref) => ref.artifactId === row.artifact_id && ref.version === row.version,
        );
        return match;
      })
      .filter((item): item is InputArtifactRef => Boolean(item));
    const body = {
      priorRunAttemptId: handoffRow.prior_attempt_id,
      fromSnapshotDigest: handoffRow.from_snapshot_digest,
      acceptedArtifacts,
      openQuestions: parseJson(handoffRow.open_questions) as string[],
      returnReason: handoffRow.return_reason,
    };
    handoff = { ...body, hash: computeHandoffHash(body) };
  }
  return ok({
    inputArtifactVersions,
    authorizedInputJobIds: [...authorized],
    handoff,
  });
}

export function createJobInputPort(deps: {
  store: DomainStore;
  db: SqlDatabase;
  files: HostFilePort;
}): JobInputPort {
  return {
    loadForPrepare: (ctx, jobId) => loadJobInputsForPrepare(deps, ctx, jobId),
  };
}
