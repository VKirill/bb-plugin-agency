import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { withCallerThread } from "../src/server/api/caller";
import { openMigratedDatabase, type SqlDatabase } from "../src/server/db";
import { buildAgencyInstructions } from "../src/server/delegation/instructions";
import {
  enqueueClientBounce,
  flushClientBounces,
  formatPendingClientQuestions,
  recoverClientBouncesFromOpenWaits,
} from "../src/server/runtime/client-bounce";
import { reportNeedsInput } from "../src/server/runtime/needs-input/report";
import type { IsolatedSendPort } from "../src/server/runtime/isolated-sdk/send-port";
import { createJobCommandSchema } from "../src/shared/contracts/job";
import type { NeedsInputQuestion, ReportNeedsInputCommand } from "../src/shared/contracts";
import { seedRunningAttempt } from "./attempt-awaiting-review.test";
import { seed } from "./role-types.test";

const ORIGIN = "thr_clientchat01";
const NOW = "2026-09-20T00:30:00.000Z";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function openFileDb() {
  const dir = mkdtempSync(join(tmpdir(), "agy-bounce-"));
  tempDirs.push(dir);
  return { db: openMigratedDatabase(new Database(join(dir, "agency.sqlite"))) };
}

function recordingSend(): IsolatedSendPort & { calls: Array<{ threadId: string; text: string }> } {
  const port: IsolatedSendPort & { calls: Array<{ threadId: string; text: string }> } = {
    calls: [],
    async send(args) {
      port.calls.push(args);
      return { kind: "confirmed", delivery: "sent" };
    },
    async recoverContinuation() {
      return "absent";
    },
  };
  return port;
}

function questions(processId: string, jobId: string): NeedsInputQuestion[] {
  return [
    {
      id: "q1",
      text: "Какой секрет подставить?",
      sourceRefs: [
        { kind: "process_acceptance", id: processId },
        { kind: "job_acceptance", id: jobId },
      ],
    },
  ];
}

function reportCommand(
  live: Awaited<ReturnType<typeof seedRunningAttempt>>,
  patch: Partial<ReportNeedsInputCommand> = {},
): ReportNeedsInputCommand {
  const job = live.seeded.store.getJob(live.seeded.job.id)!;
  const attempt = live.reads.getAttempt(live.seeded.ctx, live.attempt.attemptId);
  if (!attempt.ok) throw new Error(attempt.error.message);
  return {
    requestId: randomUUID(),
    jobId: job.id,
    expectedRevision: job.revision,
    attemptId: live.attempt.attemptId,
    expectedAttemptRevision: attempt.value.revision,
    launchId: live.receipt.launchId,
    threadId: live.receipt.threadId!,
    questions: questions(live.seeded.processVersion.id, job.id),
    ...patch,
  };
}

function bounceRows(db: SqlDatabase) {
  return db.prepare(`SELECT * FROM agency_client_bounce ORDER BY created_at`).all() as Array<{
    wait_id: string;
    origin_thread_id: string;
    send_state: string;
  }>;
}

