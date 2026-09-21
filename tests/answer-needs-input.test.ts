import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAlias } from "../src/server/cli/aliases";
import { AWAITING_REVIEW_MIGRATION_ID, migrations, openMigratedDatabase } from "../src/server/db";
import { sha256Hex } from "../src/server/runtime/context-snapshot/canonical";
import { answerNeedsInput, continuationToken, flushUnconfirmedAnswers } from "../src/server/runtime/needs-input/answer";
import { readNeedsInputRecord, reportNeedsInput } from "../src/server/runtime/needs-input/report";
import type { IsolatedSendPort } from "../src/server/runtime/isolated-sdk/send-port";
import { toJson } from "../src/server/db/sql";
import { payloadWithoutRequestId } from "../src/server/services/request-identity";
import type { AnswerNeedsInputCommand, NeedsInputQuestion, ReportNeedsInputCommand } from "../src/shared/contracts";
import { seedRunningAttempt } from "./attempt-awaiting-review.test";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function openFileDb() {
  const dir = mkdtempSync(join(tmpdir(), "agy-answer-"));
  tempDirs.push(dir);
  return { db: openMigratedDatabase(new Database(join(dir, "agency.sqlite"))) };
}

function questions(processId: string, jobId: string, text = "Какой acceptance выполнять?"): NeedsInputQuestion[] {
  return [
    {
      id: "q1",
      text,
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

function reportDeps(opened: { db: ReturnType<typeof openMigratedDatabase> }, live: Awaited<ReturnType<typeof seedRunningAttempt>>) {
  return { db: opened.db, store: live.seeded.store, runs: live.runs, reads: live.reads };
}

async function seedWaiting() {
  const opened = openFileDb();
  const live = await seedRunningAttempt(opened.db);
  const deps = reportDeps(opened, live);
  const reported = reportNeedsInput(deps, live.seeded.ctx, reportCommand(live));
  if (!reported.ok) throw new Error(reported.error.message);
  return { opened, live, deps, reported: reported.value };
}

function contentPins(live: Awaited<ReturnType<typeof seedRunningAttempt>>) {
  const job = live.seeded.store.getJob(live.seeded.job.id)!;
  const department = live.seeded.store.getDepartment(job.departmentId)!;
  const process = live.seeded.store.getProcessVersion(department.processVersionId)!;
  return {
    expectedProcessVersionId: process.id,
    expectedSnapshotDigest: live.attempt.digest,
    expectedProcessInstructionsHash: sha256Hex(process.instructions),
    expectedProcessAcceptanceHash: sha256Hex(process.acceptance),
    expectedJobBriefHash: sha256Hex(job.brief),
    expectedJobAcceptanceHash: sha256Hex(job.acceptance),
  };
}

function answerCommand(
  live: Awaited<ReturnType<typeof seedRunningAttempt>>,
  reported: { jobRevision: number; attemptRevision: number; waitId: string },
  patch: Partial<AnswerNeedsInputCommand> = {},
): AnswerNeedsInputCommand {
  return {
    requestId: randomUUID(),
    jobId: live.seeded.job.id,
    expectedRevision: reported.jobRevision,
    attemptId: live.attempt.attemptId,
    expectedAttemptRevision: reported.attemptRevision,
    waitId: reported.waitId,
    launchId: live.receipt.launchId,
    threadId: live.receipt.threadId!,
    answers: [{ questionId: "q1", text: "Выполнять Job.acceptance." }],
    ...contentPins(live),
    ...patch,
  };
}

function confirmedSend(): IsolatedSendPort & { calls: Array<{ threadId: string; text: string }> } {
  const calls: Array<{ threadId: string; text: string }> = [];
  return {
    calls,
    async send(args) {
      calls.push(args);
      return { kind: "confirmed", delivery: "sent" };
    },
    async recoverContinuation() {
      return "absent";
    },
  };
}

describe("answerNeedsInput", () => {
  it("resolves the CLI alias and appends amendment after frozen awaiting_review", () => {
    expect(resolveAlias(["job", "answer-needs-input"])).toBe("answerNeedsInput");
    expect(migrations[AWAITING_REVIEW_MIGRATION_ID]).toContain("awaiting_review");
    expect(migrations.some((sql) => sql.includes("agency_job_needs_input_wait_one_open_idx"))).toBe(true);
  });

  it("resumes the same attempt after official send and does not accept or spawn", async () => {
    const { opened, live, deps, reported } = await seedWaiting();
    const send = confirmedSend();
    const input = answerCommand(live, reported);
    const answered = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, input);
    expect(answered.ok).toBe(true);
    if (!answered.ok) throw new Error(answered.error.message);
    expect(answered.value.sendState).toBe("confirmed");
    expect(answered.value.turnActive).toBe(true);
    expect(answered.value.amendment.processVersionId).toBe(live.seeded.processVersion.id);
    expect(answered.value.amendment.snapshotProcessVersionId).toBe(live.seeded.processVersion.id);
    expect(answered.value.jobState).toBe("running");
    expect(live.seeded.store.getJob(live.seeded.job.id)?.state).toBe("running");
    const attempt = live.reads.getAttempt(live.seeded.ctx, live.attempt.attemptId);
    expect(attempt.ok && attempt.value.state).toBe("running");
    expect(readNeedsInputRecord(opened.db, live.seeded.job.id)).toBeNull();
    expect(send.calls).toHaveLength(1);
    expect(send.calls[0]?.text).toContain(continuationToken(input.requestId));
    expect(send.calls[0]?.text).toContain(live.seeded.processVersion.instructions);
    const accepted = opened.db
      .prepare(`SELECT COUNT(*) AS n FROM agency_artifact_acceptance WHERE job_id = ?`)
      .get(live.seeded.job.id) as { n: number };
    expect(accepted.n).toBe(0);
    const replay = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, input);
    expect(replay.ok && replay.value).toEqual(answered.value);
    expect(send.calls).toHaveLength(1);
  });

  it("carries a verified process amendment when current process differs from the snapshot", async () => {
    const { live, deps, reported } = await seedWaiting();
    const send = confirmedSend();
    const stalePins = contentPins(live);
    const department = live.seeded.store.getDepartment(live.seeded.job.departmentId)!;
    const saved = live.seeded.store.saveDepartmentProfile(live.seeded.ctx, {
      requestId: randomUUID(),
      expectedRevision: department.revision,
      departmentId: department.id,
      name: department.name,
      leadAgentId: department.leadAgentId,
      process: {
        instructions: "Новый процесс после вопроса.",
        acceptance: "Другой критерий.",
        reviewPolicy: { required: true },
      },
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.message);
    const stale = await answerNeedsInput(
      { ...deps, send },
      live.seeded.ctx,
      answerCommand(live, reported, stalePins),
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("versions_changed");
    const answered = await answerNeedsInput(
      { ...deps, send },
      live.seeded.ctx,
      answerCommand(live, reported, contentPins(live)),
    );
    expect(answered.ok).toBe(true);
    if (!answered.ok) throw new Error(answered.error.message);
    expect(answered.value.amendment.processVersionId).toBe(saved.value.process.id);
    expect(answered.value.amendment.snapshotProcessVersionId).toBe(live.seeded.processVersion.id);
    expect(send.calls[0]?.text).toContain("Новый процесс после вопроса.");
    expect(send.calls[0]?.text).toContain(live.seeded.processVersion.id);
  });

  it("sends once on a fresh claim even when recover would be unknown", async () => {
    const { live, deps, reported } = await seedWaiting();
    let sends = 0;
    const send: IsolatedSendPort = {
      async send() {
        sends += 1;
        return { kind: "confirmed", delivery: "sent" };
      },
      async recoverContinuation() {
        return "unknown";
      },
    };
    const first = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, answerCommand(live, reported));
    expect(first.ok && first.value.sendState).toBe("confirmed");
    expect(sends).toBe(1);
  });

  it("resends after an unknown dispatch when the timeline reports absent", async () => {
    const { live, deps, reported } = await seedWaiting();
    let sends = 0;
    const send: IsolatedSendPort = {
      async send() {
        sends += 1;
        return sends === 1 ? { kind: "unknown", code: "send_transport", message: "timeout" } : { kind: "confirmed", delivery: "sent" };
      },
      async recoverContinuation() {
        return "absent";
      },
    };
    const input = answerCommand(live, reported);
    const first = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, input);
    expect(first.ok && first.value.sendState).toBe("unknown");
    expect(sends).toBe(1);
    const replay = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, input);
    expect(replay.ok && replay.value.sendState).toBe("confirmed");
    expect(sends).toBe(2);
  });

  it("does not resend when recover cannot see the timeline", async () => {
    const { live, deps, reported } = await seedWaiting();
    let sends = 0;
    const send: IsolatedSendPort = {
      async send() {
        sends += 1;
        return { kind: "unknown", code: "send_transport", message: "timeout" };
      },
      async recoverContinuation() {
        return "unknown";
      },
    };
    const input = answerCommand(live, reported);
    const first = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, input);
    expect(first.ok && first.value.sendState).toBe("unknown");
    expect(sends).toBe(1);
    const replay = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, input);
    expect(replay.ok && replay.value.sendState).toBe("needs_reconciliation");
    expect(sends).toBe(1);
  });

  it("supersedes an unconfirmed wait claim from another requestId", async () => {
    const { live, deps, reported } = await seedWaiting();
    let sends = 0;
    const send: IsolatedSendPort = {
      async send() {
        sends += 1;
        return sends === 1 ? { kind: "unknown", code: "send_transport", message: "timeout" } : { kind: "confirmed", delivery: "sent" };
      },
      async recoverContinuation() {
        return "absent";
      },
    };
    const first = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, answerCommand(live, reported));
    expect(first.ok && first.value.sendState).toBe("unknown");
    expect(sends).toBe(1);
    const second = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, answerCommand(live, reported));
    expect(second.ok && second.value.sendState).toBe("confirmed");
    expect(sends).toBe(2);
  });

  it("flushes an unknown owner answer into the worker thread", async () => {
    const { live, deps, reported } = await seedWaiting();
    let sends = 0;
    const send: IsolatedSendPort = {
      async send() {
        sends += 1;
        return sends === 1
          ? { kind: "unknown", code: "send_transport", message: "timeout" }
          : { kind: "confirmed", delivery: "sent" };
      },
      async recoverContinuation() {
        return "absent";
      },
    };
    const first = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, answerCommand(live, reported));
    expect(first.ok && first.value.sendState).toBe("unknown");
    await flushUnconfirmedAnswers({ ...deps, send }, live.seeded.ctx);
    expect(sends).toBe(2);
    expect(live.seeded.store.getJob(live.seeded.job.id)?.state).toBe("running");
  });

  it("resends a queued continuation after the BB queue dropped it", async () => {
    const { live, deps, reported } = await seedWaiting();
    let sends = 0;
    let presence: "queued" | "absent" = "queued";
    const send: IsolatedSendPort = {
      async send() {
        sends += 1;
        return sends === 1
          ? { kind: "confirmed", delivery: "queued", queuedMessageId: "qmsg_lost01" }
          : { kind: "confirmed", delivery: "sent" };
      },
      async recoverContinuation() {
        return presence;
      },
    };
    const input = answerCommand(live, reported);
    const queued = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, input);
    expect(queued.ok && queued.value.sendState).toBe("queued");
    expect(sends).toBe(1);
    presence = "absent";
    await flushUnconfirmedAnswers({ ...deps, send }, live.seeded.ctx);
    expect(sends).toBe(2);
    expect(live.seeded.store.getJob(live.seeded.job.id)?.state).toBe("running");
  });

  it("keeps queued as queue, not worker running, and stores rejected separately", async () => {
    const { live, deps, reported } = await seedWaiting();
    const queuedSend: IsolatedSendPort = {
      async send() {
        return { kind: "confirmed", delivery: "queued" };
      },
      async recoverContinuation() {
        return "unknown";
      },
    };
    const queued = await answerNeedsInput(
      { ...deps, send: queuedSend },
      live.seeded.ctx,
      answerCommand(live, reported),
    );
    expect(queued.ok).toBe(true);
    if (!queued.ok) throw new Error(queued.error.message);
    expect(queued.value.sendState).toBe("queued");
    expect(queued.value.turnActive).toBe(false);
    expect(queued.value.jobState).toBe("waiting_input");
    expect(live.seeded.store.getJob(live.seeded.job.id)?.state).toBe("waiting_input");
  });

  it("reconciles queued delivery without a second send", async () => {
    const { live, deps, reported } = await seedWaiting();
    let sends = 0;
    let presence: "queued" | "present" = "queued";
    const send: IsolatedSendPort = {
      async send() {
        sends += 1;
        return { kind: "confirmed", delivery: "queued", queuedMessageId: "qmsg_saved01" };
      },
      async recoverContinuation() {
        return presence;
      },
    };
    const input = answerCommand(live, reported);
    const queued = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, input);
    expect(queued.ok && queued.value.sendState).toBe("queued");
    expect(sends).toBe(1);
    const still = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, input);
    expect(still.ok && still.value.sendState).toBe("queued");
    expect(sends).toBe(1);
    presence = "present";
    const delivered = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, input);
    expect(delivered.ok && delivered.value.sendState).toBe("confirmed");
    expect(delivered.ok && delivered.value.jobState).toBe("running");
    expect(sends).toBe(1);
  });

  it("reopens a legacy queued agency_request via recover present without a second send", async () => {
    const { opened, live, deps, reported } = await seedWaiting();
    let sends = 0;
    let recovers = 0;
    let presence: "queued" | "present" = "queued";
    const send: IsolatedSendPort = {
      async send() {
        sends += 1;
        return { kind: "confirmed", delivery: "queued", queuedMessageId: "qmsg_legacy01" };
      },
      async recoverContinuation() {
        recovers += 1;
        return presence;
      },
    };
    const input = answerCommand(live, reported);
    const queued = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, input);
    expect(queued.ok && queued.value.sendState).toBe("queued");
    expect(sends).toBe(1);
    expect(recovers).toBe(0);
    opened.db
      .prepare(
        `INSERT INTO agency_request
          (request_id, kind, result_json, created_at, payload_json, actor_json, scope_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.requestId,
        "answerNeedsInput",
        toJson(queued),
        "2026-09-14T00:00:00.000Z",
        toJson(payloadWithoutRequestId(input)),
        toJson(live.seeded.ctx.actor),
        toJson([live.seeded.job.bindingId]),
      );
    const mismatched = await answerNeedsInput(
      { ...deps, send },
      live.seeded.ctx,
      { ...input, answers: [{ questionId: "q1", text: "Другое тело." }] },
    );
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.error.code).toBe("request_conflict");
    expect(sends).toBe(1);
    expect(recovers).toBe(0);
    const still = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, input);
    expect(still.ok && still.value.sendState).toBe("queued");
    expect(sends).toBe(1);
    expect(recovers).toBe(1);
    presence = "present";
    const delivered = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, input);
    expect(delivered.ok && delivered.value.sendState).toBe("confirmed");
    expect(delivered.ok && delivered.value.jobState).toBe("running");
    expect(sends).toBe(1);
    expect(recovers).toBe(2);
    const remembered = opened.db
      .prepare(`SELECT result_json FROM agency_request WHERE request_id = ?`)
      .get(input.requestId) as { result_json: string };
    expect(remembered.result_json).toContain('"sendState":"confirmed"');
    const replay = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, input);
    expect(replay.ok && replay.value.sendState).toBe("confirmed");
    expect(sends).toBe(1);
    expect(recovers).toBe(2);
    const conflict = await answerNeedsInput(
      { ...deps, send },
      live.seeded.ctx,
      { ...input, answers: [{ questionId: "q1", text: "Другое тело." }] },
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("request_conflict");
    expect(sends).toBe(1);
    expect(recovers).toBe(2);
  });

  it("rejects a second requestId on the same wait and does not send twice", async () => {
    const { live, deps, reported } = await seedWaiting();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sends = 0;
    const send: IsolatedSendPort = {
      async send() {
        sends += 1;
        await gate;
        return { kind: "confirmed", delivery: "sent" };
      },
      async recoverContinuation() {
        return "unknown";
      },
    };
    const firstInput = answerCommand(live, reported);
    const secondInput = answerCommand(live, reported);
    const first = answerNeedsInput({ ...deps, send }, live.seeded.ctx, firstInput);
    await vi.waitFor(() => expect(sends).toBe(1));
    const second = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, secondInput);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("request_conflict");
    release?.();
    const done = await first;
    expect(done.ok && done.value.sendState).toBe("confirmed");
    expect(sends).toBe(1);
  });

  it("reconciles without overwrite when pinned revisions change after send", async () => {
    const { live, deps, reported } = await seedWaiting();
    const send: IsolatedSendPort = {
      async send() {
        const job = live.seeded.store.getJob(live.seeded.job.id)!;
        const updated = live.seeded.store.updateJob(live.seeded.ctx, {
          requestId: randomUUID(),
          expectedRevision: job.revision,
          jobId: job.id,
          brief: "Бриф сменили во время send.",
        });
        if (!updated.ok) throw new Error(updated.error.message);
        return { kind: "confirmed", delivery: "sent" };
      },
      async recoverContinuation() {
        return "unknown";
      },
    };
    const answered = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, answerCommand(live, reported));
    expect(answered.ok).toBe(true);
    if (!answered.ok) throw new Error(answered.error.message);
    expect(answered.value.sendState).toBe("needs_reconciliation");
    expect(live.seeded.store.getJob(live.seeded.job.id)?.state).toBe("waiting_input");
    expect(live.seeded.store.getJob(live.seeded.job.id)?.brief).toBe("Бриф сменили во время send.");
  });

  it("keeps rejected distinct from unknown and does not resend", async () => {
    const { live, deps, reported } = await seedWaiting();
    let sends = 0;
    const send: IsolatedSendPort = {
      async send() {
        sends += 1;
        return { kind: "rejected", code: "sdk_send_unsupported", message: "no send" };
      },
      async recoverContinuation() {
        return "absent";
      },
    };
    const input = answerCommand(live, reported);
    const first = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, input);
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.code).toBe("sdk_send_unsupported");
    const replay = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, input);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe("sdk_send_unsupported");
    expect(sends).toBe(1);
  });

  it("resumes from recovered continuation after a claimed crash without a second send", async () => {
    const { live, deps, reported } = await seedWaiting();
    let sends = 0;
    const send: IsolatedSendPort = {
      async send() {
        sends += 1;
        return { kind: "unknown", code: "send_transport", message: "lost after dispatch" };
      },
      async recoverContinuation() {
        return "present";
      },
    };
    const input = answerCommand(live, reported);
    const first = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, input);
    expect(first.ok && first.value.sendState).toBe("unknown");
    const answered = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, input);
    expect(answered.ok && answered.value.sendState).toBe("confirmed");
    expect(sends).toBe(1);
    expect(live.seeded.store.getJob(live.seeded.job.id)?.state).toBe("running");
  });

  it("rejects unknown identity, stale CAS, versions_changed and snapshot_stale", async () => {
    const { live, deps, reported } = await seedWaiting();
    const send = confirmedSend();
    const unknown = await answerNeedsInput(
      { ...deps, send },
      live.seeded.ctx,
      answerCommand(live, reported, { threadId: "thr_wrongthread01" }),
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("unknown_identity");
    const stale = await answerNeedsInput(
      { ...deps, send },
      live.seeded.ctx,
      answerCommand(live, reported, { expectedRevision: 1 }),
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("revision_conflict");
    const digest = await answerNeedsInput(
      { ...deps, send },
      live.seeded.ctx,
      answerCommand(live, reported, { expectedSnapshotDigest: "aa".repeat(32) }),
    );
    expect(digest.ok).toBe(false);
    if (!digest.ok) expect(digest.error.code).toBe("snapshot_stale");
    const hash = await answerNeedsInput(
      { ...deps, send },
      live.seeded.ctx,
      answerCommand(live, reported, { expectedProcessInstructionsHash: "bb".repeat(32) }),
    );
    expect(hash.ok).toBe(false);
    if (!hash.ok) expect(hash.error.code).toBe("versions_changed");
  });

  it("serializes two SQLite connections on one wait to a single dispatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-answer-wal-"));
    tempDirs.push(dir);
    const path = join(dir, "agency.sqlite");
    const dbA = openMigratedDatabase(new Database(path));
    dbA.pragma("journal_mode = WAL");
    dbA.pragma("busy_timeout = 5000");
    const live = await seedRunningAttempt(dbA);
    const depsA = { db: dbA, store: live.seeded.store, runs: live.runs, reads: live.reads };
    const reported = reportNeedsInput(depsA, live.seeded.ctx, reportCommand(live));
    if (!reported.ok) throw new Error(reported.error.message);
    const dbB = openMigratedDatabase(new Database(path));
    dbB.pragma("busy_timeout = 5000");
    const { createDomainStore } = await import("../src/server/services");
    const { createInternalRunStoreReads, createRunStore } = await import("../src/server/runtime/run-store");
    const depsB = {
      db: dbB,
      store: createDomainStore(dbB),
      runs: createRunStore(dbB),
      reads: createInternalRunStoreReads(dbB),
    };
    let sends = 0;
    const send: IsolatedSendPort = {
      async send() {
        sends += 1;
        return { kind: "confirmed", delivery: "sent" };
      },
      async recoverContinuation() {
        return "unknown";
      },
    };
    const first = answerCommand(live, reported.value);
    const second = answerCommand(live, reported.value);
    const [a, b] = await Promise.all([
      answerNeedsInput({ ...depsA, send }, live.seeded.ctx, first),
      answerNeedsInput({ ...depsB, send }, live.seeded.ctx, second),
    ]);
    const oks = [a, b].filter((row) => row.ok);
    const conflicts = [a, b].filter((row) => !row.ok && !row.ok && row.error.code === "request_conflict");
    expect(sends).toBe(1);
    expect(oks.length).toBe(1);
    expect(conflicts.length + oks.length).toBe(2);
    dbA.close();
    dbB.close();
  });

  it("runs two full wait cycles and ignores an old requestId against the new wait", async () => {
    const { opened, live, deps, reported } = await seedWaiting();
    const firstWaitId = reported.waitId;
    const send = confirmedSend();
    const firstInput = answerCommand(live, reported);
    const first = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, firstInput);
    expect(first.ok && first.value.waitId).toBe(firstWaitId);
    expect(live.seeded.store.getJob(live.seeded.job.id)?.state).toBe("running");
    const closed = opened.db
      .prepare(`SELECT closed_at FROM agency_job_needs_input_wait WHERE wait_id = ?`)
      .get(firstWaitId) as { closed_at: string | null };
    expect(closed.closed_at).toBeTruthy();

    const secondReport = reportNeedsInput(
      deps,
      live.seeded.ctx,
      reportCommand(live, {
        questions: questions(live.seeded.processVersion.id, live.seeded.job.id).map((item) => ({
          ...item,
          id: "q2",
          text: "Какой файл публиковать?",
        })),
      }),
    );
    expect(secondReport.ok).toBe(true);
    if (!secondReport.ok) throw new Error(secondReport.error.message);
    expect(secondReport.value.waitId).not.toBe(firstWaitId);
    expect(live.seeded.store.getJob(live.seeded.job.id)?.state).toBe("waiting_input");
    expect(readNeedsInputRecord(opened.db, live.seeded.job.id)?.waitId).toBe(secondReport.value.waitId);

    const oldReplay = await answerNeedsInput({ ...deps, send }, live.seeded.ctx, firstInput);
    expect(oldReplay.ok && oldReplay.value).toEqual(first.ok ? first.value : null);
    expect(send.calls).toHaveLength(1);
    expect(live.seeded.store.getJob(live.seeded.job.id)?.state).toBe("waiting_input");
    expect(readNeedsInputRecord(opened.db, live.seeded.job.id)?.waitId).toBe(secondReport.value.waitId);

    const second = await answerNeedsInput(
      { ...deps, send },
      live.seeded.ctx,
      answerCommand(live, secondReport.value, { answers: [{ questionId: "q2", text: "notes/job-file.md" }] }),
    );
    expect(second.ok && second.value.sendState).toBe("confirmed");
    expect(second.ok && second.value.waitId).toBe(secondReport.value.waitId);
    expect(live.seeded.store.getJob(live.seeded.job.id)?.state).toBe("running");
    expect(readNeedsInputRecord(opened.db, live.seeded.job.id)).toBeNull();
    expect(send.calls).toHaveLength(2);
    const history = opened.db
      .prepare(`SELECT COUNT(*) AS n FROM agency_job_needs_input_wait WHERE job_id = ?`)
      .get(live.seeded.job.id) as { n: number };
    expect(history.n).toBe(2);
  });

  it("serializes two SQLite connections opening a new wait after resume", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-wait-wal-"));
    tempDirs.push(dir);
    const path = join(dir, "agency.sqlite");
    const dbA = openMigratedDatabase(new Database(path));
    dbA.pragma("journal_mode = WAL");
    dbA.pragma("busy_timeout = 5000");
    const live = await seedRunningAttempt(dbA);
    const depsA = { db: dbA, store: live.seeded.store, runs: live.runs, reads: live.reads };
    const firstReport = reportNeedsInput(depsA, live.seeded.ctx, reportCommand(live));
    if (!firstReport.ok) throw new Error(firstReport.error.message);
    const send = confirmedSend();
    const answered = await answerNeedsInput(
      { ...depsA, send },
      live.seeded.ctx,
      answerCommand(live, firstReport.value),
    );
    expect(answered.ok && answered.value.sendState).toBe("confirmed");
    const dbB = openMigratedDatabase(new Database(path));
    dbB.pragma("busy_timeout = 5000");
    const { createDomainStore } = await import("../src/server/services");
    const { createInternalRunStoreReads, createRunStore } = await import("../src/server/runtime/run-store");
    const depsB = {
      db: dbB,
      store: createDomainStore(dbB),
      runs: createRunStore(dbB),
      reads: createInternalRunStoreReads(dbB),
    };
    const qA = reportCommand(live, {
      questions: questions(live.seeded.processVersion.id, live.seeded.job.id, "Первый новый вопрос?"),
    });
    const qB = reportCommand(live, {
      questions: questions(live.seeded.processVersion.id, live.seeded.job.id, "Второй новый вопрос?"),
    });
    const [a, b] = await Promise.all([
      Promise.resolve(reportNeedsInput(depsA, live.seeded.ctx, qA)),
      Promise.resolve(reportNeedsInput(depsB, live.seeded.ctx, qB)),
    ]);
    const oks = [a, b].filter((row) => row.ok);
    const conflicts = [a, b].filter(
      (row) => !row.ok && (row.error.code === "request_conflict" || row.error.code === "revision_conflict"),
    );
    expect(oks.length).toBe(1);
    expect(conflicts.length).toBe(1);
    const open = dbA
      .prepare(`SELECT COUNT(*) AS n FROM agency_job_needs_input_wait WHERE job_id = ? AND closed_at IS NULL`)
      .get(live.seeded.job.id) as { n: number };
    const all = dbA
      .prepare(`SELECT COUNT(*) AS n FROM agency_job_needs_input_wait WHERE job_id = ?`)
      .get(live.seeded.job.id) as { n: number };
    expect(open.n).toBe(1);
    expect(all.n).toBe(2);
    dbA.close();
    dbB.close();
  });
});
