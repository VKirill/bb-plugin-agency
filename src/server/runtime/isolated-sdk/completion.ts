import { fail, ok, type DomainResult } from "../../../domain";
import { hashBytes } from "../../../host/guarded-fs.js";
import type { ArtifactVersion } from "../../../shared/contracts/artifact.js";

/**
 * Published = current ArtifactVersion exists and open bytes hash+size match the row.
 * Accepted = acceptance row equals that current version+hash. Accepted is not
 * published. Idle alone is not review. Review needs publishedVerified from
 * open/hash, not a caller boolean.
 */
export type CompletionReading = {
  runSucceeded: false;
  runFailed: boolean;
  mayEnterReview: boolean;
  publishedVerified: boolean;
  acceptedVerified: boolean;
  threadStatus: string | null;
  reason: string;
};

export type OpenedArtifactBytes = {
  bytes: Uint8Array;
  hash: string;
  size: number;
};

export function interpretVerifiedCompletion(input: {
  threadStatus: string | null;
  publishedVerified: boolean;
  acceptedVerified: boolean;
}): CompletionReading {
  const acceptedVerified = input.acceptedVerified === true;
  const publishedVerified = input.publishedVerified === true;
  if (input.threadStatus === "error") {
    return {
      runSucceeded: false,
      runFailed: true,
      mayEnterReview: false,
      publishedVerified,
      acceptedVerified,
      threadStatus: input.threadStatus,
      reason: "core thread status error; run is not succeeded",
    };
  }
  if (input.threadStatus === "idle" && publishedVerified) {
    return {
      runSucceeded: false,
      runFailed: false,
      mayEnterReview: true,
      publishedVerified,
      acceptedVerified,
      threadStatus: input.threadStatus,
      reason: acceptedVerified
        ? "published current version hash verified; accepted is a separate later step; idle is not succeeded"
        : "published current version hash verified; idle is not succeeded; accept is not implied",
    };
  }
  if (input.threadStatus === "idle") {
    return {
      runSucceeded: false,
      runFailed: false,
      mayEnterReview: false,
      publishedVerified,
      acceptedVerified,
      threadStatus: input.threadStatus,
      reason: "idle alone is not review; current published artifact was not hash-verified",
    };
  }
  return {
    runSucceeded: false,
    runFailed: false,
    mayEnterReview: false,
    publishedVerified,
    acceptedVerified,
    threadStatus: input.threadStatus,
    reason: `core thread status ${input.threadStatus ?? "missing"} is not a completed Agency run`,
  };
}

export function verifyOpenedCurrentVersion(input: {
  version: ArtifactVersion | null;
  opened: OpenedArtifactBytes | null;
  acceptance?: { version: number; hash: string } | null;
  jobId: string;
}): DomainResult<{ publishedVerified: true; acceptedVerified: boolean; version: ArtifactVersion }> {
  if (!input.version) {
    return fail("artifact_missing", `job ${input.jobId} has no current ArtifactVersion`);
  }
  if (input.version.jobId !== input.jobId) {
    return fail("artifact_scope_mismatch", "current ArtifactVersion is not scoped to this job");
  }
  if (!input.opened) {
    return fail("artifact_open_missing", "current version could not be opened");
  }
  const actualHash = hashBytes(input.opened.bytes);
  if (actualHash !== input.version.hash || input.opened.bytes.byteLength !== input.version.size) {
    return fail(
      "artifact_hash_mismatch",
      `opened ${input.opened.bytes.byteLength}/${actualHash} != stored ${input.version.size}/${input.version.hash}`,
    );
  }
  if (actualHash !== input.opened.hash || input.opened.size !== input.version.size) {
    return fail("artifact_hash_mismatch", "opened metadata does not match bytes");
  }
  const acceptedVerified = Boolean(
    input.acceptance &&
      input.acceptance.version === input.version.version &&
      input.acceptance.hash === input.version.hash,
  );
  return ok({ publishedVerified: true, acceptedVerified, version: input.version });
}
