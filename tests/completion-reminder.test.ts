import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import {
  COMPLETION_REMINDER_IDLE_MS,
  COMPLETION_REMINDER_LIMIT,
  COMPLETION_REMINDER_RETRY_MS,
  completionWaitingDependencies,
  handInCommentReminderText,
  remindIncompleteWorker,
  type ReminderPorts,
} from "../src/server/runtime/completion-reminder/service";
import { seed } from "./role-types.test";
import { PROMPT_PRECEDENCE_JOB } from "../src/server/runtime/context-snapshot/prompt-precedence";
import type { Job } from "../src/shared/contracts";

const job: Job = {
  id: "job_worker0001",
  key: "AG-501",
  bindingId: "bnd_aaaaaaaa",
  departmentId: "dep_aaaaaaaa",
  title: "Реализация",
  brief: "Бриф.",
  acceptance: "Критерий.",
  state: "running",
  parentJobId: "job_parent0001",
  assignedAgentId: "agt_dev00001",
  priority: "normal",
  dueAt: null,
  revision: 3,
  updatedAt: "2026-09-16T10:00:00.000Z",
};

function harness(overrides: Partial<ReminderPorts> = {}) {
  const db = openMigratedDatabase(new Database(":memory:"));
  let clock = Date.parse("2026-09-16T10:00:00.000Z");
  const sent: string[] = [];
  const blocked: string[] = [];
  let current = { ...job };
  const ports: ReminderPorts = {
    db,
    getJob: () => current,
    openChildren: () => 0,
    attemptForLaunch: () => ({ id: "run_attempt0001", state: "running" }),
    send: async (_threadId, text) => {
      sent.push(text);
      return { kind: "confirmed", delivery: "sent" };
    },
    block: (_job, comment) => {
      blocked.push(comment);
      current = { ...current, state: "blocked" };
      return true;
    },
    now: () => new Date(clock).toISOString(),
    ...overrides,
  };
  const tick = (ms: number) => {
    clock += ms;
  };
  const row = { threadId: "thr_worker0001", jobId: job.id, launchId: "launch-1" };
  return { db, ports, sent, blocked, tick, row };
}

const idle = { threadStatus: "idle", publishedVerified: false };
const working = { threadStatus: "running", publishedVerified: false };

