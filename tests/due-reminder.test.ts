import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { dueReminderFor, sweepDueReminders, type DuePorts } from "../src/server/runtime/due-reminder/service";
import type { Job } from "../src/shared/contracts";
import { seed } from "./role-types.test";

function setup(dueAt: string) {
  const db = openMigratedDatabase(new Database(":memory:"));
  const s = seed(db);
  const created = s.store.createJob(s.ctx, {
    requestId: crypto.randomUUID(),
    bindingId: s.ctx.allowedBindingIds[0]!,
    departmentId: s.departmentId,
    title: "Со сроком",
    brief: "Бриф.",
    acceptance: "Критерий.",
    parentJobId: null,
    assignedAgentId: s.developer,
    priority: "normal",
    dueAt,
  });
  if (!created.ok) throw new Error(created.error.message);
  let job: Job = created.value;
  const comments: string[] = [];
  const sent: [string, string][] = [];
  let now = new Date("2026-09-17T08:00:00.000Z");
  const ports: DuePorts = {
    db,
    listDueJobs: () => [job],
    reminderHours: () => 24,
    comment: (_job, text) => {
      comments.push(text);
      return true;
    },
    workingThread: () => "thr_worker01",
    send: vi.fn(async (threadId: string, text: string) => {
      sent.push([threadId, text]);
    }),
    now: () => now,
  };
  return {
    ports,
    comments,
    sent,
    setNow: (value: string) => {
      now = new Date(value);
    },
    setDue: (value: string) => {
      job = { ...job, dueAt: value };
    },
  };
}

describe("due reminders", () => {
  it("decides by the department window and the due instant", () => {
    const due = { dueAt: "2026-09-18T12:00:00.000Z" };
    expect(dueReminderFor(due, 24, new Date("2026-09-17T11:00:00.000Z"))).toBe(null);
    expect(dueReminderFor(due, 24, new Date("2026-09-17T12:00:00.000Z"))).toBe("soon");
    expect(dueReminderFor(due, 0, new Date("2026-09-18T11:00:00.000Z"))).toBe(null);
    expect(dueReminderFor(due, 0, new Date("2026-09-18T12:00:00.000Z"))).toBe("overdue");
    expect(dueReminderFor({ dueAt: null }, 24, new Date())).toBe(null);
  });

  it("reminds once before the date and once after it, and starts over for a new date", async () => {
    const t = setup("2026-09-18T00:00:00.000Z");
    expect(await sweepDueReminders(t.ports)).toBe(1);
    expect(await sweepDueReminders(t.ports)).toBe(0);
    expect(t.comments[0]).toContain("осталось 16 ч");
    expect(t.sent[0]).toEqual(["thr_worker01", expect.stringContaining("до срока")]);

    t.setNow("2026-09-18T01:00:00.000Z");
    expect(await sweepDueReminders(t.ports)).toBe(1);
    expect(await sweepDueReminders(t.ports)).toBe(0);
    expect(t.comments[1]).toContain("прошёл: задача просрочена");

    t.setDue("2026-09-20T00:00:00.000Z");
    t.setNow("2026-09-19T06:00:00.000Z");
    expect(await sweepDueReminders(t.ports)).toBe(1);
    expect(t.comments).toHaveLength(3);
  });

  it("comments without a thread when nobody is working on the job", async () => {
    const t = setup("2026-09-17T09:00:00.000Z");
    t.ports.workingThread = () => null;
    expect(await sweepDueReminders(t.ports)).toBe(1);
    expect(t.sent).toEqual([]);
    expect(t.comments).toHaveLength(1);
  });
});
