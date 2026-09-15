import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAlias } from "../src/server/cli/aliases";
import { openMigratedDatabase } from "../src/server/db";
import { createInbox } from "../src/server/inbox/store";
import {
  approveActionIntent,
  claimActionIntent,
  completeActionIntent,
  countLegacyInbox,
  countTypedInbox,
  dispatchTick,
  expireIntentLease,
  ingestInboxEvent,
  listActionIntents,
  listEventDefinitions,
  listEventSources,
  listRuleVersions,
  saveEventDefinition,
  saveEventSource,
  saveRuleVersion,
  stableDispatchLaunchId,
} from "../src/server/dispatcher/engine";
import { fail, ok } from "../src/domain";
import type { DispatcherLaunchPort } from "../src/server/dispatcher/ports";
import type { ServiceContext } from "../src/server/services";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function openDb() {
  const dir = mkdtempSync(join(tmpdir(), "agy-dispatch-"));
  tempDirs.push(dir);
  return openMigratedDatabase(new Database(join(dir, "agency.sqlite")));
}

const ctx: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [] };

function requestId() {
  return randomUUID();
}

async function seedRule(
  db: ReturnType<typeof openDb>,
  patch: { mode?: "observe" | "approve" | "auto" | "disabled"; enabled?: boolean; projectId?: string; maxRetries?: number; maxDepth?: number } = {},
) {
  const deps = { db };
  const definition = saveEventDefinition(deps, ctx, {
    requestId: requestId(),
    topic: "research.delivered",
    schemaVersion: 1,
    namespace: "agency",
    label: "Исследование доставлено",
    payloadSchema: { type: "object" },
  });
  expect(definition.ok).toBe(true);
  const source = saveEventSource(deps, ctx, {
    requestId: requestId(),
    projectId: patch.projectId ?? "proj_trusted",
    kind: "notify",
    enabled: true,
  });
  expect(source.ok).toBe(true);
  if (!source.ok) throw new Error(source.error.message);
  const rule = saveRuleVersion(deps, ctx, {
    requestId: requestId(),
    ruleId: "rule_research01",
    projectId: patch.projectId ?? "proj_trusted",
    sourceId: source.value.id,
    topic: "research.delivered",
    conditions: [{ field: "data.status", op: "equals", value: "ready" }],
    mode: patch.mode ?? "auto",
    action: {
      kind: "prepare_job",
      departmentId: "dep_aaaaaaaaaaaa",
      title: "Проверить материал",
      brief: "Прочитать поставку",
      acceptance: "Заметка с вердиктом",
    },
    maxDepth: patch.maxDepth ?? 12,
    maxRetries: patch.maxRetries ?? 3,
    enabled: patch.enabled ?? true,
  });
  expect(rule.ok).toBe(true);
  if (!rule.ok) throw new Error(rule.error.message);
  return { deps, sourceId: source.value.id, ruleId: rule.value.id };
}

