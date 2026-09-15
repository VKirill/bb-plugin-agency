export type DomainError = {
  code: string;
  message: string;
};

export type DomainResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DomainError };

export function ok<T>(value: T): DomainResult<T> {
  return { ok: true, value };
}

export function fail(code: string, message: string): DomainResult<never> {
  return { ok: false, error: { code, message } };
}

/** Thrown inside better-sqlite transactions so `return fail()` cannot commit writes. */
export class DomainTxnAbort extends Error {
  readonly domainError: DomainError;

  constructor(error: DomainError) {
    super(error.message);
    this.name = "DomainTxnAbort";
    this.domainError = error;
  }
}

export function isDomainTxnAbort(error: unknown): error is DomainTxnAbort {
  return error instanceof DomainTxnAbort;
}

export function domainAbortResult(error: unknown): DomainResult<never> | undefined {
  return isDomainTxnAbort(error) ? fail(error.domainError.code, error.domainError.message) : undefined;
}
