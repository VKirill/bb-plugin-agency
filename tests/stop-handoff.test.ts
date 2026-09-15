import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { computeHandoffHash } from "../src/server/runtime/context-snapshot";
import {
  createStopHandoffService,
  createStopHandoffStore,
  evaluateEvidence,
  emptyEvidence,
  type OfficialThreadStatus,
  type ThreadGetPort,
  type ThreadListRunningPort,
  type ThreadStopPort,
  type WriterQuiescencePort,
} from "../src/server/runtime/stop-handoff";
import { createInternalRunStoreReads } from "../src/server/runtime/run-store";
import { seedRunningAttempt } from "./attempt-awaiting-review.test";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function openFileDb() {
  const dir = mkdtempSync(join(tmpdir(), "agy-stop-handoff-"));
  tempDirs.push(dir);
  const path = join(dir, "agency.sqlite");
  return { db: openMigratedDatabase(new Database(path)), path };
}

function stopPort(impl?: () => Promise<{ ok: true }>): ThreadStopPort & { calls: number } {
  const port: ThreadStopPort & { calls: number } = {
    supported: true,
    calls: 0,
    async stop() {
      port.calls += 1;
      if (impl) return impl();
      return { ok: true };
    },
  };
  return port;
}

function getPort(status: OfficialThreadStatus | null, threadId: string): ThreadGetPort {
  return {
    supported: true,
    async get(args) {
      return { threadId: args.threadId === threadId ? threadId : args.threadId, status };
    },
  };
}

function listPort(ids: readonly string[]): ThreadListRunningPort {
  return {
    supported: true,
    async listRunning() {
      return ids.map((id) => ({ id, hostId: "host_mini" }));
    },
  };
}

const unsupported = { supported: false as const };

describe("evaluateEvidence", () => {
  it("does not treat idle-only get as confirmed stop", () => {
    const idleOnly = evaluateEvidence({
      kind: "threads.stop+get+listRunning",
      stopAck: null,
      get: { threadId: "thr_x", status: "idle" },
      listRunning: { occupyingStatuses: ["starting", "active"], threadPresent: false },
    });
    expect(idleOnly.phase).toBe("intent");
    expect(emptyEvidence().stopAck).toBeNull();
  });

  it("requires listRunning even after stop ack + idle", () => {
    const evaluated = evaluateEvidence({
      kind: "threads.stop+get+listRunning",
      stopAck: { ok: true },
      get: { threadId: "thr_x", status: "idle" },
      listRunning: null,
    });
    expect(evaluated.phase).toBe("reconciling");
  });
});

