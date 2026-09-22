import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrations } from "../src/server/db/migrations";
import { openMigratedDatabase } from "../src/server/db";
import {
  composeReviewFollowUp,
  findReviewerThread,
  markReviewerThreadDead,
  rememberReviewerThread,
  resolveReviewLine,
  REVIEWER_THREAD_MIGRATION,
  reviewFollowUpToken,
} from "../src/server/runtime/reviewer-thread/service";
import { seed } from "./role-types.test";

function setup() {
  const db = openMigratedDatabase(new Database(":memory:"));
  const s = seed(db);
  const main = s.job("Главная", s.lead);
  const work = (title: string) => {
    const created = s.store.createJob(s.ctx, {
      requestId: randomUUID(),
      bindingId: s.ctx.allowedBindingIds[0]!,
      departmentId: s.departmentId,
      title,
      brief: `Бриф ${title}.`,
      acceptance: `Критерий ${title}.`,
      parentJobId: main.id,
      assignedAgentId: s.developer,
      priority: "normal",
      dueAt: null,
    });
    if (!created.ok) throw new Error(created.error.message);
    return created.value;
  };
  const review = (title: string) => {
    const created = s.store.createJob(s.ctx, {
      requestId: randomUUID(),
      bindingId: s.ctx.allowedBindingIds[0]!,
      departmentId: s.departmentId,
      title,
      brief: `Бриф ${title}.`,
      acceptance: `Критерий ${title}.`,
      parentJobId: main.id,
      assignedAgentId: s.reviewer,
      priority: "normal",
      dueAt: null,
    });
    if (!created.ok) throw new Error(created.error.message);
    return created.value;
  };
  const linkReview = (workJobId: string, reviewJobId: string, hash = "aa".repeat(32)) => {
    db.prepare(
      `INSERT INTO agency_auto_review (job_id, hash, review_job_id, outcome, created_at) VALUES (?, ?, ?, 'queued', '2026-09-22T00:00:00.000Z')`,
    ).run(workJobId, hash, reviewJobId);
  };
  return { db, s, main, work, review, linkReview };
}

describe("REVIEWER_THREAD_MIGRATION", () => {
  it("is appended last and creates the table", () => {
    expect(migrations[migrations.length - 1]).toBe(REVIEWER_THREAD_MIGRATION);
    const db = openMigratedDatabase(new Database(":memory:"));
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(
      (row) => row.name,
    );
    expect(names).toContain("agency_reviewer_thread");
    db.close();
  });
});

describe("resolveReviewLine", () => {
  it("walks W0 → R0 → W1 → R1 to the same root W0", () => {
    const t = setup();
    const w0 = t.work("Реализация");
    const r0 = t.review("Проверка 0");
    const w1 = t.work("Доработка");
    const r1 = t.review("Проверка 1");
    t.linkReview(w0.id, r0.id, "11".repeat(32));
    t.linkReview(w1.id, r1.id, "22".repeat(32));
    t.s.input(w1.id, r0.id);
    expect(resolveReviewLine(t.db, r0.id)).toBe(w0.id);
    expect(resolveReviewLine(t.db, r1.id)).toBe(w0.id);
    t.db.close();
  });

  it("gives another sibling work job without an input chain its own line", () => {
    const t = setup();
    const w0 = t.work("Реализация A");
    const r0 = t.review("Проверка A");
    const wOther = t.work("Реализация B");
    const rOther = t.review("Проверка B");
    t.linkReview(w0.id, r0.id);
    t.linkReview(wOther.id, rOther.id, "bb".repeat(32));
    expect(resolveReviewLine(t.db, r0.id)).toBe(w0.id);
    expect(resolveReviewLine(t.db, rOther.id)).toBe(wOther.id);
    expect(w0.id).not.toBe(wOther.id);
    t.db.close();
  });

  it("returns null for a job that is not an auto-review", () => {
    const t = setup();
    const w0 = t.work("Реализация");
    expect(resolveReviewLine(t.db, w0.id)).toBeNull();
    expect(resolveReviewLine(t.db, t.main.id)).toBeNull();
    t.db.close();
  });

  it("does not loop when inputs form a cycle", () => {
    const t = setup();
    const wA = t.work("Работа A");
    const rA = t.review("Проверка A");
    const wB = t.work("Работа B");
    const rB = t.review("Проверка B");
    t.linkReview(wA.id, rA.id, "c1".repeat(32));
    t.linkReview(wB.id, rB.id, "c2".repeat(32));
    t.s.input(wA.id, rB.id);
    t.s.input(wB.id, rA.id);
    const started = Date.now();
    const line = resolveReviewLine(t.db, rA.id);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect([wA.id, wB.id]).toContain(line);
    t.db.close();
  });
});

