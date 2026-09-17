import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fail, ok, type DomainResult } from "../domain";

export function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function joinUnderRoot(canonicalRoot: string, relativePath: string): DomainResult<string> {
  if (isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.split("/").includes("..")) {
    return fail("path_escape", `relative path escapes the binding root: ${relativePath}`);
  }
  const root = resolve(canonicalRoot);
  const candidate = resolve(root, relativePath);
  if (candidate === root || !isPathInside(root, candidate)) {
    return fail("path_escape", `resolved path is outside ${root}`);
  }
  return ok(candidate);
}

export function originalRelativePath(artifactId: string, version: number): string {
  return join(".agency", "originals", artifactId, `v${version}`);
}

/** Copy of an input version from another folder, placed next to the job that reads it. */
export function inputCopyRelativePath(artifactId: string, version: number): string {
  return join(".agency", "inputs", artifactId, `v${version}`);
}

export function stagingRelativePath(requestId: string): string {
  return join(".agency", "staging", requestId);
}

const PREVIEW_EXTENSIONS = [
  "md",
  "markdown",
  "txt",
  "json",
  "yaml",
  "yml",
  "csv",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
] as const;

const MIME_EXTENSION: Record<string, (typeof PREVIEW_EXTENSIONS)[number]> = {
  "text/markdown": "md",
  "text/x-markdown": "md",
  "text/plain": "txt",
  "application/json": "json",
  "application/yaml": "yaml",
  "text/yaml": "yaml",
  "text/x-yaml": "yaml",
  "text/csv": "csv",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export type PreviewExtension = (typeof PREVIEW_EXTENSIONS)[number];

function allowlistedExtension(value: string | undefined): PreviewExtension | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  return PREVIEW_EXTENSIONS.find((item) => item === normalized);
}

/** Safe suffix for preview cache. Never pass a raw relativePath into join. */
export function previewFileExtension(input: { mime?: string; fileName?: string }): PreviewExtension {
  const name = input.fileName?.split("/").pop() ?? "";
  const fromName = allowlistedExtension(/\.([a-z0-9]{1,8})$/i.exec(name)?.[1]);
  if (fromName) return fromName;
  const mime = input.mime?.split(";")[0]?.trim().toLowerCase();
  return (mime ? MIME_EXTENSION[mime] : undefined) ?? "md";
}

export function previewRelativePath(artifactId: string, hash: string, extension: string = "md"): string {
  const ext = allowlistedExtension(extension) ?? "md";
  return [".agency", "preview", artifactId, `${hash}.${ext}`].join("/");
}
