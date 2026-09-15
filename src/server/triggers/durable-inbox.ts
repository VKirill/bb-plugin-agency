import { ingestInboxEvent, type DispatcherDeps } from "../dispatcher/engine.js";
import { uuidV5 } from "../runtime/launch/operation-ids.js";
import type { SqlDatabase } from "../db/sql";
import type { ServiceContext } from "../services/context.js";
import { assertExplicitBbProjectId } from "./bb-project-scope.js";
import { createCronOccurrenceStore } from "./cron/store.js";
import type { CronInboxDraft, CronInboxPort, CronRule, TickItem } from "./cron/types.js";
import { CronPlannerError } from "./cron/types.js";
import { webhookEnvelopeDigest } from "./webhook-ingress/ingress.js";
import type { WebhookInboxPersist, WebhookInboxPort, WebhookSourcePort } from "./webhook-ingress/ports.js";
import type { WebhookSource } from "./webhook-auth.js";

const INGEST_NS = "7c3e2b10-4a91-5e6f-8d2a-0b19c4e7a331";

type SourceRow = { id: string; project_id: string; kind: string; enabled: number };

function readSource(db: SqlDatabase, sourceId: string): SourceRow | undefined {
  return db.prepare(`SELECT id, project_id, kind, enabled FROM agency_event_source WHERE id = ?`).get(sourceId) as
    | SourceRow
    | undefined;
}

function requireSourceScope(db: SqlDatabase, sourceId: string, bbProjectId: string, kind: "cron" | "webhook"): SourceRow {
  const scoped = assertExplicitBbProjectId(bbProjectId);
  if (!scoped.ok) throw new CronPlannerError(scoped.error.code);
  const source = readSource(db, sourceId);
  if (!source || source.kind !== kind) throw new CronPlannerError("cron_source_unbound");
  const stored = assertExplicitBbProjectId(source.project_id);
  if (!stored.ok || stored.value !== scoped.value) throw new CronPlannerError("cron_scope_unbound");
  return source;
}

export const CRON_OCCURRENCE_PAYLOAD_SCHEMA = {
  type: "object",
  required: ["data"],
  additionalProperties: true,
  properties: {
    data: {
      type: "object",
      required: ["scheduledAtUtc", "timezone", "utcOffsetMinutes", "ruleVersionId"],
      additionalProperties: false,
      properties: {
        scheduledAtUtc: { type: "string", minLength: 1 },
        timezone: { type: "string", minLength: 1 },
        utcOffsetMinutes: { type: "integer" },
        ruleVersionId: { type: "string", minLength: 1 },
      },
    },
  },
} as const;

export function createDurableCronInbox(
  deps: DispatcherDeps,
  ctx: ServiceContext,
  scope: { sourceId: string; bbProjectId: string },
): CronInboxPort {
  return {
    persistAccepted(draft: CronInboxDraft) {
      requireSourceScope(deps.db, scope.sourceId, scope.bbProjectId, "cron");
      const ingested = ingestInboxEvent(deps, ctx, {
        requestId: uuidV5(INGEST_NS, draft.eventId),
        sourceId: scope.sourceId,
        eventId: draft.eventId,
        topic: draft.topic,
        reference: draft.eventId,
        body: {
          data: {
            scheduledAtUtc: draft.scheduledAtUtc,
            timezone: draft.timezone,
            utcOffsetMinutes: draft.utcOffsetMinutes,
            ruleVersionId: draft.ruleVersionId,
          },
        },
        depth: 0,
      });
      if (!ingested.ok) throw new CronPlannerError(ingested.error.code);
      return { inboxId: ingested.value.id, duplicate: ingested.value.duplicate };
    },
  };
}

export function tickCronIntoInbox(
  deps: DispatcherDeps,
  ctx: ServiceContext,
  input: { sourceId: string; bbProjectId: string; rules: readonly CronRule[]; nowUtc: string },
): TickItem[] {
  requireSourceScope(deps.db, input.sourceId, input.bbProjectId, "cron");
  const inbox = createDurableCronInbox(deps, ctx, { sourceId: input.sourceId, bbProjectId: input.bbProjectId });
  return createCronOccurrenceStore(deps.db, inbox).tick(input.rules, input.nowUtc);
}

export function createDurableWebhookInbox(deps: DispatcherDeps, ctx: ServiceContext): WebhookInboxPort {
  return {
    persistAccepted(draft): WebhookInboxPersist {
      const scoped = assertExplicitBbProjectId(draft.projectId);
      if (!scoped.ok) return { ok: false, code: "scope_unbound" };
      const source = readSource(deps.db, draft.sourceId);
      if (!source || source.kind !== "webhook") return { ok: false, code: "scope_unbound" };
      const stored = assertExplicitBbProjectId(source.project_id);
      if (!stored.ok || stored.value !== scoped.value) return { ok: false, code: "scope_unbound" };
      const envelopeDigest = webhookEnvelopeDigest(draft.envelope);
      if (envelopeDigest !== draft.bodyDigest) return { ok: false, code: "persist_unavailable" };
      const ingested = ingestInboxEvent(deps, ctx, {
        requestId: uuidV5(INGEST_NS, `${draft.sourceId}:${draft.eventId}`),
        sourceId: draft.sourceId,
        eventId: draft.eventId,
        topic: draft.topic,
        reference: draft.envelope.subject.externalId,
        body: {
          subject: draft.envelope.subject,
          data: draft.envelope.data,
          occurredAt: draft.envelope.occurredAt,
          schemaVersion: draft.envelope.schemaVersion,
        },
        depth: 0,
      });
      if (!ingested.ok) {
        if (ingested.error.code === "request_conflict") return { ok: false, code: "event_conflict" };
        if (ingested.error.code === "payload_schema_mismatch" || ingested.error.code === "payload_schema_unsupported") {
          return { ok: false, code: ingested.error.code };
        }
        return { ok: false, code: "persist_unavailable" };
      }
      return { ok: true, receiptId: ingested.value.id, duplicate: ingested.value.duplicate, state: "accepted" };
    },
  };
}

export function createCatalogWebhookSourcePort(
  db: SqlDatabase,
  extras: {
    resolveSecret(sourceId: string): Uint8Array | null;
    resolveAllowedTopics(sourceId: string): readonly string[];
  },
): WebhookSourcePort {
  return {
    resolve(sourceId: string): WebhookSource | null {
      const row = readSource(db, sourceId);
      if (!row || row.kind !== "webhook") return null;
      const scoped = assertExplicitBbProjectId(row.project_id);
      return {
        id: row.id,
        projectId: row.project_id,
        enabled: row.enabled === 1,
        projectEnabled: scoped.ok,
        allowedTopics: extras.resolveAllowedTopics(row.id),
        secret: extras.resolveSecret(row.id) ?? new Uint8Array(),
      };
    },
  };
}
