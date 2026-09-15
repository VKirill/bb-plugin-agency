import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WEBHOOK_MAX_BYTES, type WebhookSource } from "../src/server/triggers/webhook-auth";
import {
  createWebhookRateLimiter,
  handleWebhookIngress,
  WEBHOOK_SCHEMA_VALIDATION,
  type WebhookInboxDraft,
  type WebhookInboxPort,
} from "../src/server/triggers/webhook-ingress";

const nowMs = Date.parse("2026-09-14T10:00:00Z");
const source: WebhookSource = {
  id: "source-qa",
  projectId: "project-qa",
  enabled: true,
  projectEnabled: true,
  allowedTopics: ["research.delivered"],
  secret: new Uint8Array(32).fill(42),
};
const envelope = {
  schemaVersion: 1 as const,
  eventId: "delivery-1",
  topic: "research.delivered",
  occurredAt: "2026-09-14T10:00:00Z",
  subject: { externalId: "research-1", version: "1" },
  data: { reference: "artifact:research-1" },
};

function signed(value: unknown = envelope, timestamp = String(nowMs / 1000)) {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const headers = new Headers({
    "content-type": "application/json",
    "x-agency-source-id": source.id,
    "x-agency-timestamp": timestamp,
  });
  headers.set(
    "x-agency-signature",
    "v1=" + createHmac("sha256", source.secret).update(timestamp + ".").update(body).digest("hex"),
  );
  return { headers, body };
}

function memoryInbox(): WebhookInboxPort & { drafts: WebhookInboxDraft[] } {
  const byKey = new Map<string, { receiptId: string; digest: string; draft: WebhookInboxDraft }>();
  const drafts: WebhookInboxDraft[] = [];
  return {
    drafts,
    persistAccepted(draft) {
      const key = `${draft.sourceId}:${draft.eventId}`;
      const existing = byKey.get(key);
      if (existing) {
        if (existing.digest !== draft.bodyDigest) return { ok: false, code: "event_conflict" };
        return { ok: true, receiptId: existing.receiptId, duplicate: true, state: "accepted" };
      }
      const receiptId = `rcpt_${byKey.size + 1}`;
      byKey.set(key, { receiptId, digest: draft.bodyDigest, draft });
      drafts.push(draft);
      return { ok: true, receiptId, duplicate: false, state: "accepted" };
    },
  };
}

