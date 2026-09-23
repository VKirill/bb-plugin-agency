import { ensureLaunchIssue, resolveLaunchIssue } from "../src/server/runtime/launch-queue/issues";
import { enqueueParentWake } from "../src/server/runtime/parent-wake";
import { listTrace } from "../src/server/runtime/trace/store";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { hashBytes } from "../src/host/guarded-fs";
import { newOpaqueId, openMigratedDatabase, type SqlDatabase } from "../src/server/db";
import type { IsolatedSendPort } from "../src/server/runtime/isolated-sdk/send-port";
import {
  flushParentWakes,
  formatParentWakeText,
  parentWakeToken,
  recoverParentWakesFromActivities,
} from "../src/server/runtime/parent-wake";
import { seedRunningAttempt } from "./attempt-awaiting-review.test";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function openDb() {
  const dir = mkdtempSync(join(tmpdir(), "agy-parent-wake-"));
  tempDirs.push(dir);
  return openMigratedDatabase(new Database(join(dir, "agency.sqlite")));
}

function requestId(): string {
  return randomUUID();
}

function recordingSend(): IsolatedSendPort & {
  calls: Array<{ threadId: string; text: string }>;
  recovers: number;
  presence: "present" | "queued" | "absent" | "unknown";
} {
  const port: IsolatedSendPort & {
    calls: Array<{ threadId: string; text: string }>;
    recovers: number;
    presence: "present" | "queued" | "absent" | "unknown";
  } = {
    calls: [],
    recovers: 0,
    presence: "absent",
    async send(args) {
      port.calls.push(args);
      return { kind: "confirmed", delivery: "sent" };
    },
    async recoverContinuation() {
      port.recovers += 1;
      return port.presence;
    },
  };
  return port;
}

function wakes(db: SqlDatabase) {
  return db.prepare(`SELECT * FROM agency_parent_wake ORDER BY created_at`).all() as Array<{
    activity_id: string;
    causation_id: string;
    child_job_id: string;
    child_state: string;
    parent_attempt_id: string;
    parent_thread_id: string;
    send_state: string;
    dispatch_claimed: number;
  }>;
}

const FROZEN_CLOCK = "2026-09-14T13:51:00.000Z";

async function seedFamily(db: SqlDatabase) {
  const live = await seedRunningAttempt(db);
  live.seeded.ctx.clock = () => FROZEN_CLOCK;
  const parent = live.seeded.store.getJob(live.attempt.jobId)!;
  const child = live.seeded.store.createJob(live.seeded.ctx, {
    requestId: requestId(),
    key: "AG-3301",
    bindingId: parent.bindingId,
    departmentId: parent.departmentId,
    title: "Дочерняя",
    brief: "Сделать фрагмент.",
    acceptance: "Фрагмент готов.",
    parentJobId: parent.id,
    assignedAgentId: parent.assignedAgentId,
    priority: "normal",
    dueAt: null,
  });
  if (!child.ok) throw new Error(child.error.message);
  return { live, parent, child: child.value };
}

function blockChild(family: Awaited<ReturnType<typeof seedFamily>>) {
  const next = family.live.seeded.store.transitionJob(family.live.seeded.ctx, {
    requestId: requestId(),
    jobId: family.child.id,
    expectedRevision: family.live.seeded.store.getJob(family.child.id)!.revision,
    to: "blocked",
  });
  if (!next.ok) throw new Error(next.error.message);
  return next.value;
}

