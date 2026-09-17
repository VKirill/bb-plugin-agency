import { hashBytes, readGuarded, removeGuarded, replaceGuarded, statGuarded, writeAtomicGuarded } from "./guarded-fs";
import type { HostFileOpInput, HostFileOpOutput } from "./file-contract";

/**
 * Host-local ops. `canonicalRoot` is a jail from the Agency server, not an
 * access grant. Keep error.code so the SDK client can return DomainResult.
 */
export async function handleHostFileOp(input: HostFileOpInput): Promise<HostFileOpOutput> {
  if (input.op === "writeAtomic") {
    if (input.bytesBase64 === undefined) {
      return { ok: false, code: "invalid_file_op", message: "writeAtomic requires bytesBase64" };
    }
    const written = await writeAtomicGuarded(
      input.canonicalRoot,
      input.relativePath,
      Buffer.from(input.bytesBase64, "base64"),
    );
    if (!written.ok) return { ok: false, code: written.error.code, message: written.error.message };
    return { ok: true, size: written.value.size, hash: written.value.hash };
  }
  if (input.op === "replace") {
    if (input.bytesBase64 === undefined || input.expectedHash === undefined) {
      return { ok: false, code: "invalid_file_op", message: "replace requires bytesBase64 and expectedHash" };
    }
    const replaced = await replaceGuarded(
      input.canonicalRoot,
      input.relativePath,
      Buffer.from(input.bytesBase64, "base64"),
      input.expectedHash,
    );
    if (!replaced.ok) return { ok: false, code: replaced.error.code, message: replaced.error.message };
    return { ok: true, size: replaced.value.size, hash: replaced.value.hash };
  }
  if (input.op === "read") {
    const bytes = await readGuarded(input.canonicalRoot, input.relativePath);
    if (!bytes.ok) return { ok: false, code: bytes.error.code, message: bytes.error.message };
    return {
      ok: true,
      size: bytes.value.byteLength,
      hash: hashBytes(bytes.value),
      bytesBase64: Buffer.from(bytes.value).toString("base64"),
    };
  }
  if (input.op === "stat") {
    const stat = await statGuarded(input.canonicalRoot, input.relativePath);
    if (!stat.ok) return { ok: false, code: stat.error.code, message: stat.error.message };
    if (!stat.value) return { ok: true, missing: true };
    return { ok: true, size: stat.value.size, hash: stat.value.hash, missing: false };
  }
  const removed = await removeGuarded(input.canonicalRoot, input.relativePath);
  if (!removed.ok) return { ok: false, code: removed.error.code, message: removed.error.message };
  return { ok: true };
}