describe("reviewer thread registry", () => {
  it("finds a live row, hides a dead one, and comes back live after a new thread", () => {
    const t = setup();
    const lineJobId = "job_line0001";
    const reviewer = t.s.reviewer;
    expect(findReviewerThread(t.db, reviewer, lineJobId)).toBeNull();
    const first = rememberReviewerThread(t.db, {
      reviewerAgentId: reviewer,
      lineJobId,
      threadId: "thr_first0001",
      launchId: "lch_first0001",
      attemptId: "att_first0001",
      jobId: "job_review01",
      now: "2026-09-22T01:00:00.000Z",
    });
    expect(first).toMatchObject({
      threadId: "thr_first0001",
      originLaunchId: "lch_first0001",
      originAttemptId: "att_first0001",
      originJobId: "job_review01",
      state: "live",
      lastJobId: "job_review01",
    });
    expect(findReviewerThread(t.db, reviewer, lineJobId)?.threadId).toBe("thr_first0001");
    markReviewerThreadDead(t.db, reviewer, lineJobId, "thread_gone", "2026-09-22T01:05:00.000Z");
    expect(findReviewerThread(t.db, reviewer, lineJobId)).toBeNull();
    const again = rememberReviewerThread(t.db, {
      reviewerAgentId: reviewer,
      lineJobId,
      threadId: "thr_second002",
      launchId: "lch_second002",
      attemptId: "att_second002",
      jobId: "job_review02",
      now: "2026-09-22T01:10:00.000Z",
    });
    expect(again).toMatchObject({
      threadId: "thr_second002",
      originLaunchId: "lch_second002",
      originAttemptId: "att_second002",
      originJobId: "job_review02",
      state: "live",
      deadReason: null,
      lastJobId: "job_review02",
      createdAt: "2026-09-22T01:00:00.000Z",
    });
    expect(findReviewerThread(t.db, reviewer, lineJobId)?.threadId).toBe("thr_second002");
    t.db.close();
  });
});

describe("composeReviewFollowUp", () => {
  it("puts key, hash, pack path and token in the follow-up text", () => {
    const hash = "de".repeat(32);
    const packDir = ".agency/jobs/AG-153";
    const text = composeReviewFollowUp(
      {
        job: {
          key: "AG-153",
          title: "Повторная проверка линии",
          brief: "Проверить доработку.",
          acceptance: "Вердикт и критерии.",
        },
        packDir,
        version: { hash, version: 3 },
        attemptId: "att_follow01",
      },
      "ru",
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe("AG-153: Повторная проверка линии");
    expect(lines.at(-1)).toBe(reviewFollowUpToken("att_follow01"));
    expect(text).toContain("AG-153");
    expect(text).toContain(hash);
    expect(text).toContain(packDir);
    expect(text).toContain("agency.review-followup:att_follow01");
    expect(text).toContain(`${packDir}/report.md`);
    const en = composeReviewFollowUp(
      {
        job: {
          key: "AG-153",
          title: "Repeat line review",
          brief: "Review the rework.",
          acceptance: "Verdict and criteria.",
        },
        packDir,
        version: { hash, version: 3 },
        attemptId: "att_follow01",
      },
      "en",
    );
    expect(en.split("\n")[0]).toBe("AG-153: Repeat line review");
    expect(en.split("\n").at(-1)).toBe("agency.review-followup:att_follow01");
    expect(en).toContain(hash);
    expect(en).toContain(packDir);
  });
});
