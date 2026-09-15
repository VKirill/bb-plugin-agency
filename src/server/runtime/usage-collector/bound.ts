import type { BoundThreadPort } from "./types.js";

function isBoundThreadPort(bound: BoundThreadPort | Iterable<string>): bound is BoundThreadPort {
  return typeof bound === "object" && bound !== null && "isBound" in bound && typeof bound.isBound === "function";
}

export function asBoundThreadPort(bound: BoundThreadPort | Iterable<string>): BoundThreadPort {
  if (isBoundThreadPort(bound)) return bound;
  const ids = new Set<string>(bound);
  return {
    isBound(threadId: string) {
      return ids.has(threadId);
    },
  };
}
