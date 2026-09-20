import { randomUUID } from "node:crypto";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { saveEventDefinition, saveEventSource, saveRuleVersion } from "../src/server/dispatcher/engine";
import { listRuleSchedules, previewSchedule, saveRuleSchedule, tickSchedules } from "../src/server/triggers/schedules";
import { rotateWebhookSecret, saveSourceTopics, sourceTopics, webhookSecretBytes, webhookSecretIssuedAt } from "../src/server/triggers/webhook-secrets";
import { sweepTelegramOutbox } from "../src/server/triggers/telegram-outbox";
import { seed } from "./role-types.test";

const ctx = { actor: { kind: "system" as const }, allowedBindingIds: [] };

describe("rule schedules", () => {
  it("validates, previews in order and explains a bad expression", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    expect(saveRuleSchedule(db, { ruleId: "weekly-report", expression: "0  9 * *  1", timezone: "Europe/Madrid", misfire: "skip" }, "2026-09-17T10:00:00.000Z")).toMatchObject({ ok: true, value: { expression: "0 9 * * 1" } });
    expect(listRuleSchedules(db)).toHaveLength(1);
    const preview = previewSchedule({ expression: "0 9 * * 1", timezone: "Europe/Madrid" }, "2026-09-17T10:00:00.000Z");
    expect(preview.ok && preview.value).toEqual(["2026-09-21T07:00:00.000Z", "2026-09-28T07:00:00.000Z", "2026-10-05T07:00:00.000Z"]);
    const bad = saveRuleSchedule(db, { ruleId: "weekly-report", expression: "every monday", timezone: "Europe/Madrid", misfire: "skip" }, "2026-09-17T10:00:00.000Z");
    expect(bad.ok ? null : bad.error.message).toContain("пять полей cron");
    expect(previewSchedule({ expression: "0 9 * * 1", timezone: "Mars/Olympus" }, "2026-09-17T10:00:00.000Z")).toMatchObject({ ok: false, error: { code: "cron_timezone_not_iana" } });
  });

  it("emits a due occurrence of a scheduled rule into the inbox once", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const deps = { db };
    expect(saveEventDefinition(deps, ctx, { requestId: randomUUID(), topic: "schedule.weekly", schemaVersion: 1, namespace: "agency", label: "Еженедельно", payloadSchema: { type: "object" } }).ok).toBe(true);
    const source = saveEventSource(deps, ctx, { requestId: randomUUID(), projectId: "proj_bound", kind: "cron", enabled: true });
    if (!source.ok) throw new Error(source.error.message);
    expect(saveRuleVersion(deps, ctx, { requestId: randomUUID(), ruleId: "weekly-report", projectId: "proj_bound", sourceId: source.value.id, topic: "schedule.weekly", conditions: [], mode: "observe", action: { kind: "observe" }, maxDepth: 12, maxRetries: 3, enabled: true }).ok).toBe(true);
    saveRuleSchedule(db, { ruleId: "weekly-report", expression: "*/15 * * * *", timezone: "UTC", misfire: "last" }, "2026-09-17T09:00:00.000Z");
    // The first pass only places the cursor: switching a schedule on does not replay the past.
    expect(tickSchedules(deps, ctx, "2026-09-17T10:01:00.000Z")).toEqual({ emitted: 0, errors: [] });
    expect(tickSchedules(deps, ctx, "2026-09-17T10:16:00.000Z")).toEqual({ emitted: 1, errors: [] });
    expect(tickSchedules(deps, ctx, "2026-09-17T10:17:00.000Z").emitted).toBe(0);
    const events = db.prepare(`SELECT topic, event_id FROM agency_inbox_event`).all() as { topic: string; event_id: string }[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ topic: "schedule.weekly", event_id: expect.stringContaining("2026-09-17T10:15:00.000Z") });
  });
});

describe("webhook source secrets", () => {
  it("issues a secret once, keeps it owner-only on disk and replaces it on rotation", () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-webhook-"));
    const path = join(dir, "secrets.json");
    const first = rotateWebhookSecret(path, "src_orders01", "2026-09-17T10:00:00.000Z");
    expect(first.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(webhookSecretBytes(path, "src_orders01")?.byteLength).toBe(64);
    const second = rotateWebhookSecret(path, "src_orders01", "2026-09-18T10:00:00.000Z");
    expect(second.secret).not.toBe(first.secret);
    expect(webhookSecretIssuedAt(path, "src_orders01")).toBe("2026-09-18T10:00:00.000Z");
    expect(webhookSecretBytes(path, "src_unknown")).toBe(null);
  });

  it("stores allowed topics and refuses a malformed one", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    expect(saveSourceTopics(db, "src_orders01", ["order.paid", "order.paid", " order.refunded "], "2026-09-17T10:00:00.000Z")).toMatchObject({ ok: true, value: ["order.paid", "order.refunded"] });
    expect(sourceTopics(db, "src_orders01")).toEqual(["order.paid", "order.refunded"]);
    expect(saveSourceTopics(db, "src_orders01", ["Order Paid"], "2026-09-17T10:00:00.000Z").ok).toBe(false);
  });
});

