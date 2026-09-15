import { canonicalizeJson, sha256Hex } from "../context-snapshot/canonical.js";
import type { ContextSnapshot } from "../context-snapshot/types.js";

export function snapshotBodyDigest(snapshot: Omit<ContextSnapshot, "digest"> | ContextSnapshot): string {
  const { digest: _digest, ...body } = snapshot as ContextSnapshot;
  return sha256Hex(canonicalizeJson(body));
}

export function assertSnapshotIntegrity(snapshot: ContextSnapshot): { ok: true } | { ok: false; code: string; message: string } {
  if (snapshot.schemaVersion !== 2) {
    return { ok: false, code: "snapshot_corrupt", message: "snapshot schemaVersion is not 2" };
  }
  if (snapshot.provenance?.compilerAttestsAuth !== false || snapshot.provenance?.recordsVerifiedBy !== "caller") {
    return { ok: false, code: "compiler_not_auth", message: "compiler is not authorization; recordsVerifiedBy must be caller" };
  }
  if (typeof snapshot.digest !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.digest)) {
    return { ok: false, code: "snapshot_digest_mismatch", message: "snapshot digest must be 64 hex" };
  }
  const computed = snapshotBodyDigest(snapshot);
  if (computed !== snapshot.digest) {
    return { ok: false, code: "snapshot_digest_mismatch", message: "snapshot digest does not match canonical body" };
  }
  return { ok: true };
}
