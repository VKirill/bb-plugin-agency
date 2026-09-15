import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { SqlDatabase } from "../../db/sql";

/** Append through the normal migration owner. This module never migrates on read. */
export const RESOURCE_LEASE_MIGRATION = `CREATE TABLE agency_resource_lease (
  host_id TEXT NOT NULL,
  canonical_root TEXT NOT NULL,
  owner_attempt_id TEXT NOT NULL,
  token TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation > 0),
  expires_at INTEGER NOT NULL,
  released_at INTEGER,
  PRIMARY KEY(host_id, canonical_root)
);`;

export type ResourceLease = {
  hostId: string; canonicalRoot: string; ownerAttemptId: string;
  token: string; generation: number; expiresAt: number;
};
type Row = {
  host_id: string; canonical_root: string; owner_attempt_id: string;
  token: string; generation: number; expires_at: number; released_at: number | null;
};
export class ResourceLeaseError extends Error {
  constructor(public readonly code: string) { super(code); }
}
/** Internal trusted adapter: must confirm no writer can continue for this claim.
 * Idle alone and elapsed TTL are not proof. No caller-provided boolean at RPC. */
export interface ResourceQuiescencePort {
  verify(claim: Readonly<ResourceLease>): Promise<"confirmed" | "unavailable" | "still_active">;
}
const model = (r: Row): ResourceLease => ({ hostId:r.host_id, canonicalRoot:r.canonical_root,
  ownerAttemptId:r.owner_attempt_id, token:r.token, generation:r.generation, expiresAt:r.expires_at });
const overlaps = (a: string, b: string) => a === b || a === "/" || b === "/" || a.startsWith(b + "/") || b.startsWith(a + "/");
function validRoot(root: string) {
  if (!root.startsWith("/") || root.includes("\0") || posix.normalize(root) !== root || (root !== "/" && root.endsWith("/"))) {
    throw new ResourceLeaseError("resource_root_not_canonical");
  }
}
function ttl(value: number) {
  if (!Number.isSafeInteger(value) || value < 1000 || value > 300_000) throw new ResourceLeaseError("lease_ttl_invalid");
}
/** Private persistence port. Caller resolves authorized live binding/root on host,
 * verifies snapshot identity and supplies a trusted stop/reconcile verifier. */
export function createResourceLeaseStore(db: SqlDatabase, quiescence: ResourceQuiescencePort, now = Date.now) {
  const get = (hostId: string, root: string) => db.prepare("SELECT * FROM agency_resource_lease WHERE host_id=? AND canonical_root=?").get(hostId, root) as Row | undefined;
  function own(claim: ResourceLease): Row {
    const row = get(claim.hostId, claim.canonicalRoot);
    if (!row || row.released_at !== null || row.token !== claim.token || row.generation !== claim.generation || row.owner_attempt_id !== claim.ownerAttemptId) {
      throw new ResourceLeaseError("lease_fence_mismatch");
    }
    return row;
  }
  const acquire = db.transaction((input: {hostId:string;canonicalRoot:string;ownerAttemptId:string;ttlMs:number}) => {
    validRoot(input.canonicalRoot); ttl(input.ttlMs);
    if (!input.hostId || !input.ownerAttemptId) throw new ResourceLeaseError("lease_identity_invalid");
    const time = now();
    const held = db.prepare("SELECT * FROM agency_resource_lease WHERE host_id=? AND released_at IS NULL").all(input.hostId) as Row[];
    const conflict = held.find(row => overlaps(row.canonical_root, input.canonicalRoot));
    if (conflict) {
      if (conflict.owner_attempt_id === input.ownerAttemptId && conflict.canonical_root === input.canonicalRoot && conflict.expires_at > time) return model(conflict);
      throw new ResourceLeaseError(conflict.expires_at <= time ? "lease_needs_reconciliation" : "resource_busy");
    }
    const old = get(input.hostId, input.canonicalRoot);
    const claim: ResourceLease = {hostId:input.hostId,canonicalRoot:input.canonicalRoot,ownerAttemptId:input.ownerAttemptId,
      token:randomUUID(),generation:(old?.generation ?? 0)+1,expiresAt:time+input.ttlMs};
    db.prepare(`INSERT INTO agency_resource_lease(host_id,canonical_root,owner_attempt_id,token,generation,expires_at,released_at)
      VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(host_id,canonical_root) DO UPDATE SET owner_attempt_id=excluded.owner_attempt_id,
      token=excluded.token,generation=excluded.generation,expires_at=excluded.expires_at,released_at=NULL`).run(
      claim.hostId,claim.canonicalRoot,claim.ownerAttemptId,claim.token,claim.generation,claim.expiresAt);
    return claim;
  });
  const renew = db.transaction((claim:ResourceLease, ttlMs:number) => {
    ttl(ttlMs); const row=own(claim); const time=now();
    if (row.expires_at <= time) throw new ResourceLeaseError("lease_needs_reconciliation");
    const expiresAt=Math.max(row.expires_at,time+ttlMs);
    db.prepare("UPDATE agency_resource_lease SET expires_at=? WHERE host_id=? AND canonical_root=? AND token=?").run(expiresAt,claim.hostId,claim.canonicalRoot,claim.token);
    return {...model(row),expiresAt};
  });
  return {
    acquire(input: Parameters<typeof acquire>[0]) { return acquire.immediate(input); },
    renew(claim:ResourceLease, ttlMs:number) { return renew.immediate(claim,ttlMs); },
    assertCurrent(claim:ResourceLease) {
      const row=own(claim);
      if (row.expires_at <= now()) throw new ResourceLeaseError("lease_needs_reconciliation");
      return model(row);
    },
    async release(claim:ResourceLease) {
      const verified = model(own(claim));
      if (await quiescence.verify(Object.freeze(verified)) !== "confirmed") throw new ResourceLeaseError("resource_quiescence_unproven");
      // Recheck the fence after asynchronous verification; old tokens cannot release a new owner.
      db.transaction(() => {
        own(claim);
        db.prepare("UPDATE agency_resource_lease SET released_at=? WHERE host_id=? AND canonical_root=? AND token=?").run(now(),claim.hostId,claim.canonicalRoot,claim.token);
      }).immediate();
    },
  };
}
