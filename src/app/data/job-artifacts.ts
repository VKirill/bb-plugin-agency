/** Normalize getJob.artifacts for worker-published files. Shared/server stay backend-owned. */

import type { Artifact, ArtifactVersion } from "../../shared/contracts";
import type { TaskFile } from "../prototype/data";
import { isOpaqueRecordId } from "./content-hash";

const HASH = /^[a-f0-9]{64}$/i;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function versionOf(value: unknown): number | undefined {
  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(raw) && raw >= 1 ? raw : undefined;
}

function asVersionList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value];
  return [];
}

export function parseArtifactVersionRow(value: unknown): ArtifactVersion | null {
  const row = record(value);
  if (!row) return null;
  const artifactId = text(row.artifactId, row.artifact_id);
  const jobId = text(row.jobId, row.job_id);
  const version = versionOf(row.version);
  const hash = text(row.hash);
  const relativePath = text(row.relativePath, row.relative_path);
  const sizeRaw = row.size;
  const size = typeof sizeRaw === "number" ? sizeRaw : typeof sizeRaw === "string" ? Number(sizeRaw) : 0;
  if (!artifactId || !isOpaqueRecordId(artifactId) || !version || !hash || !HASH.test(hash) || !relativePath) {
    return null;
  }
  const mime = text(row.mime) || (/\.(png|jpe?g|webp|gif)$/i.test(relativePath) ? "image/png" : "text/markdown");
  return {
    artifactId,
    jobId: jobId && isOpaqueRecordId(jobId) ? jobId : artifactId,
    version,
    hostId: text(row.hostId, row.host_id) || "host_unknown",
    relativePath,
    mime,
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    hash: hash.toLowerCase(),
    author: { kind: "system" },
  };
}

export type JobArtifactGroup = { artifact: Artifact; versions: ArtifactVersion[] };

export function parseJobArtifactGroups(value: unknown): JobArtifactGroup[] {
  if (!Array.isArray(value)) return [];
  const grouped = new Map<string, JobArtifactGroup>();
  for (const item of value) {
    const row = record(item);
    if (!row) continue;
    const artifactRow = record(row.artifact);
    const artifactId = text(artifactRow?.id, row.artifactId, row.artifact_id, row.id);
    const versions = asVersionList(row.versions ?? row.version ?? (row.artifactId || row.hash ? item : null))
      .map(parseArtifactVersionRow)
      .filter((entry): entry is ArtifactVersion => Boolean(entry));
    const id = artifactId && isOpaqueRecordId(artifactId)
      ? artifactId
      : versions[0]?.artifactId;
    if (!id) continue;
    const jobId = text(artifactRow?.jobId, artifactRow?.job_id, versions[0]?.jobId) || id;
    const current = grouped.get(id) ?? { artifact: { id, jobId }, versions: [] };
    current.versions.push(...versions);
    current.versions.sort((left, right) => left.version - right.version);
    grouped.set(id, current);
  }
  return [...grouped.values()];
}

export function mapJobFilesFromArtifacts(artifacts: unknown): TaskFile[] {
  return parseJobArtifactGroups(artifacts).flatMap((item) => {
    const current = item.versions.at(-1);
    if (!current) return [];
    return [{
      id: item.artifact.id,
      name: current.relativePath.split("/").at(-1) || item.artifact.id,
      size: current.size,
      content: "",
      kind: current.mime.startsWith("image/") ? "image" : "text",
      version: current.version,
      hash: current.hash,
      mime: current.mime,
    } satisfies TaskFile];
  });
}

/** getJob mapped files win over local stubs without version/hash. */
export function mergeJobFiles(...lists: Array<readonly TaskFile[] | undefined>): TaskFile[] {
  const byId = new Map<string, TaskFile>();
  for (const list of lists) {
    for (const file of list ?? []) {
      const previous = byId.get(file.id);
      if (!previous) {
        byId.set(file.id, file);
        continue;
      }
      const nextProven = Boolean(file.version && file.hash);
      const prevProven = Boolean(previous.version && previous.hash);
      byId.set(file.id, nextProven || !prevProven
        ? { ...previous, ...file, content: file.content || previous.content }
        : { ...file, ...previous, content: previous.content || file.content });
    }
  }
  return [...byId.values()];
}
