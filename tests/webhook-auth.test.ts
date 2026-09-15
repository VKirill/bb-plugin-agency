import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhook, WEBHOOK_MAX_BYTES, type WebhookSource } from "../src/server/triggers/webhook-auth";

const nowMs = Date.parse("2026-09-14T10:00:00Z");
const source: WebhookSource = { id: "source-qa", projectId: "project-qa", enabled: true, projectEnabled: true, allowedTopics: ["research.delivered"], secret: new Uint8Array(32).fill(42) };
const body = { schemaVersion: 1, eventId: "delivery-1", topic: "research.delivered", occurredAt: "2026-09-14T10:00:00Z", subject: { externalId: "research-1", version: "1" }, data: { reference: "artifact:research-1" } };
function signed(value: unknown = body, timestamp = String(nowMs / 1000)) {
  const rawBody = new TextEncoder().encode(JSON.stringify(value));
  const headers = new Headers({ "content-type": "application/json", "x-agency-source-id": source.id, "x-agency-timestamp": timestamp });
  headers.set("x-agency-signature", "v1=" + createHmac("sha256", source.secret).update(timestamp + ".").update(rawBody).digest("hex"));
  return { headers, rawBody, source, nowMs };
}

describe("webhook raw-byte authorization", () => {
  it("derives scope only from server source and permits independently signed redelivery", () => {
    const first = verifyWebhook(signed());
    const later = verifyWebhook(signed(body, String(nowMs / 1000 + 10)));
    expect(first).toEqual(later);
    expect(first).toMatchObject({ ok: true, value: { projectId: "project-qa", namespace: "integration" } });
  });

  it("rejects changed bytes, wrong key and duplicate signature header", () => {
    const changed = signed();
    changed.rawBody = new TextEncoder().encode(JSON.stringify(body, null, 2));
    expect(verifyWebhook(changed)).toMatchObject({ status: 401 });
    expect(verifyWebhook({ ...signed(), source: { ...source, secret: new Uint8Array(32).fill(43) } })).toMatchObject({ status: 401 });
    const duplicate = signed();
    duplicate.headers.append("x-agency-signature", duplicate.headers.get("x-agency-signature")!);
    expect(verifyWebhook(duplicate)).toMatchObject({ status: 401 });
  });

  it("rejects stale/future timestamps, source substitution, paused source/project and forbidden topic", () => {
    for (const delta of [-301, 301]) expect(verifyWebhook(signed(body, String(nowMs / 1000 + delta)))).toMatchObject({ code: "webhook_timestamp_expired" });
    expect(verifyWebhook({ ...signed(), source: { ...source, id: "foreign" } })).toMatchObject({ status: 401 });
    for (const patch of [{ enabled: false }, { projectEnabled: false }]) expect(verifyWebhook({ ...signed(), source: { ...source, ...patch } })).toMatchObject({ status: 403 });
    expect(verifyWebhook(signed({ ...body, topic: "review.accepted" }))).toMatchObject({ code: "webhook_topic_forbidden" });
  });

  it("rejects oversize and encoded bodies before authentication or parsing", () => {
    expect(verifyWebhook({ ...signed(), rawBody: new Uint8Array(WEBHOOK_MAX_BYTES + 1) })).toMatchObject({ status: 413 });
    const compressed = signed(); compressed.headers.set("content-encoding", "gzip");
    expect(verifyWebhook(compressed)).toMatchObject({ status: 415 });
  });

  it("rejects invalid UTF-8, deep data and execution/scope fields without echoing input", () => {
    let data: unknown = "sentinel-private-body";
    for (let i = 0; i < 18; i++) data = { nested: data };
    expect(verifyWebhook(signed({ ...body, data }))).toMatchObject({ code: "webhook_nesting_limit" });
    const result = verifyWebhook(signed({ ...body, projectId: "sentinel-private-body", model: "injected-model" }));
    expect(result).toMatchObject({ code: "webhook_invalid_envelope" });
    expect(JSON.stringify(result)).not.toContain("sentinel-private-body");
    const invalid = signed(); invalid.rawBody = new Uint8Array([0xff]);
    invalid.headers.set("x-agency-signature", "v1=" + createHmac("sha256", source.secret).update(String(nowMs / 1000) + ".").update(invalid.rawBody).digest("hex"));
    expect(verifyWebhook(invalid)).toMatchObject({ code: "webhook_invalid_json" });
  });
});
