import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const WEBHOOK_MAX_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 300;
const envelopeSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1).max(160),
  topic: z.string().regex(/^[a-z][a-z0-9_.-]{0,95}$/),
  occurredAt: z.iso.datetime({ offset: true }),
  subject: z.object({ externalId: z.string().min(1).max(160), version: z.string().min(1).max(80) }).strict(),
  data: z.record(z.string(), z.unknown()),
}).strict();

/** Resolved by the server, never constructed from the request body. */
export type WebhookSource = {
  id: string;
  projectId: string;
  enabled: boolean;
  projectEnabled: boolean;
  allowedTopics: readonly string[];
  secret: Uint8Array;
};

export type VerifiedWebhook = {
  sourceId: string;
  projectId: string;
  namespace: "integration";
  envelope: z.infer<typeof envelopeSchema>;
};

type WebhookResult = { ok: true; value: VerifiedWebhook } | {
  ok: false;
  status: 400 | 401 | 403 | 413 | 415 | 503;
  code: string;
};

/** Does not persist, fetch references, dispatch, or claim a delivery receipt.
 * The HTTP adapter must also cap the stream before allocating rawBody. */
export function verifyWebhook(input: {
  headers: Headers;
  rawBody: Uint8Array;
  source: WebhookSource | null;
  nowMs: number;
}): WebhookResult {
  const reject = (status: Exclude<WebhookResult, { ok: true }>['status'], code: string): WebhookResult => ({ ok: false, status, code });
  if (input.rawBody.byteLength > WEBHOOK_MAX_BYTES) return reject(413, "webhook_too_large");
  const contentType = input.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) return reject(415, "webhook_content_type");
  if (input.headers.has("content-encoding")) return reject(415, "webhook_content_encoding");
  const source = input.source;
  if (!source || input.headers.get("x-agency-source-id") !== source.id) return reject(401, "webhook_unauthorized");
  if (!source.enabled || !source.projectEnabled) return reject(403, "webhook_source_disabled");
  if (source.secret.byteLength < 32 || !Number.isFinite(input.nowMs)) return reject(503, "webhook_configuration_unavailable");
  const timestamp = input.headers.get("x-agency-timestamp") ?? "";
  const signature = input.headers.get("x-agency-signature") ?? "";
  if (!/^\d{10}$/.test(timestamp) || !/^v1=[a-fA-F0-9]{64}$/.test(signature)) return reject(401, "webhook_unauthorized");
  if (Math.abs(input.nowMs / 1000 - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) return reject(401, "webhook_timestamp_expired");
  const expected = createHmac("sha256", source.secret).update(timestamp + ".").update(input.rawBody).digest();
  const actual = Buffer.from(signature.slice(3), "hex");
  if (!timingSafeEqual(expected, actual)) return reject(401, "webhook_unauthorized");

  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.rawBody)); }
  catch { return reject(400, "webhook_invalid_json"); }
  // Bound nesting before schema traversal. Data remains data, never launch settings.
  const queue: Array<{ value: unknown; depth: number }> = [{ value: parsed, depth: 0 }];
  while (queue.length) {
    const { value, depth } = queue.pop()!;
    if (depth > 16) return reject(400, "webhook_nesting_limit");
    if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) queue.push({ value: child, depth: depth + 1 });
    }
  }
  const envelope = envelopeSchema.safeParse(parsed);
  if (!envelope.success) return reject(400, "webhook_invalid_envelope");
  if (!source.allowedTopics.includes(envelope.data.topic)) return reject(403, "webhook_topic_forbidden");
  return { ok: true, value: { sourceId: source.id, projectId: source.projectId, namespace: "integration", envelope: envelope.data } };
}
