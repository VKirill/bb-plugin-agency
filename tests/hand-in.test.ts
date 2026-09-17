import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { handInCommentMissing } from "../src/server/runtime/hand-in/service";
import { remindIncompleteWorker, type ReminderPorts } from "../src/server/runtime/completion-reminder/service";
import { seed } from "./role-types.test";

function setup() {
  const db = openMigratedDatabase(new Database(":memory:"));
  const s = seed(db);
  const job = s.job("Сдача", s.developer);
  s.attempt(job.id, "running");
  // The attempt started before any comment of the test.
  db.prepare(`UPDATE agency_run_attempt SET created_at = '2000-01-01T00:00:00.000Z' WHERE job_id = ?`).run(job.id);
  const comment = (agentId: string | null, references: { type: string; id: string }[] = []) => {
    const actor = agentId ? ({ kind: "agent", agentId } as const) : ({ kind: "system" } as const);
    const created = s.store.createActivity(
      { ...s.ctx, actor },
      { requestId: randomUUID(), jobId: job.id, actor, kind: "comment", causationId: null, references: references as never, comment: "Итог." },
    );
    if (!created.ok) throw new Error(created.error.message);
  };
  return { db, s, job, comment };
}

describe("hand-in closing comment", () => {
  it("needs a comment from the assigned employee since the attempt started", () => {
    const { db, s, job, comment } = setup();
    expect(handInCommentMissing(db, job.id)).toBe(true);
    comment(null);
    comment(s.reviewer);
    expect(handInCommentMissing(db, job.id)).toBe(true);
    comment(s.developer, [
      { type: "intake_size", id: "S" },
      { type: "intake_risk", id: "low" },
      { type: "intake_decision", id: "accept" },
    ]);
    expect(handInCommentMissing(db, job.id)).toBe(true);
    comment(s.developer);
    expect(handInCommentMissing(db, job.id)).toBe(false);
  });

  it("asks again after a return for rework", () => {
    const { db, s, job, comment } = setup();
    comment(s.developer);
    expect(handInCommentMissing(db, job.id)).toBe(false);
    db.prepare(
      `INSERT INTO agency_rework (request_id, job_id, attempt_id, thread_id, returned_hash, comment, send_state, created_at, updated_at)
       VALUES (?, ?, ?, 'thr_fixture01', ?, 'Доработать.', 'sent', ?, ?)`,
    ).run(randomUUID(), job.id, `run_${job.id}`, "ab".repeat(32), "2999-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z");
    expect(handInCommentMissing(db, job.id)).toBe(true);
  });

  it("has nothing to check without a working attempt", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    expect(handInCommentMissing(db, s.job("Без попытки", s.developer).id)).toBe(false);
  });

  it("reminds about the comment, not the version, when only the comment is missing", async () => {
    const { db, s, job } = setup();
    const sent: string[] = [];
    let now = "2026-09-17T10:00:00.000Z";
    const ports: ReminderPorts = {
      db,
      getJob: () => ({ ...job, state: "running" }),
      openChildren: () => 0,
      attemptForLaunch: () => ({ id: `run_${job.id}`, state: "running" }),
      send: async (_thread, text) => {
        sent.push(text);
        return { kind: "sent" } as never;
      },
      block: () => true,
      now: () => now,
    };
    const row = { threadId: "thr_fixture01", jobId: job.id, launchId: "launch" };
    const reading = { threadStatus: "idle", publishedVerified: false, missing: "comment" as const };
    expect(await remindIncompleteWorker(ports, row, reading)).toBe("waiting");
    now = "2026-09-17T10:01:00.000Z";
    expect(await remindIncompleteWorker(ports, row, reading)).toBe("sent");
    expect(sent[0]).toContain("there is no closing comment for the lead");
    expect(s.store.getJob(job.id)?.state).not.toBe("review");
  });
});