describe("durable dispatcher inbox", () => {
  it("resolves CLI aliases and does not replay alpha notify", async () => {
    expect(resolveAlias(["event", "ingest"])).toBe("ingestInboxEvent");
    expect(resolveAlias(["event", "definition-list"])).toBe("listEventDefinitions");
    expect(resolveAlias(["event", "source-list"])).toBe("listEventSources");
    expect(resolveAlias(["rule", "list"])).toBe("listRuleVersions");
    expect(resolveAlias(["dispatch", "tick"])).toBe("dispatchTick");
    expect(resolveAlias(["intent", "claim"])).toBe("claimActionIntent");
    expect(resolveAlias(["intent", "approve"])).toBe("approveActionIntent");
    expect(resolveAlias(["intent", "complete"])).toBe("completeActionIntent");
    const db = openDb();
    const inbox = createInbox(db);
    inbox.accept(
      { projectId: "proj_legacy", eventId: "legacy-1", topic: "research.delivered", reference: "old" },
      "cli",
    );
    expect(countLegacyInbox(db)).toBe(1);
    const { deps } = await seedRule(db);
    const tick = dispatchTick(deps, ctx, { requestId: requestId(), live: false, limit: 20 });
    expect(tick.ok && tick.value.legacyInboxIgnored).toBe(true);
    expect(tick.ok && tick.value.evaluated).toBe(0);
    expect(countTypedInbox(db)).toBe(0);
    const intents = listActionIntents(deps, {});
    expect(intents.ok && intents.value).toEqual([]);
  });

  it("dedups the same ingest and conflicts on a different body", async () => {
    const db = openDb();
    const { deps, sourceId } = await seedRule(db);
    const body = {
      requestId: requestId(),
      sourceId,
      eventId: "delivery-1",
      topic: "research.delivered",
      reference: "artifact:1",
      body: { data: { status: "ready" } },
      depth: 0,
    };
    const first = ingestInboxEvent(deps, ctx, body);
    const replay = ingestInboxEvent(deps, ctx, { ...body, requestId: requestId() });
    expect(first.ok && first.value.duplicate).toBe(false);
    expect(replay.ok && replay.value.duplicate).toBe(true);
    expect(replay.ok && replay.value.id).toBe(first.ok ? first.value.id : "");
    const conflict = ingestInboxEvent(deps, ctx, {
      ...body,
      requestId: requestId(),
      body: { data: { status: "other" } },
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("request_conflict");
    const storedDigest = db
      .prepare(`SELECT body_digest FROM agency_inbox_event WHERE event_id = ?`)
      .get("delivery-1") as { body_digest: string };
    for (const patch of [
      { reference: "artifact:other" },
      { topic: "research.other" },
      { depth: 1 },
    ] as const) {
      const mismatch = ingestInboxEvent(deps, ctx, { ...body, requestId: requestId(), ...patch });
      expect(mismatch.ok).toBe(false);
      if (!mismatch.ok) expect(mismatch.error.code).toBe("request_conflict");
    }
    const reopen = ingestInboxEvent(deps, ctx, { ...body, requestId: requestId() });
    expect(reopen.ok && reopen.value.duplicate).toBe(true);
    expect(reopen.ok && reopen.value.id).toBe(first.ok ? first.value.id : "");
    expect(
      (db.prepare(`SELECT body_digest FROM agency_inbox_event WHERE event_id = ?`).get("delivery-1") as { body_digest: string })
        .body_digest,
    ).toBe(storedDigest.body_digest);
  });

  it("skips disabled rules and foreign project scope", async () => {
    const db = openDb();
    const disabled = await seedRule(db, { enabled: false, mode: "auto" });
    ingestInboxEvent(disabled.deps, ctx, {
      requestId: requestId(),
      sourceId: disabled.sourceId,
      eventId: "delivery-disabled",
      topic: "research.delivered",
      reference: "artifact:d",
      body: { data: { status: "ready" } },
      depth: 0,
    });
    const tickDisabled = dispatchTick(disabled.deps, ctx, { requestId: requestId(), live: false });
    expect(tickDisabled.ok && tickDisabled.value.intents).toBe(0);
    const foreign = await seedRule(openDb(), { projectId: "proj_other" });
    const local = await seedRule(db, { projectId: "proj_trusted" });
    ingestInboxEvent(local.deps, ctx, {
      requestId: requestId(),
      sourceId: local.sourceId,
      eventId: "delivery-local",
      topic: "research.delivered",
      reference: "artifact:l",
      body: { data: { status: "ready" } },
      depth: 0,
    });
    const foreignRule = saveRuleVersion(local.deps, ctx, {
      requestId: requestId(),
      ruleId: "rule_foreign01",
      projectId: "proj_other",
      topic: "research.delivered",
      conditions: [],
      mode: "auto",
      action: { kind: "observe" },
      maxDepth: 12,
      maxRetries: 3,
      enabled: true,
    });
    expect(foreignRule.ok).toBe(true);
    const tick = dispatchTick(local.deps, ctx, { requestId: requestId(), live: false });
    expect(tick.ok && tick.value.intents).toBe(1);
    const matches = db
      .prepare(`SELECT explanation, matched FROM agency_rule_match ORDER BY explanation`)
      .all() as Array<{ explanation: string; matched: number }>;
    expect(matches.some((row) => row.explanation === "foreign project scope" && row.matched === 0)).toBe(true);
    expect(foreign.sourceId).toBeTruthy();
  });

  it("holds a claim lease and does not burn retries on live_gate or unavailable", async () => {
    const db = openDb();
    const { deps, sourceId } = await seedRule(db, { mode: "auto", maxRetries: 2 });
    ingestInboxEvent(deps, ctx, {
      requestId: requestId(),
      sourceId,
      eventId: "delivery-retry",
      topic: "research.delivered",
      reference: "artifact:r",
      body: { data: { status: "ready" } },
      depth: 0,
    });
    const tick = dispatchTick(deps, ctx, { requestId: requestId(), live: true });
    expect(tick.ok && tick.value.intents).toBe(1);
    const listed = listActionIntents(deps, {});
    expect(listed.ok && listed.value[0]?.state).toBe("queued");
    const intentId = listed.ok ? listed.value[0]!.id : "";
    const first = await claimActionIntent(deps, ctx, {
      requestId: requestId(),
      intentId,
      live: false,
      leaseOwner: "worker-a",
      leaseMs: 60_000,
    });
    expect(first.ok && first.value.state).toBe("claimed");
    expect(first.ok && first.value.lastError).toBe("live_gate");
    expect(first.ok && first.value.attemptCount).toBe(0);
    expect(first.ok && first.value.liveGate).toBe(false);
    expect(first.ok && first.value.fencingToken).toBeTruthy();
    const crash = await claimActionIntent(deps, ctx, {
      requestId: requestId(),
      intentId,
      live: false,
      leaseOwner: "worker-b",
      leaseMs: 60_000,
    });
    expect(crash.ok).toBe(false);
    if (!crash.ok) expect(crash.error.code).toBe("request_conflict");
    expireIntentLease(db, intentId);
    const gated = await claimActionIntent(deps, ctx, {
      requestId: requestId(),
      intentId,
      live: false,
      leaseOwner: "worker-a",
      leaseMs: 60_000,
    });
    expect(gated.ok && gated.value.attemptCount).toBe(0);
    expireIntentLease(db, intentId);
    const unavailable = await claimActionIntent(deps, ctx, {
      requestId: requestId(),
      intentId,
      live: true,
      leaseOwner: "worker-a",
      leaseMs: 60_000,
    });
    expect(unavailable.ok && unavailable.value.lastError).toBe("capability_unavailable");
    expect(unavailable.ok && unavailable.value.attemptCount).toBe(0);
    expect(unavailable.ok && unavailable.value.state).toBe("claimed");
    expect(unavailable.ok && unavailable.value.jobId).toBeNull();
  });

  it("skips when depth exceeds the rule cap", async () => {
    const db = openDb();
    const { deps, sourceId } = await seedRule(db, { maxDepth: 1 });
    ingestInboxEvent(deps, ctx, {
      requestId: requestId(),
      sourceId,
      eventId: "delivery-deep",
      topic: "research.delivered",
      reference: "artifact:deep",
      body: { data: { status: "ready" } },
      depth: 1,
    });
    const tick = dispatchTick(deps, ctx, { requestId: requestId(), live: false });
    expect(tick.ok && tick.value.intents).toBe(0);
    const row = db.prepare(`SELECT explanation FROM agency_rule_match`).get() as { explanation: string };
    expect(row.explanation).toContain("depth 1 >= 1");
  });

  it("moves approve intents to queued and keeps launch port unavailable", async () => {
    const db = openDb();
    const { deps, sourceId } = await seedRule(db, { mode: "approve" });
    ingestInboxEvent(deps, ctx, {
      requestId: requestId(),
      sourceId,
      eventId: "delivery-approve",
      topic: "research.delivered",
      reference: "artifact:a",
      body: { data: { status: "ready" } },
      depth: 0,
    });
    dispatchTick(deps, ctx, { requestId: requestId(), live: false });
    const listed = listActionIntents(deps, {});
    expect(listed.ok && listed.value[0]?.state).toBe("awaiting_approval");
    const intentId = listed.ok ? listed.value[0]!.id : "";
    const tooSoon = await claimActionIntent(deps, ctx, {
      requestId: requestId(),
      intentId,
      live: false,
      leaseOwner: "worker-a",
    });
    expect(tooSoon.ok).toBe(false);
    if (!tooSoon.ok) expect(tooSoon.error.code).toBe("illegal_transition");
    const stale = approveActionIntent(deps, ctx, { requestId: requestId(), intentId, expectedRevision: 99 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("revision_conflict");
    const approved = approveActionIntent(deps, ctx, { requestId: requestId(), intentId, expectedRevision: 1 });
    expect(approved.ok && approved.value.state).toBe("queued");
    expect(approved.ok && approved.value.revision).toBe(2);
    const replay = approveActionIntent(deps, ctx, { requestId: requestId(), intentId, expectedRevision: 2 });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe("illegal_transition");
    const claimed = await claimActionIntent(deps, ctx, {
      requestId: requestId(),
      intentId,
      live: false,
      leaseOwner: "worker-a",
    });
    expect(claimed.ok && claimed.value.state).toBe("claimed");
    expect(claimed.ok && claimed.value.lastError).toBe("live_gate");
    expect(claimed.ok && claimed.value.jobId).toBeNull();
    const staleFence = completeActionIntent(deps, ctx, {
      requestId: requestId(),
      intentId,
      fencingToken: requestId(),
      fencingGeneration: 1,
      outcome: "succeeded",
    });
    expect(staleFence.ok).toBe(false);
    if (!staleFence.ok) expect(staleFence.error.code).toBe("lease_fence_mismatch");
    const done = completeActionIntent(deps, ctx, {
      requestId: requestId(),
      intentId,
      fencingToken: claimed.ok ? claimed.value.fencingToken : "",
      fencingGeneration: claimed.ok ? claimed.value.fencingGeneration : 0,
      outcome: "succeeded",
    });
    expect(done.ok && done.value.state).toBe("succeeded");
  });

  it("burns maxRetries only on a real launch error", async () => {
    const db = openDb();
    const { deps, sourceId } = await seedRule(db, { mode: "auto", maxRetries: 2 });
    const launch: DispatcherLaunchPort = {
      async enqueueLaunch() {
        return fail("launch_failed", "injected launch failure");
      },
    };
    ingestInboxEvent({ db }, ctx, {
      requestId: requestId(),
      sourceId,
      eventId: "delivery-real-retry",
      topic: "research.delivered",
      reference: "artifact:rr",
      body: { data: { status: "ready" } },
      depth: 0,
    });
    dispatchTick({ db }, ctx, { requestId: requestId(), live: false });
    const listed = listActionIntents({ db }, {});
    const intentId = listed.ok ? listed.value[0]!.id : "";
    const first = await claimActionIntent({ db, launch }, ctx, {
      requestId: requestId(),
      intentId,
      live: true,
      leaseOwner: "worker-a",
      leaseMs: 60_000,
    });
    expect(first.ok && first.value.attemptCount).toBe(1);
    expect(first.ok && first.value.state).toBe("claimed");
    expireIntentLease(db, intentId);
    const second = await claimActionIntent({ db, launch }, ctx, {
      requestId: requestId(),
      intentId,
      live: true,
      leaseOwner: "worker-a",
      leaseMs: 60_000,
    });
    expect(second.ok && second.value.attemptCount).toBe(2);
    expect(second.ok && second.value.state).toBe("failed");
    expect(deps.db).toBe(db);
  });

  it("lets only one WAL connection enqueue after lease expiry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-dispatch-wal-"));
    tempDirs.push(dir);
    const path = join(dir, "agency.sqlite");
    const dbA = openMigratedDatabase(new Database(path));
    dbA.pragma("journal_mode = WAL");
    dbA.pragma("busy_timeout = 5000");
    const seeded = await seedRule(dbA, { mode: "auto" });
    ingestInboxEvent(seeded.deps, ctx, {
      requestId: requestId(),
      sourceId: seeded.sourceId,
      eventId: "delivery-race",
      topic: "research.delivered",
      reference: "artifact:race",
      body: { data: { status: "ready" } },
      depth: 0,
    });
    dispatchTick(seeded.deps, ctx, { requestId: requestId(), live: false });
    const listed = listActionIntents(seeded.deps, {});
    const intentId = listed.ok ? listed.value[0]!.id : "";
    const firstHold = await claimActionIntent(seeded.deps, ctx, {
      requestId: requestId(),
      intentId,
      live: false,
      leaseOwner: "worker-a",
      leaseMs: 60_000,
    });
    expect(firstHold.ok).toBe(true);
    expireIntentLease(dbA, intentId);
    const dbB = openMigratedDatabase(new Database(path));
    dbB.pragma("busy_timeout = 5000");
    let enqueues = 0;
    const countingLaunch = (): DispatcherLaunchPort => ({
      async enqueueLaunch() {
        enqueues += 1;
        return ok({ jobId: null, launchId: null });
      },
    });
    const [a, b] = await Promise.all([
      claimActionIntent({ db: dbA, launch: countingLaunch() }, ctx, {
        requestId: requestId(),
        intentId,
        live: true,
        leaseOwner: "worker-a",
        leaseMs: 60_000,
      }),
      claimActionIntent({ db: dbB, launch: countingLaunch() }, ctx, {
        requestId: requestId(),
        intentId,
        live: true,
        leaseOwner: "worker-b",
        leaseMs: 60_000,
      }),
    ]);
    const oks = [a, b].filter((row) => row.ok);
    const conflicts = [a, b].filter((row) => !row.ok && row.error.code === "request_conflict");
    expect(enqueues).toBe(1);
    expect(oks.length).toBe(1);
    expect(conflicts.length).toBe(1);
    const winner = oks[0];
    expect(winner && winner.ok && winner.value.fencingGeneration).toBeGreaterThan(1);
    dbB.close();
    dbA.close();
  });

  it("does not treat an expired in-flight enqueue as a dead writer", async () => {
    const db = openDb();
    const { deps, sourceId } = await seedRule(db, { mode: "auto" });
    ingestInboxEvent(deps, ctx, {
      requestId: requestId(),
      sourceId,
      eventId: "delivery-inflight",
      topic: "research.delivered",
      reference: "artifact:if",
      body: { data: { status: "ready" } },
      depth: 0,
    });
    dispatchTick(deps, ctx, { requestId: requestId(), live: false });
    const listed = listActionIntents(deps, {});
    const intentId = listed.ok ? listed.value[0]!.id : "";
    let release!: (value: { jobId: string; launchId: string }) => void;
    const held = new Promise<{ jobId: string; launchId: string }>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    const launch: DispatcherLaunchPort = {
      async enqueueLaunch(input) {
        seen.push(input.launchId);
        const receipt = await held;
        return ok({ jobId: receipt.jobId, launchId: input.launchId });
      },
    };
    const first = claimActionIntent({ db, launch }, ctx, {
      requestId: requestId(),
      intentId,
      live: true,
      leaseOwner: "worker-a",
      leaseMs: 60_000,
    });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expireIntentLease(db, intentId);
    const second = await claimActionIntent({ db, launch }, ctx, {
      requestId: requestId(),
      intentId,
      live: true,
      leaseOwner: "worker-b",
      leaseMs: 60_000,
    });
    expect(second.ok && second.value.lastError).toBe("send_needs_reconciliation");
    expect(second.ok && second.value.jobId).toBeNull();
    expect(seen).toHaveLength(1);
    const fence = db
      .prepare(`SELECT fencing_generation, launch_id, dispatch_claimed FROM agency_action_intent WHERE id = ?`)
      .get(intentId) as { fencing_generation: number; launch_id: string; dispatch_claimed: number };
    expect(fence.dispatch_claimed).toBe(1);
    expect(fence.launch_id).toBe(stableDispatchLaunchId(intentId));
    expect(second.ok && second.value.fencingGeneration).toBe(fence.fencing_generation);
    release({ jobId: "job_inflight01", launchId: fence.launch_id });
    const done = await first;
    expect(done.ok && done.value.jobId).toBe("job_inflight01");
    expect(done.ok && done.value.lastError).toBeNull();
    expect(seen).toHaveLength(1);
    expireIntentLease(db, intentId);
    const third = await claimActionIntent({ db, launch }, ctx, {
      requestId: requestId(),
      intentId,
      live: true,
      leaseOwner: "worker-c",
      leaseMs: 60_000,
    });
    expect(third.ok && third.value.jobId).toBe("job_inflight01");
    expect(seen).toHaveLength(1);
    const stored = db
      .prepare(`SELECT job_id, launch_id, fencing_generation FROM agency_action_intent WHERE id = ?`)
      .get(intentId) as { job_id: string; launch_id: string; fencing_generation: number };
    expect(stored.job_id).toBe("job_inflight01");
    expect(stored.launch_id).toBe(fence.launch_id);
    expect(stored.fencing_generation).toBe(fence.fencing_generation);
  });

  it("lists catalog labels and joins them onto action intents", async () => {
    const db = openDb();
    const { deps, sourceId } = await seedRule(db, { mode: "observe" });
    ingestInboxEvent(deps, ctx, {
      requestId: requestId(),
      sourceId,
      eventId: "delivery-catalog",
      topic: "research.delivered",
      reference: "artifact:cat",
      body: { data: { status: "ready" } },
      depth: 0,
    });
    dispatchTick(deps, ctx, { requestId: requestId(), live: false });
    const definitions = listEventDefinitions(deps, {});
    expect(definitions.ok && definitions.value).toEqual([
      { topic: "research.delivered", schemaVersion: 1, namespace: "agency", label: "Исследование доставлено" },
    ]);
    const sources = listEventSources(deps, { projectId: "proj_trusted" });
    expect(sources.ok && sources.value).toEqual([
      { id: sourceId, projectId: "proj_trusted", kind: "notify", enabled: true },
    ]);
    const otherSources = listEventSources(deps, { projectId: "proj_other" });
    expect(otherSources.ok && otherSources.value).toEqual([]);
    const rules = listRuleVersions(deps, { projectId: "proj_trusted" });
    expect(rules.ok && rules.value[0]).toMatchObject({
      ruleId: "rule_research01",
      label: "rule_research01",
      topic: "research.delivered",
      mode: "observe",
      sourceId,
    });
    const listed = listActionIntents(deps, { projectId: "proj_trusted", state: "observed" });
    expect(listed.ok && listed.value).toHaveLength(1);
    expect(listed.ok && listed.value[0]).toMatchObject({
      state: "observed",
      topic: "research.delivered",
      definitionLabel: "Исследование доставлено",
      ruleId: "rule_research01",
      ruleLabel: "rule_research01",
      sourceId,
      sourceKind: "notify",
    });
    const otherIntents = listActionIntents(deps, { projectId: "proj_other" });
    expect(otherIntents.ok && otherIntents.value).toEqual([]);
  });
});