async function reviewChild(family: Awaited<ReturnType<typeof seedFamily>>) {
  const store = family.live.seeded.store;
  const ctx = family.live.seeded.ctx;
  const facts = store.setJobExecutionFacts(ctx, {
    requestId: requestId(),
    jobId: family.child.id,
    threadBound: true,
  });
  if (!facts.ok) throw new Error(facts.error.message);
  const queued = store.transitionJob(ctx, {
    requestId: requestId(),
    jobId: family.child.id,
    expectedRevision: store.getJob(family.child.id)!.revision,
    to: "queued",
  });
  if (!queued.ok) throw new Error(queued.error.message);
  const running = store.transitionJob(ctx, {
    requestId: requestId(),
    jobId: family.child.id,
    expectedRevision: queued.value.revision,
    to: "running",
  });
  if (!running.ok) throw new Error(running.error.message);
  const artifact = store.createArtifact(ctx, { requestId: requestId(), jobId: family.child.id });
  if (!artifact.ok) throw new Error(artifact.error.message);
  const bytes = new TextEncoder().encode("# child");
  const published = store.publishArtifactVersion(ctx, {
    requestId: requestId(),
    artifactId: artifact.value.id,
    jobId: family.child.id,
    hostId: "host_mini",
    relativePath: "notes/child.md",
    mime: "text/markdown",
    size: bytes.byteLength,
    hash: hashBytes(bytes),
    author: { kind: "system" },
  });
  if (!published.ok) throw new Error(published.error.message);
  const review = store.transitionJob(ctx, {
    requestId: requestId(),
    jobId: family.child.id,
    expectedRevision: running.value.revision,
    to: "review",
  });
  if (!review.ok) throw new Error(review.error.message);
  return review.value;
}

