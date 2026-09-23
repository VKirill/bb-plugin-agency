import { applyVerifiedCompletionLifecycle, interpretVerifiedCompletion } from "../src/server/runtime/isolated-sdk";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { createCancelLaunchService } from "../src/server/runtime/cancel-launch";
import type { OfficialThreadStatus, ThreadGetPort, ThreadListRunningPort, ThreadStopPort } from "../src/server/runtime/stop-handoff";
import { publishVersion, seedRunningAttempt } from "./attempt-awaiting-review.test";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function openDb() {
  const dir = mkdtempSync(join(tmpdir(), "agy-cancel-"));
  tempDirs.push(dir);
  return openMigratedDatabase(new Database(join(dir, "agency.sqlite")));
}

function stopPort(): ThreadStopPort & { calls: number } {
  const port: ThreadStopPort & { calls: number } = {
    supported: true,
    calls: 0,
    async stop() {
      port.calls += 1;
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

describe("cancelLaunch", () => {
  it("cancels the attempt, blocks the same job, and replays without a second stop", async () => {
    const db = openDb();
    const live = await seedRunningAttempt(db);
    const job = live.seeded.store.getJob(live.attempt.jobId)!;
    const stop = stopPort();
    const service = createCancelLaunchService({
      db,
      store: live.seeded.store,
      runs: live.runs,
      reads: live.reads,
      stop,
      get: getPort("idle", live.attempt.threadId!),
      listRunning: listPort([]),
    });
    const requestId = randomUUID();
    const input = {
      requestId,
      jobId: live.attempt.jobId,
      attemptId: live.attempt.attemptId,
      expectedJobRevision: job.revision,
      expectedAttemptRevision: live.attempt.revision,
      launchId: live.attempt.launchId!,
      threadId: live.attempt.threadId!,
      reason: "wrong provider acp/cursor; recover same AG job",
    };
    const first = await service.cancelLaunch(live.seeded.ctx, input);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value).toMatchObject({
      jobState: "blocked",
      attemptState: "canceled",
      writerDeadClaimed: false,
      replay: false,
      observedStop: { stopAck: true, getStatus: "idle", listRunningPresent: false },
    });
    expect(live.seeded.store.getJob(live.attempt.jobId)?.state).toBe("blocked");
    expect(live.seeded.store.getJob(live.attempt.jobId)?.state).not.toBe("canceled");
    const attempt = live.reads.getAttempt(live.seeded.ctx, live.attempt.attemptId);
    expect(attempt.ok && attempt.value.state).toBe("canceled");
    const replay = await service.cancelLaunch(live.seeded.ctx, input);
    expect(replay.ok && replay.value.replay).toBe(true);
    expect(replay.ok && replay.value.jobRevision).toBe(first.value.jobRevision);
    expect(stop.calls).toBe(1);
  });

  it("stops an awaiting-review worker without losing its published version or history", async () => {
    const db = openDb();
    const live = await seedRunningAttempt(db);
    const version = publishVersion(live.seeded, new TextEncoder().encode("accepted criteria remain evidence"));
    const handedIn = applyVerifiedCompletionLifecycle({
      store: live.seeded.store, runs: live.runs, reads: live.reads, ctx: live.seeded.ctx,
      jobId: live.attempt.jobId, launchId: live.receipt.launchId,
      reading: interpretVerifiedCompletion({ threadStatus: "idle", publishedVerified: true, acceptedVerified: false }),
      publishedHash: version.hash,
    });
    if (!handedIn.ok) throw new Error(handedIn.error.message);
    const moved = live.reads.getAttempt(live.seeded.ctx, live.attempt.attemptId);
    if (!moved.ok) throw new Error(moved.error.message);
    expect(moved.value.state).toBe("awaiting_review");
    const job = live.seeded.store.getJob(live.attempt.jobId)!;
    expect(job.state).toBe("review");
    const artifactsBefore = db.prepare("SELECT * FROM agency_artifact_version WHERE job_id = ?").all(job.id);
    const historyBefore = db.prepare("SELECT id FROM agency_activity WHERE job_id = ?").all(job.id) as { id: string }[];
    const stop = stopPort();
    const service = createCancelLaunchService({ db, store: live.seeded.store, runs: live.runs, reads: live.reads, stop, get: getPort("idle", live.attempt.threadId!), listRunning: listPort([]) });
    const input = { requestId: randomUUID(), jobId: job.id, attemptId: moved.value.attemptId, expectedJobRevision: job.revision,
      expectedAttemptRevision: moved.value.revision, launchId: moved.value.launchId!, threadId: moved.value.threadId!, reason: "Owner requested migration from Claude to GPT-6" };
    const result = await service.cancelLaunch(live.seeded.ctx, input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toMatchObject({ jobState: "blocked", attemptState: "canceled" });
    expect(db.prepare("SELECT * FROM agency_artifact_version WHERE job_id = ?").all(job.id)).toEqual(artifactsBefore);
    expect(artifactsBefore).toContainEqual(expect.objectContaining({ hash: version.hash }));
    const historyAfter = db.prepare("SELECT id FROM agency_activity WHERE job_id = ?").all(job.id);
    expect(historyAfter).toEqual(expect.arrayContaining(historyBefore));
    expect((await service.cancelLaunch(live.seeded.ctx, input)).ok).toBe(true);
    expect(stop.calls).toBe(1);
    expect(live.seeded.store.getJob(job.id)?.state).toBe("blocked");
  });

  it.each(["done", "canceled"] as const)("rejects a %s job before stopping its thread", async (state) => {
    const db = openDb();
    const live = await seedRunningAttempt(db);
    db.prepare("UPDATE agency_job SET state = ? WHERE id = ?").run(state, live.attempt.jobId);
    const job = live.seeded.store.getJob(live.attempt.jobId)!;
    const stop = stopPort();
    const service = createCancelLaunchService({ db, store: live.seeded.store, runs: live.runs, reads: live.reads, stop, get: getPort("idle", live.attempt.threadId!), listRunning: listPort([]) });
    const result = await service.cancelLaunch(live.seeded.ctx, {
      requestId: randomUUID(), jobId: job.id, attemptId: live.attempt.attemptId, expectedJobRevision: job.revision,
      expectedAttemptRevision: live.attempt.revision, launchId: live.attempt.launchId!, threadId: live.attempt.threadId!, reason: "invalid target",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
    expect(stop.calls).toBe(0);
    expect(live.seeded.store.getJob(job.id)?.state).toBe(state);
  });

  it("does not stop the thread when expectedJobRevision is stale", async () => {
    const db = openDb();
    const live = await seedRunningAttempt(db);
    const job = live.seeded.store.getJob(live.attempt.jobId)!;
    const stop = stopPort();
    const service = createCancelLaunchService({
      db,
      store: live.seeded.store,
      runs: live.runs,
      reads: live.reads,
      stop,
      get: getPort("idle", live.attempt.threadId!),
      listRunning: listPort([]),
    });
    const denied = await service.cancelLaunch(live.seeded.ctx, {
      requestId: randomUUID(),
      jobId: live.attempt.jobId,
      attemptId: live.attempt.attemptId,
      expectedJobRevision: job.revision + 1,
      expectedAttemptRevision: live.attempt.revision,
      launchId: live.attempt.launchId!,
      threadId: live.attempt.threadId!,
      reason: "stale job revision must not stop the thread",
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("expected revision_conflict");
    expect(denied.error.code).toBe("revision_conflict");
    expect(stop.calls).toBe(0);
    expect(live.seeded.store.getJob(live.attempt.jobId)?.state).toBe("running");
    expect(live.seeded.store.getJob(live.attempt.jobId)?.revision).toBe(job.revision);
    const attempt = live.reads.getAttempt(live.seeded.ctx, live.attempt.attemptId);
    expect(attempt.ok && attempt.value.state).toBe("running");
  });

  it("returns a generic thread_observe_failed without provider Error.message", async () => {
    const db = openDb();
    const live = await seedRunningAttempt(db);
    const job = live.seeded.store.getJob(live.attempt.jobId)!;
    const stop: ThreadStopPort & { calls: number } = {
      supported: true,
      calls: 0,
      async stop() {
        stop.calls += 1;
        throw new Error("ACP_HOME=/secret provider env leaked");
      },
    };
    const service = createCancelLaunchService({
      db,
      store: live.seeded.store,
      runs: live.runs,
      reads: live.reads,
      stop,
      get: getPort("idle", live.attempt.threadId!),
      listRunning: listPort([]),
    });
    const denied = await service.cancelLaunch(live.seeded.ctx, {
      requestId: randomUUID(),
      jobId: live.attempt.jobId,
      attemptId: live.attempt.attemptId,
      expectedJobRevision: job.revision,
      expectedAttemptRevision: live.attempt.revision,
      launchId: live.attempt.launchId!,
      threadId: live.attempt.threadId!,
      reason: "observe throw must not leak provider text",
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("expected thread_observe_failed");
    expect(denied.error.code).toBe("thread_observe_failed");
    expect(denied.error.message).toBe("thread observe failed");
    expect(denied.error.message).not.toMatch(/ACP_HOME|secret|provider/);
    expect(live.seeded.store.getJob(live.attempt.jobId)?.state).toBe("running");
  });

  it("does not mutate when the exact thread is still listed as active", async () => {
    const db = openDb();
    const live = await seedRunningAttempt(db);
    const job = live.seeded.store.getJob(live.attempt.jobId)!;
    const service = createCancelLaunchService({
      db,
      store: live.seeded.store,
      runs: live.runs,
      reads: live.reads,
      stop: stopPort(),
      get: getPort("active", live.attempt.threadId!),
      listRunning: listPort([live.attempt.threadId!]),
    });
    const denied = await service.cancelLaunch(live.seeded.ctx, {
      requestId: randomUUID(),
      jobId: live.attempt.jobId,
      attemptId: live.attempt.attemptId,
      expectedJobRevision: job.revision,
      expectedAttemptRevision: live.attempt.revision,
      launchId: live.attempt.launchId!,
      threadId: live.attempt.threadId!,
      reason: "still active",
    });
    expect(denied.ok).toBe(false);
    expect(live.seeded.store.getJob(live.attempt.jobId)?.state).toBe("running");
    const attempt = live.reads.getAttempt(live.seeded.ctx, live.attempt.attemptId);
    expect(attempt.ok && attempt.value.state).toBe("running");
  });
});
