import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import {
  dispatchTick,
  ingestInboxEvent,
  listActionIntents,
  saveEventDefinition,
  saveEventSource,
  saveRuleVersion,
} from "../src/server/dispatcher/engine";
import type { EventCondition } from "../src/shared/contracts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function openDb() {
  const dir = mkdtempSync(join(tmpdir(), "agy-dispatch-fields-"));
  tempDirs.push(dir);
  return openMigratedDatabase(new Database(join(dir, "agency.sqlite")));
}

const ctx = { actor: { kind: "system" as const }, allowedBindingIds: [] };

function requestId() {
  return randomUUID();
}

async function seed(
  conditions: EventCondition[],
  patch: { ruleId?: string; eventId?: string; body?: Record<string, unknown> } = {},
) {
  const db = openDb();
  const deps = { db };
  const definition = saveEventDefinition(deps, ctx, {
    requestId: requestId(),
    topic: "research.delivered",
    schemaVersion: 1,
    namespace: "agency",
    label: "Поля события",
    payloadSchema: { type: "object" },
  });
  expect(definition.ok).toBe(true);
  const source = saveEventSource(deps, ctx, {
    requestId: requestId(),
    projectId: "proj_trusted",
    kind: "notify",
    enabled: true,
  });
  expect(source.ok).toBe(true);
  if (!source.ok) throw new Error(source.error.message);
  const rule = saveRuleVersion(deps, ctx, {
    requestId: requestId(),
    ruleId: patch.ruleId ?? "rule_fields01",
    projectId: "proj_trusted",
    sourceId: source.value.id,
    topic: "research.delivered",
    conditions,
    mode: "observe",
    action: { kind: "observe" },
    maxDepth: 12,
    maxRetries: 3,
    enabled: true,
  });
  expect(rule.ok).toBe(true);
  const ingested = ingestInboxEvent(deps, ctx, {
    requestId: requestId(),
    sourceId: source.value.id,
    eventId: patch.eventId ?? "fields-1",
    topic: "research.delivered",
    reference: "artifact:fields",
    body: patch.body ?? { data: {} },
    depth: 0,
  });
  expect(ingested.ok).toBe(true);
  const tick = dispatchTick(deps, ctx, { requestId: requestId(), live: false });
  const match = db.prepare(`SELECT matched, explanation FROM agency_rule_match`).get() as {
    matched: number;
    explanation: string;
  };
  const intents = listActionIntents(deps, {});
  return { tick, match, intents };
}

describe("dispatcher readField own properties", () => {
  it("does not treat inherited constructor/toString as exists on empty data/subject", async () => {
    const data = await seed(
      [
        { field: "data.constructor", op: "exists" },
        { field: "data.toString", op: "exists" },
      ],
      { eventId: "inherited-data", body: { data: {} } },
    );
    expect(data.match.matched).toBe(0);
    expect(data.match.explanation).toContain("data.constructor exists no");
    expect(data.match.explanation).toContain("data.toString exists no");
    expect(data.tick.ok && data.tick.value.intents).toBe(0);
    expect(data.intents.ok && data.intents.value).toEqual([]);

    const subject = await seed(
      [{ field: "subject.constructor", op: "exists" }],
      { ruleId: "rule_fields02", eventId: "inherited-subject", body: { subject: {} } },
    );
    expect(subject.match.matched).toBe(0);
    expect(subject.match.explanation).toContain("subject.constructor exists no");
    expect(subject.tick.ok && subject.tick.value.intents).toBe(0);
  });

  it("does not treat arrays as condition objects", async () => {
    const data = await seed([{ field: "data.status", op: "exists" }], {
      eventId: "array-data",
      body: { data: ["ready"] },
    });
    expect(data.match.matched).toBe(0);
    expect(data.match.explanation).toContain("data.status exists no");
    expect(data.tick.ok && data.tick.value.intents).toBe(0);

    const subject = await seed([{ field: "subject.externalId", op: "exists" }], {
      ruleId: "rule_fields03",
      eventId: "array-subject",
      body: { subject: ["research-1"] },
    });
    expect(subject.match.matched).toBe(0);
    expect(subject.match.explanation).toContain("subject.externalId exists no");
  });

  it("matches a legitimate own property including an own constructor key", async () => {
    const status = await seed([{ field: "data.status", op: "equals", value: "ready" }], {
      eventId: "own-status",
      body: { data: { status: "ready" } },
    });
    expect(status.match.matched).toBe(1);
    expect(status.match.explanation).toContain("data.status equals yes");
    expect(status.tick.ok && status.tick.value.intents).toBe(1);
    expect(status.intents.ok && status.intents.value[0]?.state).toBe("observed");

    const ownCtor = await seed(
      [
        { field: "data.constructor", op: "exists" },
        { field: "data.constructor", op: "equals", value: "owned" },
      ],
      { ruleId: "rule_fields04", eventId: "own-ctor", body: { data: { constructor: "owned" } } },
    );
    expect(ownCtor.match.matched).toBe(1);
    expect(ownCtor.match.explanation).toContain("data.constructor exists yes");
    expect(ownCtor.match.explanation).toContain("data.constructor equals yes");
    expect(ownCtor.tick.ok && ownCtor.tick.value.intents).toBe(1);

    const ownSubject = await seed([{ field: "subject.externalId", op: "equals", value: "research-1" }], {
      ruleId: "rule_fields05",
      eventId: "own-subject",
      body: { subject: { externalId: "research-1" } },
    });
    expect(ownSubject.match.matched).toBe(1);
    expect(ownSubject.tick.ok && ownSubject.tick.value.intents).toBe(1);
  });
});