describe("client bounce of waiting_input questions", () => {
  it("sends the questions to the commissioning chat, not the worker thread", async () => {
    const opened = openFileDb();
    const live = await seedRunningAttempt(opened.db);
    opened.db.prepare(`UPDATE agency_job SET origin_thread_id = ? WHERE id = ?`).run(ORIGIN, live.seeded.job.id);
    const reported = reportNeedsInput(
      { db: opened.db, store: live.seeded.store, runs: live.runs, reads: live.reads },
      live.seeded.ctx,
      reportCommand(live),
    );
    expect(reported.ok).toBe(true);
    if (!reported.ok) throw new Error(reported.error.message);
    expect(bounceRows(opened.db)).toMatchObject([{ origin_thread_id: ORIGIN, send_state: "pending" }]);
    const send = recordingSend();
    await flushClientBounces({ db: opened.db, send, now: NOW });
    expect(send.calls).toHaveLength(1);
    expect(send.calls[0]?.threadId).toBe(ORIGIN);
    expect(send.calls[0]?.threadId).not.toBe(live.receipt.threadId);
    expect(send.calls[0]?.text).toContain("Agency factory pause");
    expect(send.calls[0]?.text).toContain("native choice card");
    expect(send.calls[0]?.text).toContain(reported.value.waitId);
    expect(send.calls[0]?.text).toContain("Какой секрет подставить?");
    expect(bounceRows(opened.db)[0]?.send_state).toBe("confirmed");
  });

  it("skips enqueue when origin is missing or is the worker thread", async () => {
    const opened = openFileDb();
    const live = await seedRunningAttempt(opened.db);
    const deps = { db: opened.db, store: live.seeded.store, runs: live.runs, reads: live.reads };
    expect(reportNeedsInput(deps, live.seeded.ctx, reportCommand(live)).ok).toBe(true);
    expect(bounceRows(opened.db)).toEqual([]);

    const again = openFileDb();
    const live2 = await seedRunningAttempt(again.db);
    again.db
      .prepare(`UPDATE agency_job SET origin_thread_id = ? WHERE id = ?`)
      .run(live2.receipt.threadId, live2.seeded.job.id);
    expect(
      reportNeedsInput(
        { db: again.db, store: live2.seeded.store, runs: live2.runs, reads: live2.reads },
        live2.seeded.ctx,
        reportCommand(live2),
      ).ok,
    ).toBe(true);
    expect(bounceRows(again.db)).toEqual([]);
  });

  it("attaches origin later and recovers the open wait into a bounce", async () => {
    const opened = openFileDb();
    const live = await seedRunningAttempt(opened.db);
    const reported = reportNeedsInput(
      { db: opened.db, store: live.seeded.store, runs: live.runs, reads: live.reads },
      live.seeded.ctx,
      reportCommand(live),
    );
    expect(reported.ok).toBe(true);
    const job = live.seeded.store.getJob(live.seeded.job.id)!;
    const updated = live.seeded.store.updateJob(live.seeded.ctx, {
      requestId: randomUUID(),
      jobId: job.id,
      expectedRevision: job.revision,
      originThreadId: ORIGIN,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error(updated.error.message);
    expect(updated.value.originThreadId).toBe(ORIGIN);
    expect(bounceRows(opened.db)).toHaveLength(1);
    expect(recoverClientBouncesFromOpenWaits(opened.db, NOW)).toBe(0);
    const pending = formatPendingClientQuestions(opened.db, ORIGIN, "en");
    expect(pending).toContain("## Agency is waiting on this chat");
    expect(pending).toContain("Какой секрет подставить?");
    expect(buildAgencyInstructions(opened.db, { threadId: ORIGIN, projectId: "proj_unbound" }, "off")).toContain(
      "Агентство ждёт ответ в этом чате",
    );
    expect(buildAgencyInstructions(opened.db, { threadId: live.receipt.threadId!, projectId: "proj_unbound" }, "off")).toBeNull();
  });

  it("does not enqueue twice for the same wait", async () => {
    const opened = openFileDb();
    const live = await seedRunningAttempt(opened.db);
    opened.db.prepare(`UPDATE agency_job SET origin_thread_id = ? WHERE id = ?`).run(ORIGIN, live.seeded.job.id);
    const reported = reportNeedsInput(
      { db: opened.db, store: live.seeded.store, runs: live.runs, reads: live.reads },
      live.seeded.ctx,
      reportCommand(live),
    );
    expect(reported.ok).toBe(true);
    if (!reported.ok) throw new Error(reported.error.message);
    const job = live.seeded.store.getJob(live.seeded.job.id)!;
    expect(enqueueClientBounce(opened.db, job, reported.value.waitId, NOW)).toBe(false);
    expect(bounceRows(opened.db)).toHaveLength(1);
  });
});

describe("origin thread capture", () => {
  it("stores the owner CLI thread on create", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const created = withCallerThread("thr_ownerchat01", () =>
      s.store.createJob(
        s.ctx,
        createJobCommandSchema.parse({
          requestId: randomUUID(),
          bindingId: s.ctx.allowedBindingIds[0],
          departmentId: s.departmentId,
          title: "С клиента",
          brief: "Бриф.",
          acceptance: "Критерий.",
          assignedAgentId: s.developer,
        }),
      ),
    );
    expect(created.ok && created.value.originThreadId).toBe("thr_ownerchat01");
  });

  it("does not store an employee attempt thread as origin", async () => {
    const opened = openFileDb();
    const live = await seedRunningAttempt(opened.db);
    const created = withCallerThread(live.receipt.threadId!, () =>
      live.seeded.store.createJob(
        live.seeded.ctx,
        createJobCommandSchema.parse({
          requestId: randomUUID(),
          bindingId: live.seeded.binding.id,
          departmentId: live.seeded.job.departmentId,
          title: "С завода",
          brief: "Бриф.",
          acceptance: "Критерий.",
          assignedAgentId: live.seeded.job.assignedAgentId,
        }),
      ),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.message);
    expect(created.value.originThreadId).toBeUndefined();
  });

  it("lets a subtask inherit the parent origin", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const parent = s.store.createJob(
      s.ctx,
      createJobCommandSchema.parse({
        requestId: randomUUID(),
        bindingId: s.ctx.allowedBindingIds[0],
        departmentId: s.departmentId,
        title: "Корень",
        brief: "Бриф.",
        acceptance: "Критерий.",
        assignedAgentId: s.developer,
        originThreadId: ORIGIN,
      }),
    );
    expect(parent.ok && parent.value.originThreadId).toBe(ORIGIN);
    if (!parent.ok) throw new Error(parent.error.message);
    const child = s.store.createJob(
      s.ctx,
      createJobCommandSchema.parse({
        requestId: randomUUID(),
        bindingId: s.ctx.allowedBindingIds[0],
        departmentId: s.departmentId,
        title: "Подзадача",
        brief: "Бриф.",
        acceptance: "Критерий.",
        assignedAgentId: s.developer,
        parentJobId: parent.value.id,
      }),
    );
    expect(child.ok && child.value.originThreadId).toBe(ORIGIN);
  });
});