describe("parent wake", () => {
  it("sends once on child blocked; text is getJob, not accept", async () => {
    const db = openDb();
    const family = await seedFamily(db);
    const child = blockChild(family);
    const rows = wakes(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.child_state).toBe("blocked");
    expect(rows[0]?.causation_id).toBe(rows[0]?.activity_id);
    expect(rows[0]?.parent_attempt_id).toBe(family.live.attempt.attemptId);
    const send = recordingSend();
    await flushParentWakes({ db, send, now: new Date().toISOString() });
    expect(send.calls).toHaveLength(1);
    expect(send.calls[0]?.threadId).toBe(family.live.attempt.threadId);
    expect(send.calls[0]?.text).toContain(formatParentWakeText({ key: child.key, state: "blocked" }, rows[0]!.activity_id, "en"));
    expect(send.calls[0]?.text).toContain(parentWakeToken(rows[0]!.activity_id));
    expect(send.calls[0]?.text).toContain("not an acceptance");
    expect(send.calls[0]?.text).toContain("bb agency job state");
    expect(send.calls[0]?.text).toContain("Update job decide only if the route changes");
    expect(send.calls[0]?.text).not.toMatch(/\baccepted\b|artifact contents/i);
    await flushParentWakes({ db, send, now: new Date().toISOString() });
    expect(send.calls).toHaveLength(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM agency_artifact_acceptance`).get() as { n: number }).toEqual({ n: 0 });
  });

  it("does not enqueue a second wake when CRM updateJob bumps revision", async () => {
    const db = openDb();
    const family = await seedFamily(db);
    blockChild(family);
    expect(wakes(db)).toHaveLength(1);
    const current = family.live.seeded.store.getJob(family.child.id)!;
    const updated = family.live.seeded.store.updateJob(family.live.seeded.ctx, {
      requestId: requestId(),
      jobId: family.child.id,
      expectedRevision: current.revision,
      // The assignee cannot review the same job, so the CRM edit bumps the revision through the title.
      title: "Дочерняя после правки CRM",
    });
    expect(updated.ok).toBe(true);
    expect(family.live.seeded.store.getJob(family.child.id)!.revision).toBe(current.revision + 1);
    expect(wakes(db)).toHaveLength(1);
    expect(recoverParentWakesFromActivities(db, new Date().toISOString())).toBe(0);
    expect(wakes(db)).toHaveLength(1);
  });

  it("restores a still-current review from transition activity, not job.revision", async () => {
    const db = openDb();
    const family = await seedFamily(db);
    await reviewChild(family);
    expect(wakes(db)).toHaveLength(1);
    const before = wakes(db)[0]!;
    family.live.seeded.store.updateJob(family.live.seeded.ctx, {
      requestId: requestId(),
      jobId: family.child.id,
      expectedRevision: family.live.seeded.store.getJob(family.child.id)!.revision,
      title: "Дочерняя после CRM",
    });
    db.prepare(`DELETE FROM agency_parent_wake`).run();
    expect(recoverParentWakesFromActivities(db, new Date().toISOString())).toBe(1);
    const restored = wakes(db)[0]!;
    expect(restored.activity_id).toBe(before.activity_id);
    expect(restored.child_state).toBe("review");
    expect(restored.parent_attempt_id).toBe(family.live.attempt.attemptId);
  });

  it("does not recover a stale review onto a new parent attempt after the child left review", async () => {
    const db = openDb();
    const family = await seedFamily(db);
    const reviewed = await reviewChild(family);
    expect(wakes(db)).toHaveLength(1);
    const rework = family.live.seeded.store.transitionJob(family.live.seeded.ctx, {
      requestId: requestId(),
      jobId: family.child.id,
      expectedRevision: reviewed.revision,
      to: "running",
      reworkComment: "Вернуть в работу.",
    });
    expect(rework.ok).toBe(true);
    db.prepare(`DELETE FROM agency_parent_wake`).run();
    const canceled = family.live.runs.transitionAttempt(family.live.seeded.ctx, {
      requestId: requestId(),
      attemptId: family.live.attempt.attemptId,
      expectedRevision: family.live.attempt.revision,
      to: "canceled",
    });
    expect(canceled.ok).toBe(true);
    expect(recoverParentWakesFromActivities(db, new Date().toISOString())).toBe(0);
    expect(wakes(db)).toHaveLength(0);
    const send = recordingSend();
    await flushParentWakes({ db, send, now: new Date().toISOString() });
    expect(send.calls).toHaveLength(0);
    expect(send.recovers).toBe(0);
  });

  it("persists the outbox before send and recovers pending+claimed without a second send", async () => {
    const db = openDb();
    const family = await seedFamily(db);
    blockChild(family);
    let seenClaimedPending = false;
    const send: IsolatedSendPort = {
      async send() {
        const row = wakes(db)[0]!;
        seenClaimedPending = row.send_state === "pending" && row.dispatch_claimed === 1;
        return { kind: "confirmed", delivery: "sent" };
      },
      async recoverContinuation() {
        return "absent";
      },
    };
    await flushParentWakes({ db, send, now: new Date().toISOString() });
    expect(seenClaimedPending).toBe(true);

    const family2db = openDb();
    const family2 = await seedFamily(family2db);
    blockChild(family2);
    family2db.prepare(`UPDATE agency_parent_wake SET dispatch_claimed = 1`).run();
    const crashed = recordingSend();
    crashed.presence = "present";
    await flushParentWakes({ db: family2db, send: crashed, now: new Date().toISOString() });
    expect(crashed.calls).toHaveLength(0);
    expect(crashed.recovers).toBe(1);
    expect(wakes(family2db)[0]?.send_state).toBe("confirmed");
  });

  it("does not resend after queued or unknown", async () => {
    const db = openDb();
    const family = await seedFamily(db);
    blockChild(family);
    let sends = 0;
    const send: IsolatedSendPort = {
      async send() {
        sends += 1;
        return { kind: "confirmed", delivery: "queued", queuedMessageId: "qmsg_parent1" };
      },
      async recoverContinuation() {
        return "queued";
      },
    };
    await flushParentWakes({ db, send, now: new Date().toISOString() });
    await flushParentWakes({ db, send, now: new Date().toISOString() });
    expect(sends).toBe(1);
    expect(wakes(db)[0]?.send_state).toBe("queued");

    const db2 = openDb();
    const family2 = await seedFamily(db2);
    blockChild(family2);
    let unknownSends = 0;
    const unknown: IsolatedSendPort = {
      async send() {
        unknownSends += 1;
        return { kind: "unknown", code: "send_transport", message: "timeout" };
      },
      async recoverContinuation() {
        return "absent";
      },
    };
    await flushParentWakes({ db: db2, send: unknown, now: new Date().toISOString() });
    await flushParentWakes({ db: db2, send: unknown, now: new Date().toISOString() });
    expect(unknownSends).toBe(1);
    expect(wakes(db2)[0]?.send_state).toBe("unknown");
  });

  it("skips a child without parent and wakes the lead for a subtask in another department", async () => {
    const db = openDb();
    const family = await seedFamily(db);
    const orphan = family.live.seeded.store.createJob(family.live.seeded.ctx, {
      requestId: requestId(),
      key: "AG-3302",
      bindingId: family.parent.bindingId,
      departmentId: family.parent.departmentId,
      title: "Сирота",
      brief: "Без родителя.",
      acceptance: "Нет wake.",
      parentJobId: null,
      assignedAgentId: family.parent.assignedAgentId,
      priority: "normal",
      dueAt: null,
    });
    if (!orphan.ok) throw new Error(orphan.error.message);
    const blockedOrphan = family.live.seeded.store.transitionJob(family.live.seeded.ctx, {
      requestId: requestId(),
      jobId: orphan.value.id,
      expectedRevision: orphan.value.revision,
      to: "blocked",
    });
    expect(blockedOrphan.ok).toBe(true);
    expect(wakes(db).filter((row) => row.child_job_id === orphan.value.id)).toHaveLength(0);

    const other = family.live.seeded.store.provisionDepartment(family.live.seeded.ctx, {
      requestId: requestId(),
      name: "Другой отдел",
      leadAgentId: family.parent.assignedAgentId!,
      process: {
        instructions: "Иначе.",
        acceptance: "Иначе.",
        reviewPolicy: { required: false },
      },
    });
    if (!other.ok) throw new Error(other.error.message);
    const linked = family.live.seeded.store.linkDepartment(family.live.seeded.ctx, {
      requestId: requestId(),
      bindingId: family.parent.bindingId,
      departmentId: other.value.department.id,
    });
    expect(linked.ok).toBe(true);
    const foreign = family.live.seeded.store.createJob(family.live.seeded.ctx, {
      requestId: requestId(),
      key: "AG-3303",
      bindingId: family.parent.bindingId,
      departmentId: other.value.department.id,
      title: "Чужой отдел",
      brief: "Родитель в другом отделе.",
      acceptance: "Skip.",
      parentJobId: family.parent.id,
      assignedAgentId: family.parent.assignedAgentId,
      priority: "normal",
      dueAt: null,
    });
    if (!foreign.ok) throw new Error(foreign.error.message);
    const blockedForeign = family.live.seeded.store.transitionJob(family.live.seeded.ctx, {
      requestId: requestId(),
      jobId: foreign.value.id,
      expectedRevision: foreign.value.revision,
      to: "blocked",
    });
    expect(blockedForeign.ok).toBe(true);
    expect(wakes(db).filter((row) => row.child_job_id === foreign.value.id)).toHaveLength(1);
  });

  it("does not recover an older review after reentry onto a new parent attempt", async () => {
    const db = openDb();
    const family = await seedFamily(db);
    const firstReview = await reviewChild(family);
    const firstIds = reviewTransitionIds(db, family.child.id);
    expect(firstIds).toHaveLength(1);
    const firstActivityId = firstIds[0]!;
    expect(wakes(db).some((row) => row.activity_id === firstActivityId)).toBe(true);
    const rework = family.live.seeded.store.transitionJob(family.live.seeded.ctx, {
      requestId: requestId(),
      jobId: family.child.id,
      expectedRevision: firstReview.revision,
      to: "running",
      reworkComment: "Вернуть, затем снова review.",
    });
    expect(rework.ok).toBe(true);
    if (!rework.ok) throw new Error(rework.error.message);
    const secondReview = family.live.seeded.store.transitionJob(family.live.seeded.ctx, {
      requestId: requestId(),
      jobId: family.child.id,
      expectedRevision: rework.value.revision,
      to: "review",
    });
    expect(secondReview.ok).toBe(true);
    const reviewIds = reviewTransitionIds(db, family.child.id);
    expect(reviewIds).toHaveLength(2);
    const latestActivityId = reviewIds[1]!;
    expect(latestActivityId).not.toBe(firstActivityId);
    const transitionStamps = db
      .prepare(
        `SELECT timestamp FROM agency_activity WHERE job_id = ? AND kind = 'job_transitioned'`,
      )
      .all(family.child.id) as Array<{ timestamp: string }>;
    expect(transitionStamps.length).toBeGreaterThan(1);
    expect(new Set(transitionStamps.map((row) => row.timestamp))).toEqual(new Set([FROZEN_CLOCK]));
    const canceled = family.live.runs.transitionAttempt(family.live.seeded.ctx, {
      requestId: requestId(),
      attemptId: family.live.attempt.attemptId,
      expectedRevision: family.live.attempt.revision,
      to: "canceled",
    });
    expect(canceled.ok).toBe(true);
    const next = insertRunningHead(db, {
      parentJobId: family.parent.id,
      snapshotId: family.live.attempt.snapshotId,
      digest: family.live.attempt.digest,
      threadId: "thr_parentwake02",
    });
    expect(recoverParentWakesFromActivities(db, new Date().toISOString())).toBe(1);
    expect(wakes(db).filter((row) => row.activity_id === firstActivityId && row.parent_attempt_id === next.attemptId)).toHaveLength(
      0,
    );
    const recovered = wakes(db).filter((row) => row.parent_attempt_id === next.attemptId);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.activity_id).toBe(latestActivityId);
    const send = recordingSend();
    await flushParentWakes({ db, send, now: new Date().toISOString() });
    expect(send.calls.every((call) => !call.text.includes(parentWakeToken(firstActivityId)))).toBe(true);
    expect(send.calls).toHaveLength(1);
    expect(send.calls[0]?.threadId).toBe(next.threadId);
    expect(send.calls[0]?.text).toContain(parentWakeToken(latestActivityId));
  });

  it("keeps other rows moving when one send throws and leaves claimed pending recover-only", async () => {
    const db = openDb();
    const family = await seedFamily(db);
    blockChild(family);
    const sibling = family.live.seeded.store.createJob(family.live.seeded.ctx, {
      requestId: requestId(),
      key: "AG-3304",
      bindingId: family.parent.bindingId,
      departmentId: family.parent.departmentId,
      title: "Вторая",
      brief: "Ещё фрагмент.",
      acceptance: "Готово.",
      parentJobId: family.parent.id,
      assignedAgentId: family.parent.assignedAgentId,
      priority: "normal",
      dueAt: null,
    });
    if (!sibling.ok) throw new Error(sibling.error.message);
    const blockedSibling = family.live.seeded.store.transitionJob(family.live.seeded.ctx, {
      requestId: requestId(),
      jobId: sibling.value.id,
      expectedRevision: sibling.value.revision,
      to: "blocked",
    });
    expect(blockedSibling.ok).toBe(true);
    let sends = 0;
    const send: IsolatedSendPort = {
      async send() {
        sends += 1;
        if (sends === 1) throw new Error("transport boom");
        return { kind: "confirmed", delivery: "sent" };
      },
      async recoverContinuation() {
        return "absent";
      },
    };
    await flushParentWakes({ db, send, now: new Date().toISOString() });
    expect(sends).toBe(2);
    const states = wakes(db).map((row) => row.send_state).sort();
    expect(states).toEqual(["confirmed", "unknown"]);
    const crashed = wakes(db).find((row) => row.send_state === "unknown")!;
    expect(crashed.dispatch_claimed).toBe(1);
    const recoverOnly = recordingSend();
    recoverOnly.presence = "present";
    await flushParentWakes({ db, send: recoverOnly, now: new Date().toISOString() });
    expect(recoverOnly.calls).toHaveLength(0);
    expect(recoverOnly.recovers).toBe(1);
    expect(wakes(db).every((row) => row.send_state === "confirmed")).toBe(true);
  });

  it("does not send to an older nonterminal after a newer HEAD exists", async () => {
    const db = openDb();
    const family = await seedFamily(db);
    blockChild(family);
    expect(wakes(db)[0]?.parent_attempt_id).toBe(family.live.attempt.attemptId);
    insertCanceledHead(db, family.parent.id, family.live.attempt.snapshotId, family.live.attempt.digest);
    const send = recordingSend();
    send.presence = "present";
    await flushParentWakes({ db, send, now: new Date().toISOString() });
    expect(send.calls).toHaveLength(0);
    expect(send.recovers).toBe(0);
    expect(wakes(db)[0]?.send_state).toBe("skipped");
    expect(recoverParentWakesFromActivities(db, new Date().toISOString())).toBe(0);
  });

  it("wakes the lead when automatic QC is blocked instead of silently accepting work", async () => {
    const db = openDb();
    const family = await seedFamily(db);
    db.prepare(
      `INSERT INTO agency_auto_review (job_id, hash, review_job_id, outcome, created_at) VALUES (?, ?, ?, 'pending', ?)`,
    ).run(family.parent.id, "ab".repeat(32), family.child.id, FROZEN_CLOCK);
    blockChild(family);
    expect(wakes(db)).toHaveLength(1);
  });
});

function reviewTransitionIds(db: SqlDatabase, jobId: string): string[] {
  const rows = db
    .prepare(
      `SELECT id, references_json FROM agency_activity
       WHERE job_id = ? AND kind = 'job_transitioned'
       ORDER BY rowid`,
    )
    .all(jobId) as Array<{ id: string; references_json: string }>;
  return rows
    .filter((row) =>
      (JSON.parse(row.references_json) as Array<{ type: string; id: string }>).some(
        (item) => item.type === "job_state" && item.id === "review",
      ),
    )
    .map((row) => row.id);
}

function insertRunningHead(
  db: SqlDatabase,
  input: { parentJobId: string; snapshotId: string; digest: string; threadId: string },
) {
  const now = new Date().toISOString();
  const attemptId = newOpaqueId("runAttempt");
  const launchId = randomUUID();
  db.prepare(
    `INSERT INTO agency_run_attempt
      (id, job_id, attempt_no, snapshot_id, digest, thread_id, launch_id, state, revision, created_at, updated_at)
     VALUES (?, ?, 2, ?, ?, ?, ?, 'running', 1, ?, ?)`,
  ).run(attemptId, input.parentJobId, input.snapshotId, input.digest, input.threadId, launchId, now, now);
  db.prepare(
    `INSERT INTO agency_launch_receipt
      (launch_id, attempt_id, job_id, snapshot_id, digest, thread_id, spawn_kind,
       persist_error_code, persist_error_message, job_bind_state, needs_reconciliation,
       parent_request_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'confirmed', NULL, NULL, 'applied', 0, ?, ?, ?)`,
  ).run(launchId, attemptId, input.parentJobId, input.snapshotId, input.digest, input.threadId, requestId(), now, now);
  return { attemptId, launchId, threadId: input.threadId };
}

function insertCanceledHead(db: SqlDatabase, parentJobId: string, snapshotId: string, digest: string) {
  const now = new Date().toISOString();
  const attemptId = newOpaqueId("runAttempt");
  db.prepare(
    `INSERT INTO agency_run_attempt
      (id, job_id, attempt_no, snapshot_id, digest, thread_id, launch_id, state, revision, created_at, updated_at)
     VALUES (?, ?, 2, ?, ?, NULL, NULL, 'canceled', 1, ?, ?)`,
  ).run(attemptId, parentJobId, snapshotId, digest, now, now);
  return attemptId;
}


describe("launch issues reach the lead before a state transition", () => {
  it.each([["review", "rework_limit_reached"], ["blocked", "rework_limit_reached"], ["review", "review_creation_failed"], ["review", "review_handoff_rejected"]])("delivers a recovery incident while the source job is %s (%s)", async (state, code) => {
    const db = openDb(); const family = await seedFamily(db); const store = family.live.seeded.store; const ctx = family.live.seeded.ctx;
    db.prepare("UPDATE agency_job SET state = ? WHERE id = ?").run(state, family.child.id);
    const job = store.getJob(family.child.id)!;
    const activity = ensureLaunchIssue(db, job, code!, FROZEN_CLOCK, comment => store.createActivity(ctx, {
      requestId: requestId(), jobId: job.id, actor: { kind: "system" }, kind: "comment", causationId: null,
      references: [{ type: "launch_issue", id: code! }, { type: "job_state", id: state! }], comment,
    }), true)!;
    expect(enqueueParentWake(db, job, activity, FROZEN_CLOCK)).toBe(true);
    const send = recordingSend(); await flushParentWakes({ db, send, now: FROZEN_CLOCK });
    expect(send.calls).toHaveLength(1); expect(send.calls[0].text).toContain(code === "rework_limit_reached" ? "job recover" : "job diagnose");
    await flushParentWakes({ db, send, now: FROZEN_CLOCK }); expect(send.calls).toHaveLength(1); db.close();
  });
  it("delivers one actionable issue for a queued auto-review, survives recovery and ignores it after resolution", async () => {
    const db = openDb(); const family = await seedFamily(db); const store = family.live.seeded.store; const ctx = family.live.seeded.ctx;
    const queued = store.transitionJob(ctx, { requestId: requestId(), jobId: family.child.id, expectedRevision: family.child.revision, to: "queued" });
    if (!queued.ok) throw Error(queued.error.message);
    db.prepare("INSERT INTO agency_auto_review (job_id, hash, review_job_id, outcome, created_at) VALUES (?, ?, ?, 'queued', ?)").run(family.parent.id, "a".repeat(64), queued.value.id, FROZEN_CLOCK);
    let created = 0;
    const issue = () => ensureLaunchIssue(db, queued.value, "spec_required", FROZEN_CLOCK, (comment) => {
      created++;
      return store.createActivity(ctx, { requestId: requestId(), jobId: queued.value.id, actor: {kind:"system"}, kind:"comment", causationId:null,
        references:[{type:"launch_issue",id:"spec_required"},{type:"job_state",id:"queued"}], comment });
    }, true)!;
    const a=issue(); expect(issue().id).toBe(a.id); expect(created).toBe(1);
    expect(enqueueParentWake(db, queued.value, a, FROZEN_CLOCK)).toBe(true);
    expect(recoverParentWakesFromActivities(db,FROZEN_CLOCK)).toBe(0);
    const send=recordingSend(); await flushParentWakes({db,send,now:FROZEN_CLOCK});
    expect(send.calls).toHaveLength(1); expect(send.calls[0]!.text).toContain("Attach the exact normative artifact/version/hash");
    expect(send.calls[0]!.threadId).toBe(family.live.attempt.threadId);
    expect(listTrace(db,{jobId:queued.value.id}).records.some(r=>r.step==="lead.delivery"&&r.outcome==="succeeded")).toBe(true);
    await flushParentWakes({db,send,now:FROZEN_CLOCK});expect(send.calls).toHaveLength(1);
    resolveLaunchIssue(db,queued.value.id);expect(enqueueParentWake(db,queued.value,a,FROZEN_CLOCK)).toBe(false);
    // A future recurrence is a new incident; resolving before dispatch prevents a stale instruction.
    const b=issue();expect(b.id).not.toBe(a.id);enqueueParentWake(db,queued.value,b,FROZEN_CLOCK);resolveLaunchIssue(db,queued.value.id);
    await flushParentWakes({db,send,now:FROZEN_CLOCK});expect(send.calls).toHaveLength(1); db.close();
  });
});