describe("completion reminder", () => {
  it("waits for a settled idle, reminds with the hand-in steps, then blocks after the limit", async () => {
    const h = harness();
    expect(await remindIncompleteWorker(h.ports, h.row, idle)).toBe("waiting");
    h.tick(5_000);
    expect(await remindIncompleteWorker(h.ports, h.row, idle)).toBe("waiting");
    h.tick(COMPLETION_REMINDER_IDLE_MS);
    expect(await remindIncompleteWorker(h.ports, h.row, idle)).toBe("sent");
    expect(h.sent[0]).toContain("AG-501 is idle");
    expect(h.sent[0]).toContain(".agency/jobs/AG-501/report.md");
    expect(h.sent[0]).toContain("bb agency job submit");
    expect(h.sent[0]).toContain("Wake-up 1/2");
    expect(h.sent[0]).toContain("Do not submit a partial result");

    // Still idle right after the reminder: no second message until the worker takes a turn.
    h.tick(30_000);
    expect(await remindIncompleteWorker(h.ports, h.row, idle)).toBe("waiting");
    expect(h.sent).toHaveLength(1);

    for (let round = 2; round <= COMPLETION_REMINDER_LIMIT; round += 1) {
      h.tick(COMPLETION_REMINDER_RETRY_MS);
      await remindIncompleteWorker(h.ports, h.row, idle);
      h.tick(COMPLETION_REMINDER_IDLE_MS + 1_000);
      expect(await remindIncompleteWorker(h.ports, h.row, idle)).toBe("sent");
    }
    expect(h.sent).toHaveLength(COMPLETION_REMINDER_LIMIT);

    h.tick(COMPLETION_REMINDER_RETRY_MS);
    await remindIncompleteWorker(h.ports, h.row, idle);
    h.tick(COMPLETION_REMINDER_IDLE_MS + 1_000);
    expect(await remindIncompleteWorker(h.ports, h.row, idle)).toBe("blocked");
    expect(h.blocked[0]).toContain("возобновление работы не наблюдалось");
    expect(await remindIncompleteWorker(h.ports, h.row, idle)).toBe("skipped");
    h.db.close();
  });

  it("leaves a published result, a waiting lead and a finished attempt alone", async () => {
    const published = harness();
    published.tick(COMPLETION_REMINDER_IDLE_MS * 2);
    expect(await remindIncompleteWorker(published.ports, published.row, { threadStatus: "idle", publishedVerified: true })).toBe("skipped");

    const lead = harness({ openChildren: () => 2 });
    await remindIncompleteWorker(lead.ports, lead.row, idle);
    lead.tick(COMPLETION_REMINDER_IDLE_MS * 2);
    expect(await remindIncompleteWorker(lead.ports, lead.row, idle)).toBe("skipped");
    expect(lead.sent).toHaveLength(0);

    const done = harness({ attemptForLaunch: () => ({ id: "run_attempt0001", state: "succeeded" }) });
    expect(await remindIncompleteWorker(done.ports, done.row, idle)).toBe("skipped");
  });
  it("does not treat productive turns as a two-turn deadline, including a published intermediate version", async () => {
    const h = harness();
    for (let turn = 0; turn < 5; turn++) {
      await remindIncompleteWorker(h.ports, h.row, { ...idle, missing: "comment" });
      h.tick(COMPLETION_REMINDER_IDLE_MS + 1);
      expect(await remindIncompleteWorker(h.ports, h.row, { ...idle, missing: "comment" })).toBe("sent");
      expect(h.sent.at(-1)).toContain("Wake-up 1/2");
      expect(await remindIncompleteWorker(h.ports, h.row, working)).toBe("resumed");
    }
    expect(h.blocked).toHaveLength(0);
    expect(handInCommentReminderText(job.key, "run_a", 2, "en")).toContain("Only when the full acceptance is met");
    expect(PROMPT_PRECEDENCE_JOB).toContain("bb agency job submit");
    expect(PROMPT_PRECEDENCE_JOB).not.toContain("post a final bb agency job comment");
    h.db.close();
  });

  it("clears an old wake episode while waiting for exact inputs, then resumes once they arrive", async () => {
    let pending = false;
    const h = harness({ waitingDependencies: () => pending ? ["job_source"] : [] });
    await remindIncompleteWorker(h.ports, h.row, idle);
    h.tick(COMPLETION_REMINDER_IDLE_MS + 1);
    await remindIncompleteWorker(h.ports, h.row, idle);
    pending = true;
    expect(await remindIncompleteWorker(h.ports, h.row, idle)).toBe("dependency_wait");
    h.tick(COMPLETION_REMINDER_RETRY_MS * 3);
    expect(await remindIncompleteWorker(h.ports, h.row, idle)).toBe("skipped");
    expect(h.sent).toHaveLength(1);
    pending = false;
    await remindIncompleteWorker(h.ports, h.row, idle);
    h.tick(COMPLETION_REMINDER_IDLE_MS + 1);
    expect(await remindIncompleteWorker(h.ports, h.row, idle)).toBe("sent");
    expect(h.sent.at(-1)).toContain("Wake-up 1/2");
    expect(h.blocked).toHaveLength(0);
    h.db.close();
  });

  it("a same-attempt authorized recovery clears the old blocked episode; an unknown status does not answer a wake-up", async () => {
    const h = harness();
    h.db.prepare(`INSERT INTO agency_completion_reminder
      (attempt_id,job_id,count,blocked_at,updated_at) VALUES ('run_attempt0001',?,2,?,?)`)
      .run(job.id, job.updatedAt, job.updatedAt);
    expect(await remindIncompleteWorker(h.ports, h.row, idle)).toBe("waiting");
    h.tick(COMPLETION_REMINDER_IDLE_MS + 1);
    expect(await remindIncompleteWorker(h.ports, h.row, idle)).toBe("sent");
    expect(h.sent[0]).toContain("Wake-up 1/2");
    expect(await remindIncompleteWorker(h.ports, h.row, { ...idle, threadStatus: null })).toBe("skipped");
    expect(h.db.prepare("SELECT count FROM agency_completion_reminder").get()).toEqual({ count: 1 });
    h.db.close();
  });

  it("waits for a reviewer's concrete sources, not its parent, unrelated siblings or completed submission", () => {
    const h = harness();
    const s = seed(h.db);
    const root = s.job("Plan", s.lead);
    const a = s.job("A", s.developer);
    const b = s.job("B", s.developer);
    const review = s.job("Review A/B", s.reviewer);
    const unrelated = s.job("Other", s.developer);
    h.db.prepare("UPDATE agency_job SET state = 'running'").run();
    h.db.prepare("UPDATE agency_job SET parent_job_id = ? WHERE id != ?").run(root.id, root.id);
    s.input(review.id, root.id); s.input(review.id, a.id); s.input(review.id, b.id);
    const r = s.store.getJob(review.id)!;
    expect(completionWaitingDependencies(h.db, r).sort()).toEqual([a.id, b.id].sort());
    h.db.prepare("UPDATE agency_job SET state = 'review' WHERE id = ?").run(a.id);
    h.db.prepare("UPDATE agency_job SET state = 'done' WHERE id = ?").run(b.id);
    expect(completionWaitingDependencies(h.db, r)).toEqual([]);
    // Executor inputs may be historical or partial; they are not automatic hard waits.
    s.input(unrelated.id, root.id);
    expect(completionWaitingDependencies(h.db, s.store.getJob(unrelated.id)!)).toEqual([]);
    h.db.prepare("INSERT INTO agency_job_dependency (job_id, depends_on_job_id) VALUES (?, ?)").run(unrelated.id, a.id);
    expect(completionWaitingDependencies(h.db, s.store.getJob(unrelated.id)!)).toEqual([a.id]);
    h.db.close();
  });

});