describe("client bounce of a delivered product", () => {
  it("sends the accepted product to the commissioning chat when origin is attached after close", async () => {
    const opened = openFileDb();
    const s = seed(opened.db);
    const created = s.job("Корень", s.developer);
    const artifact = s.store.createArtifact(s.ctx, { requestId: randomUUID(), jobId: created.id });
    expect(artifact.ok).toBe(true);
    if (!artifact.ok) throw new Error(artifact.error.message);
    const published = s.store.publishArtifactVersion(s.ctx, {
      requestId: randomUUID(),
      artifactId: artifact.value.id,
      jobId: created.id,
      hostId: "host_mini",
      relativePath: "report.md",
      mime: "text/markdown",
      size: 4,
      hash: "a".repeat(64),
      author: { kind: "system" },
    });
    expect(published.ok).toBe(true);
    opened.db.prepare(`UPDATE agency_job SET state = 'done' WHERE id = ?`).run(created.id);
    const job = s.store.getJob(created.id)!;
    const updated = s.store.updateJob(s.ctx, {
      requestId: randomUUID(),
      jobId: job.id,
      expectedRevision: job.revision,
      originThreadId: ORIGIN,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error(updated.error.message);
    expect(bounceRows(opened.db)).toMatchObject([{ origin_thread_id: ORIGIN, send_state: "pending" }]);
    const send = recordingSend();
    await flushClientBounces({ db: opened.db, send, now: NOW });
    expect(send.calls).toHaveLength(1);
    expect(send.calls[0]?.threadId).toBe(ORIGIN);
    expect(send.calls[0]?.text).toMatch(/product is ready|Продукт готов/);
    expect(send.calls[0]?.text).toContain("report.md");
    expect(bounceRows(opened.db)[0]?.send_state).toBe("confirmed");
  });

  it("does not bounce a child station as a customer product", () => {
    const opened = openFileDb();
    const s = seed(opened.db);
    const parent = s.job("Корень", s.developer);
    const child = s.store.createJob(
      s.ctx,
      createJobCommandSchema.parse({
        requestId: randomUUID(),
        bindingId: s.bindingId,
        departmentId: s.departmentId,
        title: "Станция",
        brief: "Бриф.",
        acceptance: "Критерий.",
        assignedAgentId: s.developer,
        parentJobId: parent.id,
      }),
    );
    expect(child.ok).toBe(true);
    if (!child.ok) throw new Error(child.error.message);
    opened.db.prepare(`UPDATE agency_job SET state = 'done' WHERE id = ?`).run(child.value.id);
    const live = s.store.getJob(child.value.id)!;
    const updated = s.store.updateJob(s.ctx, {
      requestId: randomUUID(),
      jobId: live.id,
      expectedRevision: live.revision,
      originThreadId: ORIGIN,
    });
    expect(updated.ok).toBe(true);
    expect(bounceRows(opened.db)).toEqual([]);
  });
});
