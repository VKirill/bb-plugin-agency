import type { HostFilePort } from "./file-port";
import { readGuarded, removeGuarded, statGuarded, writeAtomicGuarded } from "./guarded-fs";

/**
 * Temp-FS / in-process adapter for tests. kind is always local-test so a
 * production wiring cannot silently treat this as a remote enrolled host.
 */
export function createLocalHostFilePort(hostId: string): HostFilePort {
  return {
    hostId,
    kind: "local-test",
    writeAtomic: writeAtomicGuarded,
    read: readGuarded,
    stat: statGuarded,
    remove: removeGuarded,
  };
}
