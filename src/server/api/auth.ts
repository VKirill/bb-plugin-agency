import { callerAttemptForThread, callerThreadId } from "./caller";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { fail, ok, type DomainResult } from "../../domain";
import type { ArtifactAuthor } from "../../shared/contracts";
import { actorToActivity, type ServiceContext, type TrustedActor } from "../services";
import { resolveEnvironmentPlacement } from "./bb-catalog";
import { listStoredBindings } from "./catalog";
import type { SqlDatabase } from "../db/sql";

/**
 * Installation-owner model of a personal BB (AGY-19).
 *
 * RPC handlers stay input-only. Origin is spoofable and is not a secret.
 * Origin-less / callRpc are allowed by the platform; they are not isolation.
 * Actor is server context `system` — not a invented user id.
 * Scope is Agency bindings already stored in SQLite. `projects.list` is a
 * catalog check only when creating a binding, never a grant of existing ones.
 */
export const SDK_RPC_AUTH = {
  handlerArity: "input-only",
  httpRoute: "POST /api/v1/plugins/:id/rpc/:method",
  transportAuth: "local-origin-if-present",
  missingOrigin: "allowed",
  originIsSecret: false,
  callerFieldsOnHandler: false,
  inputActorAccepted: false,
  projectsListIsCallerScope: false,
  projectsListRole: "create-binding-existence",
  privilegedGate: "installation-owner",
  actor: "system",
} as const;

export type RpcAccess = {
  ctx: ServiceContext;
};

export type CreateBindingPlacement = {
  bbProjectId: string;
  environmentId: string;
  hostId: string;
  canonicalRoot: string;
};

export function publishAuthorFromActor(actor: TrustedActor): DomainResult<ArtifactAuthor> {
  if (actor.kind === "system") return ok({ kind: "system" });
  if (actor.kind === "user") return ok({ kind: "user", userId: actor.userId });
  return fail("forbidden_author", "publish does not invent a user identity for this actor");
}

export function activityActorFromContext(ctx: ServiceContext) {
  return actorToActivity(ctx.actor);
}

export function resolveRpcAccess(db: SqlDatabase): DomainResult<RpcAccess> {
  const bindings = listStoredBindings(db);
  const threadId = callerThreadId();
  const caller = threadId ? callerAttemptForThread(db, threadId) : null;
  return ok({
    ctx: {
      actor: { kind: "system" },
      allowedBindingIds: bindings.map((binding) => binding.id),
      ...(caller ? { caller } : {}),
    },
  });
}

export async function verifyCreateBindingPlacement(
  bb: BbPluginApi,
  input: CreateBindingPlacement,
): Promise<DomainResult<true>> {
  const placed = await resolveEnvironmentPlacement(bb, input.environmentId);
  if (!placed.ok) return placed;
  if (placed.value.bbProjectId !== input.bbProjectId) {
    return fail("untrusted_project", "environment does not belong to the claimed BB project");
  }
  if (placed.value.hostId !== input.hostId) {
    return fail("untrusted_host", "hostId does not match BB environment metadata");
  }
  if (placed.value.canonicalRoot !== input.canonicalRoot.trim()) {
    return fail("untrusted_root", "canonicalRoot is not the BB environment path");
  }
  return ok(true);
}