describe("stop-handoff service (SQLite agency_request)", () => {
  it("records observed stop and allows handoff pins without authorising replacement", async () => {
    const opened = openFileDb();
    const live = await seedRunningAttempt(opened.db);
    const store = createStopHandoffStore(opened.db);
    const stop = stopPort();
    const service = createStopHandoffService({
      store,
      reads: live.reads,
      stop,
      get: getPort("idle", live.receipt.threadId!),
      listRunning: listPort([]),
    });
    const requestId = randomUUID();
    const stopped = await service.requestStop(live.seeded.ctx, {
      requestId,
      jobId: live.attempt.jobId,
      attemptId: live.attempt.attemptId,
      expectedAttemptRevision: live.attempt.revision,
      launchId: live.receipt.launchId,
      threadId: live.receipt.threadId!,
      reason: "reviewer asked to stop",
    });
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) throw new Error(stopped.error.message);
    expect(stopped.value.phase).toBe("confirmed");
    expect(stopped.value.evidence.stopAck).toEqual({ ok: true });
    expect(stop.calls).toBe(1);

    const spawn = await service.assertCanSpawn(live.seeded.ctx, { jobId: live.attempt.jobId });
    expect(spawn.ok).toBe(false);
    if (spawn.ok) throw new Error("expected block");
    expect(spawn.error.code).toBe("spawn_blocked_until_writer_quiescence");

    const compiled = service.compileHandoff(live.seeded.ctx, {
      requestId,
      acceptedArtifacts: [],
      openQuestions: ["остался ли brief?"],
      returnReason: "reviewer asked to stop",
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(compiled.error.message);
    expect(compiled.value.priorRunAttemptId).toBe(live.attempt.attemptId);
    expect(compiled.value.fromSnapshotDigest).toBe(live.attempt.digest);
    expect(compiled.value.hash).toBe(
      computeHandoffHash({
        priorRunAttemptId: compiled.value.priorRunAttemptId,
        fromSnapshotDigest: compiled.value.fromSnapshotDigest,
        acceptedArtifacts: compiled.value.acceptedArtifacts,
        openQuestions: compiled.value.openQuestions,
        returnReason: compiled.value.returnReason,
      }),
    );
    expect(stop.calls).toBe(1);

    const replay = await service.requestStop(live.seeded.ctx, {
      requestId,
      jobId: live.attempt.jobId,
      attemptId: live.attempt.attemptId,
      expectedAttemptRevision: live.attempt.revision,
      launchId: live.receipt.launchId,
      threadId: live.receipt.threadId!,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.error.message);
    expect(replay.value.phase).toBe("confirmed");
    expect(stop.calls).toBe(1);
  });

  it("keeps reconciling and blocks spawn when idle but still in listRunning", async () => {
    const opened = openFileDb();
    const live = await seedRunningAttempt(opened.db);
    const store = createStopHandoffStore(opened.db);
    const service = createStopHandoffService({
      store,
      reads: live.reads,
      stop: stopPort(),
      get: getPort("idle", live.receipt.threadId!),
      listRunning: listPort([live.receipt.threadId!]),
    });
    const result = await service.requestStop(live.seeded.ctx, {
      requestId: randomUUID(),
      jobId: live.attempt.jobId,
      attemptId: live.attempt.attemptId,
      expectedAttemptRevision: live.attempt.revision,
      launchId: live.receipt.launchId,
      threadId: live.receipt.threadId!,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.phase).toBe("reconciling");
    const spawn = await service.assertCanSpawn(live.seeded.ctx, { jobId: live.attempt.jobId });
    expect(spawn.ok).toBe(false);
    if (spawn.ok) throw new Error("expected block");
    expect(spawn.error.code).toBe("spawn_blocked_stop_in_flight");
    const handoff = service.compileHandoff(live.seeded.ctx, {
      requestId: result.value.requestId,
      acceptedArtifacts: [],
      openQuestions: [],
      returnReason: null,
    });
    expect(handoff.ok).toBe(false);
    if (handoff.ok) throw new Error("expected refuse");
    expect(handoff.error.code).toBe("stop_not_confirmed");
  });

  it("does not confirm stopping status even with stop ack and empty listRunning", async () => {
    const opened = openFileDb();
    const live = await seedRunningAttempt(opened.db);
    const service = createStopHandoffService({
      store: createStopHandoffStore(opened.db),
      reads: live.reads,
      stop: stopPort(),
      get: getPort("stopping", live.receipt.threadId!),
      listRunning: listPort([]),
    });
    const result = await service.requestStop(live.seeded.ctx, {
      requestId: randomUUID(),
      jobId: live.attempt.jobId,
      attemptId: live.attempt.attemptId,
      expectedAttemptRevision: live.attempt.revision,
      launchId: live.receipt.launchId,
      threadId: live.receipt.threadId!,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.phase).toBe("reconciling");
  });

  it("refuses confirm when listRunning port is unsupported (idle is not enough)", async () => {
    const opened = openFileDb();
    const live = await seedRunningAttempt(opened.db);
    const service = createStopHandoffService({
      store: createStopHandoffStore(opened.db),
      reads: live.reads,
      stop: stopPort(),
      get: getPort("idle", live.receipt.threadId!),
      listRunning: unsupported,
    });
    const result = await service.requestStop(live.seeded.ctx, {
      requestId: randomUUID(),
      jobId: live.attempt.jobId,
      attemptId: live.attempt.attemptId,
      expectedAttemptRevision: live.attempt.revision,
      launchId: live.receipt.launchId,
      threadId: live.receipt.threadId!,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.error.code).toBe("threads_list_running_unsupported");
    const spawn = await service.assertCanSpawn(live.seeded.ctx, { jobId: live.attempt.jobId });
    expect(spawn.ok).toBe(false);
    if (spawn.ok) throw new Error("expected block");
    expect(spawn.error.code).toBe("spawn_blocked_stop_in_flight");
  });

  it("rejects a second open requestId and rejects foreign artifact pins", async () => {
    const opened = openFileDb();
    const live = await seedRunningAttempt(opened.db);
    const store = createStopHandoffStore(opened.db);
    const service = createStopHandoffService({
      store,
      reads: live.reads,
      stop: stopPort(),
      get: getPort("active", live.receipt.threadId!),
      listRunning: listPort([live.receipt.threadId!]),
    });
    const first = await service.requestStop(live.seeded.ctx, {
      requestId: randomUUID(),
      jobId: live.attempt.jobId,
      attemptId: live.attempt.attemptId,
      expectedAttemptRevision: live.attempt.revision,
      launchId: live.receipt.launchId,
      threadId: live.receipt.threadId!,
    });
    expect(first.ok).toBe(true);
    const second = await service.requestStop(live.seeded.ctx, {
      requestId: randomUUID(),
      jobId: live.attempt.jobId,
      attemptId: live.attempt.attemptId,
      expectedAttemptRevision: live.attempt.revision,
      launchId: live.receipt.launchId,
      threadId: live.receipt.threadId!,
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected conflict");
    expect(second.error.code).toBe("open_stop_intent_exists");

    const confirming = createStopHandoffService({
      store,
      reads: live.reads,
      stop: stopPort(),
      get: getPort("error", live.receipt.threadId!),
      listRunning: listPort([]),
    });
    if (!first.ok) throw new Error(first.error.message);
    const reconciled = await confirming.reconcileStop(live.seeded.ctx, { requestId: first.value.requestId });
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) throw new Error(reconciled.error.message);
    expect(reconciled.value.phase).toBe("confirmed");

    const badPin = confirming.compileHandoff(live.seeded.ctx, {
      requestId: first.value.requestId,
      acceptedArtifacts: [
        {
          artifactId: "art_foreign",
          version: 1,
          hash: "a".repeat(64),
          jobId: live.attempt.jobId,
          hostId: "host_mini",
          relativePath: "out/x.md",
        },
      ],
      openQuestions: [],
      returnReason: null,
    });
    expect(badPin.ok).toBe(false);
    if (badPin.ok) throw new Error("expected pin reject");
    expect(badPin.error.code).toBe("handoff_artifact_unauthorized");
  });

  it("survives reopen of the same SQLite file", async () => {
    const opened = openFileDb();
    const live = await seedRunningAttempt(opened.db);
    const requestId = randomUUID();
    const first = createStopHandoffService({
      store: createStopHandoffStore(opened.db),
      reads: live.reads,
      stop: stopPort(),
      get: getPort("idle", live.receipt.threadId!),
      listRunning: listPort([]),
    });
    const stopped = await first.requestStop(live.seeded.ctx, {
      requestId,
      jobId: live.attempt.jobId,
      attemptId: live.attempt.attemptId,
      expectedAttemptRevision: live.attempt.revision,
      launchId: live.receipt.launchId,
      threadId: live.receipt.threadId!,
    });
    expect(stopped.ok).toBe(true);
    opened.db.close();

    const db = openMigratedDatabase(new Database(opened.path));
    const reads = createInternalRunStoreReads(db);
    const reopened = createStopHandoffService({
      store: createStopHandoffStore(db),
      reads,
      stop: unsupported,
      get: unsupported,
      listRunning: unsupported,
    });
    const remembered = await reopened.requestStop(live.seeded.ctx, {
      requestId,
      jobId: live.attempt.jobId,
      attemptId: live.attempt.attemptId,
      expectedAttemptRevision: live.attempt.revision,
      launchId: live.receipt.launchId,
      threadId: live.receipt.threadId!,
    });
    expect(remembered.ok).toBe(true);
    if (!remembered.ok) throw new Error(remembered.error.message);
    expect(remembered.value.phase).toBe("confirmed");
    db.close();
  });

  it("does not authorise spawn when no stop intent exists", async () => {
    const opened = openFileDb();
    const live = await seedRunningAttempt(opened.db);
    const service = createStopHandoffService({
      store: createStopHandoffStore(opened.db),
      reads: live.reads,
      stop: unsupported,
      get: getPort("idle", live.receipt.threadId!),
      listRunning: listPort([]),
    });
    const spawn = await service.assertCanSpawn(live.seeded.ctx, { jobId: live.attempt.jobId });
    expect(spawn.ok).toBe(false);
    if (spawn.ok) throw new Error("expected refuse");
    expect(spawn.error.code).toBe("spawn_not_authorized_by_stop_module");
  });

  it("blocks confirmed + unavailable quiescence and grants only SafeReplacement", async () => {
    const opened = openFileDb();
    const live = await seedRunningAttempt(opened.db);
    const store = createStopHandoffStore(opened.db);
    const observed = createStopHandoffService({
      store,
      reads: live.reads,
      stop: stopPort(),
      get: getPort("idle", live.receipt.threadId!),
      listRunning: listPort([]),
    });
    const requestId = randomUUID();
    const stopped = await observed.requestStop(live.seeded.ctx, {
      requestId,
      jobId: live.attempt.jobId,
      attemptId: live.attempt.attemptId,
      expectedAttemptRevision: live.attempt.revision,
      launchId: live.receipt.launchId,
      threadId: live.receipt.threadId!,
    });
    expect(stopped.ok && stopped.value.phase).toBe("confirmed");

    const unavailable: WriterQuiescencePort = {
      supported: true,
      async verify() {
        return "unavailable";
      },
    };
    const blocked = createStopHandoffService({
      store,
      reads: live.reads,
      stop: unsupported,
      get: unsupported,
      listRunning: unsupported,
      quiescence: unavailable,
    });
    const denied = await blocked.assertCanSpawn(live.seeded.ctx, { jobId: live.attempt.jobId });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("expected block");
    expect(denied.error.code).toBe("spawn_blocked_until_writer_quiescence");

    const ready: WriterQuiescencePort = {
      supported: true,
      async verify(claim) {
        expect(claim.kind).toBe("observed_stop");
        expect(claim.requestId).toBe(requestId);
        return "confirmed";
      },
    };
    const granted = createStopHandoffService({
      store,
      reads: live.reads,
      stop: unsupported,
      get: unsupported,
      listRunning: unsupported,
      quiescence: ready,
    });
    const allowed = await granted.assertCanSpawn(live.seeded.ctx, { jobId: live.attempt.jobId });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) throw new Error(allowed.error.message);
    expect(allowed.value.kind).toBe("safe_replacement");
    expect(allowed.value.quiescence).toBe("confirmed");
    expect(allowed.value.observedStop.threadId).toBe(live.receipt.threadId);
  });
});
