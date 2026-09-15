/** Distinguish omitted fields from explicit null/value in request identity payloads. */
export type IdentityOptional<T> = { omitted: true } | { omitted: false; value: T };

export function identityOptional<T>(value: T | undefined): IdentityOptional<T> {
  return value === undefined ? { omitted: true } : { omitted: false, value };
}