describe("telegram queue", () => {
  it("sends each owner decision once, only for the chosen project and only when turned on", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const job = s.job("Главная", s.lead);
    db.prepare(`UPDATE agency_job SET state = 'review', updated_at = ? WHERE id = ?`).run("2026-09-17T09:59:00.000Z", job.id);
    const sent: { deliveryId: string; kind: string; title: string }[] = [];
    let pref = { enabled: false, projectId: "proj_bound", notifications: true, questions: true };
    const ports = {
      db,
      preferences: async () => pref,
      enqueue: async (input: { deliveryId: string; kind: string; title: string }) => {
        sent.push(input);
      },
      now: () => new Date("2026-09-17T10:00:00.000Z"),
    };
    expect(await sweepTelegramOutbox(ports)).toBe(0);
    pref = { ...pref, enabled: true };
    // Review is a station of the line: the customer is not pinged about it.
    expect(await sweepTelegramOutbox(ports)).toBe(0);
    db.prepare(`UPDATE agency_job SET state = 'blocked', revision = revision + 1 WHERE id = ?`).run(job.id);
    expect(await sweepTelegramOutbox(ports)).toBe(1);
    expect(await sweepTelegramOutbox(ports)).toBe(0);
    expect(sent[0]).toMatchObject({ kind: "notification", title: expect.stringContaining("ожидает решения") });
    pref = { ...pref, projectId: "proj_other" };
    db.prepare(`UPDATE agency_job SET state = 'waiting_input', revision = revision + 1 WHERE id = ?`).run(job.id);
    expect(await sweepTelegramOutbox(ports)).toBe(0);
  });
});

describe("webhook route end to end", () => {
  it("accepts a signed event from a configured source once and rejects a wrong signature", async () => {
    const { createHmac } = await import("node:crypto");
    const { createCatalogWebhookSourcePort, createDurableWebhookInbox } = await import("../src/server/triggers/durable-inbox");
    const { handleWebhookIngress } = await import("../src/server/triggers/webhook-ingress/ingress");
    const { createWebhookRateLimiter } = await import("../src/server/triggers/webhook-ingress/rate-limit");
    const db = openMigratedDatabase(new Database(":memory:"));
    const deps = { db };
    expect(saveEventDefinition(deps, ctx, { requestId: randomUUID(), topic: "order.paid", schemaVersion: 1, namespace: "integration", label: "Оплата", payloadSchema: { type: "object" } }).ok).toBe(true);
    const source = saveEventSource(deps, ctx, { requestId: randomUUID(), projectId: "proj_bound", kind: "webhook", enabled: true });
    if (!source.ok) throw new Error(source.error.message);
    const path = join(mkdtempSync(join(tmpdir(), "agy-hook-")), "secrets.json");
    const { secret } = rotateWebhookSecret(path, source.value.id, "2026-09-17T10:00:00.000Z");
    saveSourceTopics(db, source.value.id, ["order.paid"], "2026-09-17T10:00:00.000Z");
    const now = Date.parse("2026-09-17T10:00:00.000Z");
    const body = JSON.stringify({ schemaVersion: 1, eventId: "pay-1", topic: "order.paid", occurredAt: "2026-09-17T09:59:00Z", subject: { externalId: "order-1", version: "1" }, data: { amount: 10 } });
    const timestamp = String(Math.floor(now / 1000));
    const sign = (key: string) => `v1=${createHmac("sha256", key).update(`${timestamp}.`).update(body).digest("hex")}`;
    const ingressDeps = {
      sources: createCatalogWebhookSourcePort(db, { resolveSecret: (id: string) => webhookSecretBytes(path, id), resolveAllowedTopics: (id: string) => sourceTopics(db, id) }),
      inbox: createDurableWebhookInbox(deps, ctx),
      rateLimit: createWebhookRateLimiter({ nowMs: () => now }),
    };
    const request = (signature: string) => ({
      headers: new Headers({ "content-type": "application/json", "x-agency-source-id": source.value.id, "x-agency-timestamp": timestamp, "x-agency-signature": signature }),
      body: new TextEncoder().encode(body),
      nowMs: now,
    });
    expect(await handleWebhookIngress(ingressDeps, request(sign(secret)))).toMatchObject({ status: 202, code: "webhook_accepted" });
    expect(await handleWebhookIngress(ingressDeps, request(sign(secret)))).toMatchObject({ status: 200, duplicate: true });
    expect(await handleWebhookIngress(ingressDeps, request(sign("0".repeat(64))))).toMatchObject({ status: 401 });
    expect((db.prepare(`SELECT COUNT(*) AS n FROM agency_inbox_event`).get() as { n: number }).n).toBe(1);
  });
});
