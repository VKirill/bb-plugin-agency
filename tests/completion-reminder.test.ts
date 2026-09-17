import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import {
  COMPLETION_REMINDER_IDLE_MS,
  COMPLETION_REMINDER_LIMIT,
  remindIncompleteWorker,
  type ReminderPorts,
} from "../src/server/runtime/completion-reminder/service";
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
    expect(h.sent[0]).toContain("AG-501 не сдано");
    expect(h.sent[0]).toContain(".agency/jobs/AG-501/report.md");
    expect(h.sent[0]).toContain("bb agency job comment");
    expect(h.sent[0]).toContain("напоминание 1 из 2");

    // Still idle right after the reminder: no second message until the worker takes a turn.
    h.tick(30_000);
    expect(await remindIncompleteWorker(h.ports, h.row, idle)).toBe("waiting");
    expect(h.sent).toHaveLength(1);

    for (let round = 2; round <= COMPLETION_REMINDER_LIMIT; round += 1) {
      await remindIncompleteWorker(h.ports, h.row, working);
      await remindIncompleteWorker(h.ports, h.row, idle);
      h.tick(COMPLETION_REMINDER_IDLE_MS + 1_000);
      expect(await remindIncompleteWorker(h.ports, h.row, idle)).toBe("sent");
    }
    expect(h.sent).toHaveLength(COMPLETION_REMINDER_LIMIT);

    await remindIncompleteWorker(h.ports, h.row, working);
    await remindIncompleteWorker(h.ports, h.row, idle);
    h.tick(COMPLETION_REMINDER_IDLE_MS + 1_000);
    expect(await remindIncompleteWorker(h.ports, h.row, idle)).toBe("blocked");
    expect(h.blocked[0]).toContain("без опубликованного результата");
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
});
