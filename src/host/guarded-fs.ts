import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fail, ok, type DomainResult } from "../domain";
import { isPathInside, joinUnderRoot } from "./safe-path";
import type { HostFileStat } from "./file-port";

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function existingRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error) return (error as NodeJS.ErrnoException).code;
  return undefined;
}

/**
 * Resolve each segment on this machine. A symlink whose real path leaves the
 * binding root is rejected even when the lexical relative path looks safe.
 * This is not a proof against a hostile replacement that races between
 * checks and `mkdir`/`link`.
 */
export async function resolveGuardedPath(
  canonicalRoot: string,
  relativePath: string,
): Promise<DomainResult<string>> {
  const lexical = joinUnderRoot(canonicalRoot, relativePath);
  if (!lexical.ok) return lexical;
  const rootReal = await existingRealpath(canonicalRoot);
  if (!rootReal) {
    return fail("binding_root_missing", `binding root is missing: ${canonicalRoot}`);
  }
  let current = rootReal;
  const segments = relativePath.split("/").filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const next = join(current, segment);
    let stat;
    try {
      stat = await lstat(next);
    } catch (error) {
      if (isNotFound(error)) {
        const remainder = join(next, ...segments.slice(index + 1));
        if (!isPathInside(rootReal, remainder)) {
          return fail("path_escape", `path leaves ${rootReal}`);
        }
        return ok(remainder);
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const target = await existingRealpath(next);
      if (!target || !isPathInside(rootReal, target)) {
        return fail("path_escape", `symlink escapes the binding root at ${segment}`);
      }
      current = target;
      continue;
    }
    const real = await existingRealpath(next);
    if (!real || !isPathInside(rootReal, real)) {
      return fail("path_escape", `path leaves ${rootReal}`);
    }
    current = real;
  }
  return ok(current);
}

async function unlinkOwn(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

export async function writeAtomicGuarded(
  canonicalRoot: string,
  relativePath: string,
  bytes: Uint8Array,
): Promise<DomainResult<HostFileStat>> {
  const dest = await resolveGuardedPath(canonicalRoot, relativePath);
  if (!dest.ok) return dest;
  await mkdir(dirname(dest.value), { recursive: true, mode: 0o700 });
  const destAfter = await resolveGuardedPath(canonicalRoot, relativePath);
  if (!destAfter.ok) return destAfter;
  const parentAfter = await resolveGuardedPath(canonicalRoot, dirname(relativePath));
  if (!parentAfter.ok) return parentAfter;
  if (dirname(destAfter.value) !== parentAfter.value) {
    return fail("path_escape", `parent of ${relativePath} changed after mkdir`);
  }

  const ownTemp = `${destAfter.value}.tmp-${randomUUID()}`;
  try {
    await writeFile(ownTemp, bytes, { flag: "wx", mode: 0o600 });
    try {
      await link(ownTemp, destAfter.value);
    } catch (error) {
      await unlinkOwn(ownTemp);
      if (errorCode(error) === "EEXIST") {
        return fail("artifact_immutable", `refusing to overwrite ${relativePath}`);
      }
      return fail("host_file_error", error instanceof Error ? error.message : String(error));
    }
    await unlinkOwn(ownTemp);
  } catch (error) {
    await unlinkOwn(ownTemp);
    if (errorCode(error) === "EEXIST") {
      return fail("host_file_error", `staging name collided for ${relativePath}`);
    }
    return fail("host_file_error", error instanceof Error ? error.message : String(error));
  }
  try {
    const written = await readFile(destAfter.value);
    return ok({ size: written.byteLength, hash: hashBytes(written) });
  } catch (error) {
    return fail("host_file_error", error instanceof Error ? error.message : String(error));
  }
}

export async function readGuarded(
  canonicalRoot: string,
  relativePath: string,
): Promise<DomainResult<Uint8Array>> {
  const dest = await resolveGuardedPath(canonicalRoot, relativePath);
  if (!dest.ok) return dest;
  try {
    return ok(await readFile(dest.value));
  } catch (error) {
    if (isNotFound(error)) {
      return fail("artifact_file_missing", `file is missing: ${relativePath}`);
    }
    return fail("host_file_error", error instanceof Error ? error.message : String(error));
  }
}

export async function statGuarded(
  canonicalRoot: string,
  relativePath: string,
): Promise<DomainResult<HostFileStat | undefined>> {
  const dest = await resolveGuardedPath(canonicalRoot, relativePath);
  if (!dest.ok) return dest;
  try {
    const bytes = await readFile(dest.value);
    return ok({ size: bytes.byteLength, hash: hashBytes(bytes) });
  } catch (error) {
    if (isNotFound(error)) return ok(undefined);
    return fail("host_file_error", error instanceof Error ? error.message : String(error));
  }
}

export async function removeGuarded(
  canonicalRoot: string,
  relativePath: string,
): Promise<DomainResult<void>> {
  const dest = await resolveGuardedPath(canonicalRoot, relativePath);
  if (!dest.ok) return dest;
  try {
    await unlink(dest.value);
  } catch (error) {
    if (!isNotFound(error)) {
      return fail("host_file_error", error instanceof Error ? error.message : String(error));
    }
  }
  return ok(undefined);
}
