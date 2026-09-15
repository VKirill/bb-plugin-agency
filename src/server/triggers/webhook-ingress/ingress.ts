import { canonicalizeJson, sha256Hex } from "../../runtime/context-snapshot/canonical.js";
import { verifyWebhook, type WebhookSource } from "../webhook-auth.js";
import type { WebhookInboxPort, WebhookSourcePort } from "./ports.js";
import type { WebhookRateLimiter } from "./rate-limit.js";
import { readBoundedWebhookBody, type WebhookBodySource } from "./read-body.js";

export const WEBHOOK_SCHEMA_VALIDATION = "envelope_only" as const;
export const WEBHOOK_SOURCE_ID_MAX = 80;
const SOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

export type WebhookIngressRequest = {
  headers: Headers;
  body: WebhookBodySource;
  nowMs: number;
};

export type WebhookIngressResponse = {
  status: 200 | 202 | 400 | 401 | 403 | 409 | 413 | 415 | 429 | 503;
  code: string;
  headers: Record<string, string>;
  schemaValidation: typeof WEBHOOK_SCHEMA_VALIDATION;
  receiptId?: string;
  state?: "accepted";
  duplicate?: boolean;
};

export type WebhookIngressDeps = {
  sources: WebhookSourcePort;
  inbox: WebhookInboxPort;
  rateLimit: WebhookRateLimiter;
};

function fail(
  status: WebhookIngressResponse["status"],
  code: string,
  headers: Record<string, string> = {},
): WebhookIngressResponse {
  return { status, code, headers, schemaValidation: WEBHOOK_SCHEMA_VALIDATION };
}

function parseSourceId(headers: Headers): string | null {
  const raw = headers.get("x-agency-source-id") ?? "";
  if (!raw || raw.length > WEBHOOK_SOURCE_ID_MAX || !SOURCE_ID.test(raw)) return null;
  return raw;
}

export function webhookEnvelopeDigest(envelope: {
  schemaVersion: 1;
  eventId: string;
  topic: string;
  occurredAt: string;
  subject: unknown;
  data: unknown;
}): string {
  return sha256Hex(canonicalizeJson({
    schemaVersion: envelope.schemaVersion,
    eventId: envelope.eventId,
    topic: envelope.topic,
    occurredAt: envelope.occurredAt,
    subject: envelope.subject,
    data: envelope.data,
  }));
}

export async function handleWebhookIngress(
  deps: WebhookIngressDeps,
  request: WebhookIngressRequest,
): Promise<WebhookIngressResponse> {
  try {
    if (request.headers.has("content-encoding")) return fail(415, "webhook_content_encoding");
    const headerSourceId = parseSourceId(request.headers);
    let source: WebhookSource | null = null;
    if (headerSourceId) {
      try {
        source = deps.sources.resolve(headerSourceId);
      } catch {
        return fail(503, "webhook_unavailable");
      }
    }
    const limited = source ? deps.rateLimit.takeKnown(source.id) : deps.rateLimit.takeUnknown();
    if (!limited.ok) {
      return fail(429, "webhook_rate_limited", { "retry-after": String(limited.retryAfterSeconds) });
    }
    let bounded;
    try {
      bounded = await readBoundedWebhookBody(request.body);
    } catch {
      return fail(503, "webhook_unavailable");
    }
    if (!bounded.ok) return fail(bounded.status, bounded.code);
    const verified = verifyWebhook({
      headers: request.headers,
      rawBody: bounded.rawBody,
      source,
      nowMs: request.nowMs,
    });
    if (!verified.ok) return fail(verified.status, verified.code);
    const { envelope, projectId, namespace } = verified.value;
    let persisted;
    try {
      persisted = deps.inbox.persistAccepted({
        sourceId: verified.value.sourceId,
        projectId,
        eventId: envelope.eventId,
        topic: envelope.topic,
        bodyDigest: webhookEnvelopeDigest(envelope),
        namespace,
        envelope,
      });
    } catch {
      return fail(503, "webhook_unavailable");
    }
    if (!persisted.ok) {
      if (persisted.code === "payload_schema_mismatch" || persisted.code === "payload_schema_unsupported") {
        return fail(400, "webhook_payload_schema");
      }
      if (persisted.code === "scope_unbound") return fail(403, "webhook_scope_unbound");
      return fail(persisted.code === "event_conflict" ? 409 : 503, persisted.code === "event_conflict" ? "webhook_event_conflict" : "webhook_persist_unavailable");
    }
    return {
      status: persisted.duplicate ? 200 : 202,
      code: persisted.duplicate ? "webhook_duplicate" : "webhook_accepted",
      headers: {},
      schemaValidation: WEBHOOK_SCHEMA_VALIDATION,
      receiptId: persisted.receiptId,
      state: "accepted",
      duplicate: persisted.duplicate,
    };
  } catch {
    return fail(503, "webhook_unavailable");
  }
}
