import { fail, ok, type DomainResult } from "../../domain";
import type { ProjectBinding } from "../../shared/contracts";
import { assertTrustedProject } from "../../domain";

export type TrustedActor =
  | { kind: "user"; userId: string }
  | { kind: "agent"; agentId: string }
  | { kind: "system" };

export type ServiceContext = {
  actor: TrustedActor;
  /** Bindings this call may read or write. claimedBbProjectId is never access. */
  allowedBindingIds: readonly string[];
  clock?: () => string;
};

export type BindingScope = {
  bindingId: string;
  claimedBbProjectId?: string;
};

export function nowUtc(ctx: ServiceContext): string {
  return ctx.clock?.() ?? new Date().toISOString();
}

export function assertBindingAccess(ctx: ServiceContext, bindingId: string): DomainResult<true> {
  if (!ctx.allowedBindingIds.includes(bindingId)) {
    return fail("forbidden_binding", `binding ${bindingId} is outside trusted service context`);
  }
  return ok(true);
}

export function assertBindingScope(
  ctx: ServiceContext,
  binding: ProjectBinding,
  claimedBbProjectId: string | undefined,
): DomainResult<ProjectBinding> {
  const access = assertBindingAccess(ctx, binding.id);
  if (!access.ok) return access;
  return assertTrustedProject(binding, claimedBbProjectId);
}

export function actorToActivity(actor: TrustedActor) {
  if (actor.kind === "user") return { kind: "user" as const, userId: actor.userId };
  if (actor.kind === "agent") return { kind: "agent" as const, agentId: actor.agentId };
  return { kind: "system" as const };
}
