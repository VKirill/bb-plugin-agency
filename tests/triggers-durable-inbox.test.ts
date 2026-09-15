import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { ingestInboxEvent, saveEventDefinition, saveEventSource } from "../src/server/dispatcher/engine";
import { CronPlannerError, cronEventId, type CronRule } from "../src/server/triggers/cron";
import {
  CRON_OCCURRENCE_PAYLOAD_SCHEMA,
  createCatalogWebhookSourcePort,
  createDurableWebhookInbox,
  tickCronIntoInbox,
} from "../src/server/triggers/durable-inbox";
import { createWebhookRateLimiter, handleWebhookIngress } from "../src/server/triggers/webhook-ingress";
import type { ServiceContext } from "../src/server/services";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const ctx: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [] };
const bbProjectId = "proj_7e4gc9rb6t";
const secret = new Uint8Array(32).fill(7);
const nowMs = Date.parse("2026-09-14T11:00:00Z");

function openDb() {
  const dir = mkdtempSync(join(tmpdir(), "agy-trig-"));
  tempDirs.push(dir);
  return openMigratedDatabase(new Database(join(dir, "agency.sqlite")));
}

function requestId() {
  return randomUUID();
}

describe("trigger durable inbox + payload schema", () => {
  it("rejects unsupported schema keys on save and mismatch on ingest", () => {
    const db = openDb();
    const deps = { db };
    const rejected = saveEventDefinition(deps, ctx, {
      requestId: requestId(),
      topic: "research.delivered",
      schemaVersion: 1,
      namespace: "agency",
      label: "Поставка",
      payloadSchema: { $ref: "#/defs/x" },
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("payload_schema_unsupported");

    const saved = saveEventDefinition(deps, ctx, {
      requestId: requestId(),
      topic: "research.delivered",
      schemaVersion: 1,
      namespace: "agency",
      label: "Поставка",
      payloadSchema: {
        type: "object",
        required: ["data"],
        properties: { data: { type: "object", required: ["status"], additionalProperties: true } },
      },
    });
    expect(saved.ok).toBe(true);
    const source = saveEventSource(deps, ctx, {
      requestId: requestId(),
      projectId: bbProjectId,
      kind: "notify",
      enabled: true,
    });
    expect(source.ok).toBe(true);
    if (!source.ok) throw new Error(source.error.message);
    const miss = ingestInboxEvent(deps, ctx, {
      requestId: requestId(),
      sourceId: source.value.id,
      eventId: "evt-miss",
      topic: "research.delivered",
      reference: "ref-1",
      body: { data: {} },
      depth: 0,
    });
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error.code).toBe("payload_schema_mismatch");
  });

  it("emits a cron occurrence into typed inbox with explicit bbProjectId", () => {
    const db = openDb();
    const deps = { db };
    expect(
      saveEventDefinition(deps, ctx, {
        requestId: requestId(),
        topic: "cron.occurred",
        schemaVersion: 1,
        namespace: "agency",
        label: "Слот cron",
        payloadSchema: CRON_OCCURRENCE_PAYLOAD_SCHEMA,
      }).ok,
    ).toBe(true);
    const source = saveEventSource(deps, ctx, {
      requestId: requestId(),
      projectId: bbProjectId,
      kind: "cron",
      enabled: true,
    });
    expect(source.ok).toBe(true);
    if (!source.ok) throw new Error(source.error.message);
    const rule: CronRule = {
      ruleVersionId: "rv_hourly01",
      expression: "0 * * * *",
      timezone: "UTC",
      topic: "cron.occurred",
      misfire: "skip",
    };
    expect(tickCronIntoInbox(deps, ctx, {
      sourceId: source.value.id,
      bbProjectId,
      rules: [rule],
      nowUtc: "2026-09-14T10:00:00.000Z",
    })).toEqual([]);
    const emitted = tickCronIntoInbox(deps, ctx, {
      sourceId: source.value.id,
      bbProjectId,
      rules: [rule],
      nowUtc: "2026-09-14T11:00:00.000Z",
    });
    expect(emitted).toMatchObject([
      { scheduledAtUtc: "2026-09-14T11:00:00.000Z", state: "emitted", duplicate: false },
    ]);
    const row = db
      .prepare(`SELECT project_id, event_id, topic FROM agency_inbox_event WHERE event_id = ?`)
      .get(cronEventId(rule.ruleVersionId, "2026-09-14T11:00:00.000Z")) as
      | { project_id: string; event_id: string; topic: string }
      | undefined;
    expect(row).toEqual({
      project_id: bbProjectId,
      event_id: cronEventId(rule.ruleVersionId, "2026-09-14T11:00:00.000Z"),
      topic: "cron.occurred",
    });
  });

  it("fail-closes cron when caller or stored scope is a binding id", () => {
    const db = openDb();
    const deps = { db };
    expect(
      saveEventDefinition(deps, ctx, {
        requestId: requestId(),
        topic: "cron.occurred",
        schemaVersion: 1,
        namespace: "agency",
        label: "Слот cron",
        payloadSchema: CRON_OCCURRENCE_PAYLOAD_SCHEMA,
      }).ok,
    ).toBe(true);
    const legacy = saveEventSource(deps, ctx, {
      requestId: requestId(),
      projectId: "bnd_currentlegacy01",
      kind: "cron",
      enabled: true,
    });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) throw new Error(legacy.error.message);
    expect(() =>
      tickCronIntoInbox(deps, ctx, {
        sourceId: legacy.value.id,
        bbProjectId: "bnd_currentlegacy01",
        rules: [],
        nowUtc: "2026-09-14T11:00:00.000Z",
      }),
    ).toThrow(CronPlannerError);
    const fresh = saveEventSource(deps, ctx, {
      requestId: requestId(),
      projectId: bbProjectId,
      kind: "cron",
      enabled: true,
    });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) throw new Error(fresh.error.message);
    expect(() =>
      tickCronIntoInbox(deps, ctx, {
        sourceId: fresh.value.id,
        bbProjectId: "bnd_currentlegacy01",
        rules: [],
        nowUtc: "2026-09-14T11:00:00.000Z",
      }),
    ).toThrow(CronPlannerError);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM agency_inbox_event`).get() as { n: number }).toEqual({ n: 0 });
  });

  it("accepts a signed webhook into inbox and rejects schema / legacy binding scope", async () => {
    const db = openDb();
    const deps = { db };
    const topic = "research.delivered";
    expect(
      saveEventDefinition(deps, ctx, {
        requestId: requestId(),
        topic,
        schemaVersion: 1,
        namespace: "integration",
        label: "Поставка",
        payloadSchema: {
          type: "object",
          required: ["subject", "data"],
          properties: {
            subject: { type: "object" },
            data: { type: "object", required: ["status"], additionalProperties: true },
          },
        },
      }).ok,
    ).toBe(true);
    const source = saveEventSource(deps, ctx, {
      requestId: requestId(),
      projectId: bbProjectId,
      kind: "webhook",
      enabled: true,
    });
    expect(source.ok).toBe(true);
    if (!source.ok) throw new Error(source.error.message);
    const sources = createCatalogWebhookSourcePort(db, {
      resolveSecret: (id) => (id === source.value.id ? secret : null),
      resolveAllowedTopics: () => [topic],
    });
    const inbox = createDurableWebhookInbox(deps, ctx);
    const envelope = {
      schemaVersion: 1 as const,
      eventId: "delivery-1",
      topic,
      occurredAt: "2026-09-14T10:00:00Z",
      subject: { externalId: "research-1", version: "1" },
      data: { status: "ready" },
    };
    const body = new TextEncoder().encode(JSON.stringify(envelope));
    const timestamp = String(nowMs / 1000);
    const headers = new Headers({
      "content-type": "application/json",
      "x-agency-source-id": source.value.id,
      "x-agency-timestamp": timestamp,
      "x-agency-signature": "v1=" + createHmac("sha256", secret).update(timestamp + ".").update(body).digest("hex"),
    });
    const accepted = await handleWebhookIngress(
      { sources, inbox, rateLimit: createWebhookRateLimiter({ nowMs: () => nowMs }) },
      { headers, body, nowMs },
    );
    expect(accepted).toMatchObject({ status: 202, code: "webhook_accepted", duplicate: false });
    const stored = db.prepare(`SELECT project_id, topic FROM agency_inbox_event WHERE event_id = 'delivery-1'`).get() as
      | { project_id: string; topic: string }
      | undefined;
    expect(stored).toEqual({ project_id: bbProjectId, topic });

    const bad = { ...envelope, eventId: "delivery-2", data: { reference: "no-status" } };
    const badBody = new TextEncoder().encode(JSON.stringify(bad));
    const badHeaders = new Headers({
      "content-type": "application/json",
      "x-agency-source-id": source.value.id,
      "x-agency-timestamp": timestamp,
      "x-agency-signature": "v1=" + createHmac("sha256", secret).update(timestamp + ".").update(badBody).digest("hex"),
    });
    const denied = await handleWebhookIngress(
      { sources, inbox, rateLimit: createWebhookRateLimiter({ nowMs: () => nowMs }) },
      { headers: badHeaders, body: badBody, nowMs },
    );
    expect(denied).toMatchObject({ status: 400, code: "webhook_payload_schema" });

    const legacy = saveEventSource(deps, ctx, {
      requestId: requestId(),
      projectId: "bnd_currentlegacy01",
      kind: "webhook",
      enabled: true,
    });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) throw new Error(legacy.error.message);
    const legacySources = createCatalogWebhookSourcePort(db, {
      resolveSecret: (id) => (id === legacy.value.id ? secret : null),
      resolveAllowedTopics: () => [topic],
    });
    const legacyBody = new TextEncoder().encode(JSON.stringify({ ...envelope, eventId: "delivery-legacy" }));
    const legacyHeaders = new Headers({
      "content-type": "application/json",
      "x-agency-source-id": legacy.value.id,
      "x-agency-timestamp": timestamp,
      "x-agency-signature": "v1=" + createHmac("sha256", secret).update(timestamp + ".").update(legacyBody).digest("hex"),
    });
    const unbound = await handleWebhookIngress(
      { sources: legacySources, inbox, rateLimit: createWebhookRateLimiter({ nowMs: () => nowMs }) },
      { headers: legacyHeaders, body: legacyBody, nowMs },
    );
    expect(unbound).toMatchObject({ status: 403, code: "webhook_source_disabled" });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM agency_inbox_event`).get() as { n: number }).toEqual({ n: 1 });
  });

  it("keeps one SQLite inbox row on signed replay and conflicts a changed envelope", async () => {
    const db = openDb();
    const deps = { db };
    const topic = "research.delivered";
    expect(
      saveEventDefinition(deps, ctx, {
        requestId: requestId(),
        topic,
        schemaVersion: 1,
        namespace: "integration",
        label: "Поставка",
        payloadSchema: {
          type: "object",
          required: ["subject", "data"],
          properties: {
            subject: { type: "object" },
            data: { type: "object", required: ["status"], additionalProperties: true },
          },
        },
      }).ok,
    ).toBe(true);
    const source = saveEventSource(deps, ctx, {
      requestId: requestId(),
      projectId: bbProjectId,
      kind: "webhook",
      enabled: true,
    });
    expect(source.ok).toBe(true);
    if (!source.ok) throw new Error(source.error.message);
    const sources = createCatalogWebhookSourcePort(db, {
      resolveSecret: (id) => (id === source.value.id ? secret : null),
      resolveAllowedTopics: () => [topic, "research.other"],
    });
    const inbox = createDurableWebhookInbox(deps, ctx);
    const envelope = {
      schemaVersion: 1 as const,
      eventId: "delivery-1",
      topic,
      occurredAt: "2026-09-14T10:00:00Z",
      subject: { externalId: "research-1", version: "1" },
      data: { status: "ready" },
    };
    const post = async (value: typeof envelope | Record<string, unknown>, at = nowMs) => {
      const raw = new TextEncoder().encode(JSON.stringify(value));
      const timestamp = String(Math.floor(at / 1000));
      const headers = new Headers({
        "content-type": "application/json",
        "x-agency-source-id": source.value.id,
        "x-agency-timestamp": timestamp,
        "x-agency-signature": "v1=" + createHmac("sha256", secret).update(timestamp + ".").update(raw).digest("hex"),
      });
      return handleWebhookIngress(
        { sources, inbox, rateLimit: createWebhookRateLimiter({ nowMs: () => at }) },
        { headers, body: raw, nowMs: at },
      );
    };
    const first = await post(envelope);
    expect(first).toMatchObject({ status: 202, code: "webhook_accepted", duplicate: false });
    const before = db
      .prepare(`SELECT id, body_digest, reference FROM agency_inbox_event WHERE event_id = 'delivery-1'`)
      .get() as { id: string; body_digest: string; reference: string };
    expect(before.reference).toBe("research-1");
    const replay = await post(envelope, nowMs + 10_000);
    expect(replay).toMatchObject({
      status: 200,
      code: "webhook_duplicate",
      duplicate: true,
      receiptId: first.receiptId,
    });
    const conflicts = [
      { ...envelope, occurredAt: "2026-09-14T10:01:00Z" },
      { ...envelope, subject: { externalId: "research-2", version: "1" } },
      { ...envelope, data: { status: "ready", extra: "changed" } },
      { ...envelope, topic: "research.other" },
    ];
    for (const changed of conflicts) {
      const denied = await post(changed, nowMs + 20_000);
      expect(denied).toMatchObject({ status: 409, code: "webhook_event_conflict" });
      expect(denied.receiptId).toBeUndefined();
    }
    const ignored = inbox.persistAccepted({
      sourceId: source.value.id,
      projectId: bbProjectId,
      eventId: "delivery-1",
      topic,
      bodyDigest: "0".repeat(64),
      namespace: "integration",
      envelope,
    });
    expect(ignored).toEqual({ ok: false, code: "persist_unavailable" });
    const rows = db.prepare(`SELECT id, body_digest FROM agency_inbox_event`).all() as Array<{
      id: string;
      body_digest: string;
    }>;
    expect(rows).toEqual([{ id: before.id, body_digest: before.body_digest }]);
    expect(await import("../src/server/triggers/webhook-ingress")).not.toHaveProperty("register");
  });
});
