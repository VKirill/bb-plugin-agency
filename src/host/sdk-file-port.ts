import { fail, ok, type DomainResult } from "../domain";
import type { HostFilePort, HostFileStat } from "./file-port";
import type { HostFileOpInput, HostFileOpOutput } from "./file-contract";

export type BoundHostTarget = {
  hostId: string;
  canonicalRoot: string;
};

export type BoundFileCall = {
  hostId: string;
  canonicalRoot: string;
};

/**
 * Server caller gate. No host RPC until a verified binding has hostId and
 * canonicalRoot. Does not read primaryHostId.
 */
export function resolveBoundFileCall(
  binding: BoundHostTarget | null | undefined,
): DomainResult<BoundFileCall> {
  if (binding == null) {
    return fail("binding_missing", "verified ProjectBinding is required before a host file call");
  }
  const hostId = binding.hostId.trim();
  if (!hostId) {
    return fail("binding_host_missing", "verified ProjectBinding has no hostId");
  }
  const canonicalRoot = binding.canonicalRoot.trim();
  if (!canonicalRoot) {
    return fail("binding_root_missing", "verified ProjectBinding has no canonicalRoot");
  }
  return ok({ hostId, canonicalRoot });
}

export function resolveBoundFileOp(
  binding: BoundHostTarget | null | undefined,
  input: {
    op: HostFileOpInput["op"];
    relativePath: string;
    bytesBase64?: string;
    canonicalRoot?: string;
    expectedHash?: string | null;
  },
): DomainResult<{ hostId: string; input: HostFileOpInput }> {
  const bound = resolveBoundFileCall(binding);
  if (!bound.ok) return bound;
  if (input.canonicalRoot !== undefined && input.canonicalRoot !== bound.value.canonicalRoot) {
    return fail("untrusted_root", "payload canonicalRoot cannot replace the binding root");
  }
  return ok({
    hostId: bound.value.hostId,
    input: {
      op: input.op,
      relativePath: input.relativePath,
      canonicalRoot: bound.value.canonicalRoot,
      ...(input.bytesBase64 === undefined ? {} : { bytesBase64: input.bytesBase64 }),
      ...(input.expectedHash === undefined ? {} : { expectedHash: input.expectedHash }),
    },
  });
}

export function createSdkHostFilePortFromBinding(
  client: HostFileRpcClient,
  binding: BoundHostTarget | null | undefined,
): DomainResult<HostFilePort> {
  const bound = resolveBoundFileCall(binding);
  if (!bound.ok) return bound;
  return ok(createSdkHostFilePort(client, bound.value.hostId));
}

export type HostFileRpcClient = {
  call(
    method: "fileOp",
    input: HostFileOpInput,
    options: { hostId: string },
  ): Promise<HostFileOpOutput>;
};

function transportError(error: unknown) {
  return fail("host_transport", error instanceof Error ? error.message : String(error));
}

/**
 * Verified SDK path: every op goes through hosts.experimental_client with the
 * bound hostId. There is no local write fallback. Root is still server-chosen.
 */
export async function callBoundFileOp(
  client: HostFileRpcClient,
  binding: BoundHostTarget | null | undefined,
  input: {
    op: HostFileOpInput["op"];
    relativePath: string;
    bytesBase64?: string;
    canonicalRoot?: string;
    expectedHash?: string | null;
  },
): Promise<DomainResult<HostFileOpOutput & { ok: true }>> {
  const resolved = resolveBoundFileOp(binding, input);
  if (!resolved.ok) return resolved;
  try {
    const result = await client.call("fileOp", resolved.value.input, { hostId: resolved.value.hostId });
    if (!result.ok) return fail(result.code, result.message);
    return ok(result);
  } catch (error) {
    return transportError(error);
  }
}

export function createSdkHostFilePort(client: HostFileRpcClient, hostId: string): HostFilePort {
  const call = async (input: HostFileOpInput): Promise<DomainResult<HostFileOpOutput & { ok: true }>> => {
    let result: HostFileOpOutput;
    try {
      result = await client.call("fileOp", input, { hostId });
    } catch (error) {
      return transportError(error);
    }
    if (!result.ok) return fail(result.code, result.message);
    return ok(result);
  };
  return {
    hostId,
    kind: "sdk-host",
    async writeAtomic(canonicalRoot, relativePath, bytes) {
      const result = await call({
        op: "writeAtomic",
        canonicalRoot,
        relativePath,
        bytesBase64: Buffer.from(bytes).toString("base64"),
      });
      if (!result.ok) return result;
      if (result.value.hash === undefined || result.value.size === undefined) {
        return fail("host_file_error", "sdk host write did not return size/hash");
      }
      return ok({ size: result.value.size, hash: result.value.hash });
    },
    async read(canonicalRoot, relativePath) {
      const result = await call({ op: "read", canonicalRoot, relativePath });
      if (!result.ok) return result;
      if (result.value.bytesBase64 === undefined) {
        return fail("artifact_file_missing", `sdk host file is missing: ${relativePath}`);
      }
      return ok(Buffer.from(result.value.bytesBase64, "base64"));
    },
    async stat(canonicalRoot, relativePath): Promise<DomainResult<HostFileStat | undefined>> {
      const result = await call({ op: "stat", canonicalRoot, relativePath });
      if (!result.ok) return result;
      if (result.value.missing) return ok(undefined);
      if (result.value.hash === undefined || result.value.size === undefined) {
        return fail("host_file_error", "sdk host stat did not return size/hash");
      }
      return ok({ size: result.value.size, hash: result.value.hash });
    },
    async remove(canonicalRoot, relativePath) {
      const result = await call({ op: "remove", canonicalRoot, relativePath });
      if (!result.ok) return result;
      return ok(undefined);
    },
  };
}
