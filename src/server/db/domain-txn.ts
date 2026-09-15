import { DomainTxnAbort, domainAbortResult, type DomainResult } from "../../domain";
import type { SqlDatabase } from "./sql";

/**
 * better-sqlite `db.transaction(fn)()` commits on a normal return, including
 * `return fail(...)`. Only a throw rolls back. Domain failures after the first
 * write must throw `DomainTxnAbort`.
 */
export function commitDomainTransaction<T>(db: SqlDatabase, work: () => DomainResult<T>): DomainResult<T> {
  try {
    return db.transaction(() => {
      const result = work();
      if (!result.ok) throw new DomainTxnAbort(result.error);
      return result;
    })();
  } catch (error) {
    const aborted = domainAbortResult(error);
    if (aborted) return aborted;
    throw error;
  }
}
