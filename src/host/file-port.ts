import type { DomainResult } from "../domain";

export type HostFileKind = "local-test" | "sdk-host";

export type HostFileStat = {
  size: number;
  hash: string;
};

/**
 * Filesystem operations for one bound host. The adapter identity is hostId;
 * a local writer must not be labeled as a different enrolled host.
 */
export interface HostFilePort {
  readonly hostId: string;
  readonly kind: HostFileKind;
  writeAtomic(canonicalRoot: string, relativePath: string, bytes: Uint8Array): Promise<DomainResult<HostFileStat>>;
  read(canonicalRoot: string, relativePath: string): Promise<DomainResult<Uint8Array>>;
  stat(canonicalRoot: string, relativePath: string): Promise<DomainResult<HostFileStat | undefined>>;
  remove(canonicalRoot: string, relativePath: string): Promise<DomainResult<void>>;
}

export function assertAdapterMatchesBinding(
  files: HostFilePort,
  bindingHostId: string,
): DomainResult<HostFilePort> {
  if (files.hostId !== bindingHostId) {
    return {
      ok: false,
      error: {
        code: "host_adapter_mismatch",
        message: `adapter ${files.hostId} cannot write binding host ${bindingHostId}`,
      },
    };
  }
  return { ok: true, value: files };
}