describe("webhook ingress adapter", () => {
  it("caps a chunked stream at 64KiB before JSON and does not persist", async () => {
    const inbox = memoryInbox();
    async function* chunks() {
      yield new Uint8Array(WEBHOOK_MAX_BYTES);
      yield new Uint8Array(1);
    }
    const result = await handleWebhookIngress(
      {
        sources: { resolve: () => source },
        inbox,
        rateLimit: createWebhookRateLimiter({ nowMs: () => nowMs }),
      },
      { headers: signed().headers, body: chunks(), nowMs },
    );
    expect(result).toMatchObject({ status: 413, code: "webhook_too_large", schemaValidation: WEBHOOK_SCHEMA_VALIDATION });
    expect(inbox.drafts).toHaveLength(0);
  });

  it("accepts a new signed envelope as 202 and repeats as 200 with the same receipt", async () => {
    const inbox = memoryInbox();
    const first = await handleWebhookIngress(
      {
        sources: { resolve: () => source },
        inbox,
        rateLimit: createWebhookRateLimiter({ nowMs: () => nowMs }),
      },
      { ...signed(), nowMs },
    );
    expect(first).toMatchObject({
      status: 202,
      code: "webhook_accepted",
      state: "accepted",
      duplicate: false,
      schemaValidation: "envelope_only",
    });
    const later = signed(envelope, String(nowMs / 1000 + 10));
    const replay = await handleWebhookIngress(
      {
        sources: { resolve: () => source },
        inbox,
        rateLimit: createWebhookRateLimiter({ nowMs: () => nowMs + 10_000 }),
      },
      { ...later, nowMs: nowMs + 10_000 },
    );
    expect(replay).toMatchObject({ status: 200, code: "webhook_duplicate", receiptId: first.receiptId, duplicate: true });
    expect(inbox.drafts).toHaveLength(1);
    expect(inbox.drafts[0]?.bodyDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("conflicts when the same eventId arrives with a different envelope body", async () => {
    const inbox = memoryInbox();
    const deps = {
      sources: { resolve: () => source },
      inbox,
      rateLimit: createWebhookRateLimiter({ nowMs: () => nowMs }),
    };
    await handleWebhookIngress(deps, { ...signed(), nowMs });
    const changed = { ...envelope, data: { reference: "artifact:other" } };
    const result = await handleWebhookIngress(deps, { ...signed(changed), nowMs });
    expect(result).toMatchObject({ status: 409, code: "webhook_event_conflict" });
    expect(JSON.stringify(result)).not.toContain("artifact:other");
  });

  it("does not apply EventDefinition payload_schema_json and still accepts extra data fields", async () => {
    const inbox = memoryInbox();
    const withModel = { ...envelope, data: { ...envelope.data, model: "not-a-launch-setting", extra: "ok" } };
    const result = await handleWebhookIngress(
      {
        sources: { resolve: () => source },
        inbox,
        rateLimit: createWebhookRateLimiter({ nowMs: () => nowMs }),
      },
      { ...signed(withModel), nowMs },
    );
    expect(result).toMatchObject({ status: 202, schemaValidation: "envelope_only" });
    expect(inbox.drafts[0]?.envelope.data).toEqual(withModel.data);
  });

  it("returns 429 with Retry-After after the burst and 503 when persist is unavailable", async () => {
    let clock = nowMs;
    const inbox = memoryInbox();
    const deps = {
      sources: { resolve: () => source },
      inbox,
      rateLimit: createWebhookRateLimiter({ nowMs: () => clock, burst: 10, refillPerMinute: 60 }),
    };
    for (let i = 0; i < 10; i += 1) {
      const event = { ...envelope, eventId: `delivery-burst-${i}` };
      const accepted = await handleWebhookIngress(deps, { ...signed(event), nowMs: clock });
      expect(accepted.status).toBe(202);
    }
    const limited = await handleWebhookIngress(deps, { ...signed({ ...envelope, eventId: "delivery-burst-x" }), nowMs: clock });
    expect(limited).toMatchObject({ status: 429, code: "webhook_rate_limited" });
    expect(limited.headers["retry-after"]).toMatch(/^[1-9]\d*$/);

    const down: WebhookInboxPort = { persistAccepted: () => ({ ok: false, code: "persist_unavailable" }) };
    const unavailable = await handleWebhookIngress(
      {
        sources: { resolve: () => source },
        inbox: down,
        rateLimit: createWebhookRateLimiter({ nowMs: () => nowMs }),
      },
      { ...signed(), nowMs },
    );
    expect(unavailable).toMatchObject({ status: 503, code: "webhook_persist_unavailable", schemaValidation: "envelope_only" });

    const schemaFail: WebhookInboxPort = { persistAccepted: () => ({ ok: false, code: "payload_schema_mismatch" }) };
    const schemaDenied = await handleWebhookIngress(
      {
        sources: { resolve: () => source },
        inbox: schemaFail,
        rateLimit: createWebhookRateLimiter({ nowMs: () => nowMs }),
      },
      { ...signed({ ...envelope, eventId: "delivery-schema" }), nowMs },
    );
    expect(schemaDenied).toMatchObject({ status: 400, code: "webhook_payload_schema" });

    const unbound: WebhookInboxPort = { persistAccepted: () => ({ ok: false, code: "scope_unbound" }) };
    const scopeDenied = await handleWebhookIngress(
      {
        sources: { resolve: () => source },
        inbox: unbound,
        rateLimit: createWebhookRateLimiter({ nowMs: () => nowMs }),
      },
      { ...signed({ ...envelope, eventId: "delivery-scope" }), nowMs },
    );
    expect(scopeDenied).toMatchObject({ status: 403, code: "webhook_scope_unbound" });
  });

  it("rejects encoding before persist and does not register an HTTP route", async () => {
    const inbox = memoryInbox();
    const encoded = signed();
    encoded.headers.set("content-encoding", "gzip");
    const result = await handleWebhookIngress(
      {
        sources: { resolve: () => source },
        inbox,
        rateLimit: createWebhookRateLimiter({ nowMs: () => nowMs }),
      },
      { ...encoded, nowMs },
    );
    expect(result.status).toBe(415);
    expect(inbox.drafts).toHaveLength(0);
    expect(await import("../src/server/triggers/webhook-ingress")).not.toHaveProperty("register");
  });

  it("rate-limits unknown ids on one bucket before reading the body", async () => {
    const rateLimit = createWebhookRateLimiter({ nowMs: () => nowMs, burst: 2, knownBucketCap: 4 });
    let pulls = 0;
    const unread = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            pulls += 1;
            return { done: false, value: signed().body };
          },
        };
      },
    };
    const inbox = memoryInbox();
    const deps = {
      sources: { resolve: () => null },
      inbox,
      rateLimit,
    };
    for (let i = 0; i < 2; i += 1) {
      const headers = new Headers(signed().headers);
      headers.set("x-agency-source-id", `unknown-${i}-${"x".repeat(20)}`);
      await handleWebhookIngress(deps, { headers, body: signed().body, nowMs });
    }
    expect(rateLimit.knownBucketCount()).toBe(0);
    const thirdHeaders = new Headers(signed().headers);
    thirdHeaders.set("x-agency-source-id", `unknown-flood-${"y".repeat(20)}`);
    const limited = await handleWebhookIngress(deps, { headers: thirdHeaders, body: unread, nowMs });
    expect(limited).toMatchObject({ status: 429, code: "webhook_rate_limited" });
    expect(pulls).toBe(0);
    expect(inbox.drafts).toHaveLength(0);
  });

  it("cancels an oversized ReadableStream and returns an async iterator", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(WEBHOOK_MAX_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const inbox = memoryInbox();
    const oversized = await handleWebhookIngress(
      {
        sources: { resolve: () => source },
        inbox,
        rateLimit: createWebhookRateLimiter({ nowMs: () => nowMs }),
      },
      { headers: signed().headers, body: stream, nowMs },
    );
    expect(oversized.status).toBe(413);
    expect(cancelled).toBe(true);

    let returned = false;
    const iterable = {
      [Symbol.asyncIterator]() {
        let step = 0;
        return {
          async next() {
            step += 1;
            if (step === 1) return { done: false, value: new Uint8Array(WEBHOOK_MAX_BYTES) };
            return { done: false, value: new Uint8Array(1) };
          },
          async return() {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const fromIter = await handleWebhookIngress(
      {
        sources: { resolve: () => source },
        inbox,
        rateLimit: createWebhookRateLimiter({ nowMs: () => nowMs }),
      },
      { headers: signed().headers, body: iterable as AsyncIterable<Uint8Array>, nowMs },
    );
    expect(fromIter.status).toBe(413);
    expect(returned).toBe(true);
  });

  it("maps throwing resolve, persist and a broken stream to redacted 503", async () => {
    const sentinel = "leak-secret-body-token";
    const inbox = memoryInbox();
    const resolveThrow = await handleWebhookIngress(
      {
        sources: {
          resolve() {
            throw new Error(sentinel);
          },
        },
        inbox,
        rateLimit: createWebhookRateLimiter({ nowMs: () => nowMs }),
      },
      { ...signed(), nowMs },
    );
    expect(resolveThrow).toMatchObject({ status: 503, code: "webhook_unavailable" });
    expect(JSON.stringify(resolveThrow)).not.toContain(sentinel);

    const persistThrow = await handleWebhookIngress(
      {
        sources: { resolve: () => source },
        inbox: {
          persistAccepted() {
            throw new Error(sentinel);
          },
        },
        rateLimit: createWebhookRateLimiter({ nowMs: () => nowMs }),
      },
      { ...signed(), nowMs },
    );
    expect(persistThrow).toMatchObject({ status: 503, code: "webhook_unavailable" });
    expect(JSON.stringify(persistThrow)).not.toContain(sentinel);

    async function* broken() {
      throw new Error(sentinel);
    }
    const streamThrow = await handleWebhookIngress(
      {
        sources: { resolve: () => source },
        inbox,
        rateLimit: createWebhookRateLimiter({ nowMs: () => nowMs }),
      },
      { headers: signed().headers, body: broken(), nowMs },
    );
    expect(streamThrow).toMatchObject({ status: 503, code: "webhook_unavailable" });
    expect(JSON.stringify(streamThrow)).not.toContain(sentinel);
    expect(inbox.drafts).toHaveLength(0);
  });
});
