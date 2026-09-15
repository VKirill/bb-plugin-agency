import type { TrustedActor } from "./context";

export type RequestIdentity = {
  requestId: string;
  kind: string;
  payload: unknown;
  actor: TrustedActor;
  scopeBindingIds: readonly string[];
};

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function payloadWithoutRequestId(payload: unknown): unknown {
  if (payload && typeof payload === "object" && !Array.isArray(payload) && "requestId" in payload) {
    const { requestId: _requestId, ...rest } = payload as Record<string, unknown>;
    return rest;
  }
  return payload;
}

export function sameActor(left: unknown, right: TrustedActor): boolean {
  if (!left || typeof left !== "object") return false;
  const actor = left as TrustedActor;
  if (actor.kind !== right.kind) return false;
  if (actor.kind === "user" && right.kind === "user") return actor.userId === right.userId;
  if (actor.kind === "agent" && right.kind === "agent") return actor.agentId === right.agentId;
  return actor.kind === "system" && right.kind === "system";
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}
