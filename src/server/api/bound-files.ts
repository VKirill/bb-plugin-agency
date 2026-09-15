import { callBoundFileOp, resolveBoundFileOp, type BoundHostTarget, type HostFileRpcClient } from "../../host";

export type BoundFileOpInput = {
  op: "writeAtomic" | "read" | "stat" | "remove";
  relativePath: string;
  bytesBase64?: string;
  canonicalRoot?: string;
};

/**
 * Server-only artifact file call. Root and hostId come from a verified
 * ProjectBinding via AGY-18 helpers. Do not put this on plugin rpcContract.
 */
export function resolveAgencyBoundFileOp(verifiedBinding: BoundHostTarget | null | undefined, input: BoundFileOpInput) {
  return resolveBoundFileOp(verifiedBinding, input);
}

export function runBoundArtifactFileOp(
  documents: HostFileRpcClient,
  verifiedBinding: BoundHostTarget | null | undefined,
  input: BoundFileOpInput,
) {
  return callBoundFileOp(documents, verifiedBinding, input);
}
