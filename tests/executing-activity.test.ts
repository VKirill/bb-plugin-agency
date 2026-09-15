import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { openMigratedDatabase, type SqlDatabase } from "../src/server/db";
import {
  countExecutingJobs,
  countInProgressJobs,
  listBoundExecutingCandidates,
  listRunningJobIds,
  type BoundExecutingCandidate,
  type BoundThreadView,
} from "../src/server/runtime/executing-activity";
import { seedRunningAttempt } from "./attempt-awaiting-review.test";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function openFileDb() {
  const dir = mkdtempSync(join(tmpdir(), "agy-exec-"));
  tempDirs.push(dir);
  const db = openMigratedDatabase(new Database(join(dir, "agency.sqlite")));
  return { db, close: () => db.close() };
}

function candidate(overrides: Partial<BoundExecutingCandidate> = {}): BoundExecutingCandidate {
  return {
    jobId: "job_aaaaaaaaaaaa",
    attemptId: "run_aaaaaaaaaaaa",
    launchId: "11111111-1111-4111-8111-111111111111",
    threadId: "thr_active000001",
    ...overrides,
  };
}

function boundView(row: BoundExecutingCandidate, status = "active"): BoundThreadView {
  return {
    id: row.threadId,
    status,
    experimental_callerJobId: row.jobId,
    experimental_callerLaunchId: row.launchId,
    experimental_callerAttemptId: row.attemptId,
  };
}

describe("countExecutingJobs", () => {
  it("returns available true and zero when there are no candidates", async () => {
    let gets = 0;
    const result = await countExecutingJobs({
      listCandidates: () => [],
      getThread: async () => {
        gets += 1;
        throw new Error("must not get");
      },
    });
    expect(result).toEqual({ available: true, executingJobCount: 0 });
    expect(gets).toBe(0);
  });

  it("counts distinct active verified binds and skips idle or starting", async () => {
    const first = candidate();
    const idle = candidate({ jobId: "job_bbbbbbbbbbbb", attemptId: "run_bbbbbbbbbbbb", threadId: "thr_idle00000002" });
    const starting = candidate({
      jobId: "job_cccccccccccc",
      attemptId: "run_cccccccccccc",
      threadId: "thr_start0000003",
    });
    const result = await countExecutingJobs({
      listCandidates: () => [first, idle, starting],
      getThread: async (threadId) => {
        if (threadId === first.threadId) return boundView(first, "active");
        if (threadId === idle.threadId) return boundView(idle, "idle");
        return boundView(starting, "starting");
      },
    });
    expect(result).toEqual({ available: true, executingJobCount: 1 });
  });

  it("returns available false on any get throw and does not keep a partial count", async () => {
    const ready = candidate();
    const broken = candidate({ jobId: "job_dddddddddddd", attemptId: "run_dddddddddddd", threadId: "thr_broken000004" });
    const result = await countExecutingJobs({
      listCandidates: () => [ready, broken],
      getThread: async (threadId) => {
        if (threadId === ready.threadId) return boundView(ready, "active");
        throw new Error("threads.get unavailable");
      },
    });
    expect(result).toEqual({ available: false });
    expect(JSON.stringify(result)).not.toContain("unavailable");
  });

  it("returns available false when listing candidates throws", async () => {
    const result = await countExecutingJobs({
      listCandidates: () => {
        throw new Error("sqlite down");
      },
      getThread: async () => boundView(candidate()),
    });
    expect(result).toEqual({ available: false });
  });
});

describe("countInProgressJobs", () => {
  it("counts distinct Job.state running and ignores other states", () => {
    expect(
      countInProgressJobs({
        listRunningJobIds: () => ["job_aaaaaaaaaaaa", "job_bbbbbbbbbbbb", "job_aaaaaaaaaaaa"],
      }),
    ).toEqual({ available: true, inProgressJobCount: 2 });
    expect(countInProgressJobs({ listRunningJobIds: () => [] })).toEqual({
      available: true,
      inProgressJobCount: 0,
    });
  });

  it("returns available false when listing running jobs throws", () => {
    expect(
      countInProgressJobs({
        listRunningJobIds: () => {
          throw new Error("sqlite down");
        },
      }),
    ).toEqual({ available: false });
  });

  it("reads Job.state running from sqlite even when the bound thread is not active", async () => {
    const { db, close } = openFileDb();
    try {
      const live = await seedRunningAttempt(db);
      expect(listRunningJobIds(db)).toEqual([live.seeded.job.id]);
      expect(countInProgressJobs({ listRunningJobIds: () => listRunningJobIds(db) })).toEqual({
        available: true,
        inProgressJobCount: 1,
      });
      db.prepare(`UPDATE agency_job SET state = 'waiting_input' WHERE id = ?`).run(live.seeded.job.id);
      expect(listRunningJobIds(db)).toEqual([]);
    } finally {
      close();
    }
  });
});

describe("listBoundExecutingCandidates", () => {
  it("keeps an applied confirmed running bind and drops pending, waiting_input, and thread mismatch", async () => {
    const { db, close } = openFileDb();
    try {
      const live = await seedRunningAttempt(db);
      expect(listBoundExecutingCandidates(db)).toEqual([
        {
          jobId: live.receipt.jobId,
          attemptId: live.receipt.attemptId,
          launchId: live.receipt.launchId,
          threadId: live.receipt.threadId,
        },
      ]);

      db.prepare(`UPDATE agency_launch_receipt SET job_bind_state = 'pending' WHERE launch_id = ?`).run(
        live.receipt.launchId,
      );
      expect(listBoundExecutingCandidates(db)).toEqual([]);

      db.prepare(`UPDATE agency_launch_receipt SET job_bind_state = 'applied' WHERE launch_id = ?`).run(
        live.receipt.launchId,
      );
      db.prepare(`UPDATE agency_job SET state = 'waiting_input' WHERE id = ?`).run(live.receipt.jobId);
      expect(listBoundExecutingCandidates(db)).toEqual([]);

      db.prepare(`UPDATE agency_job SET state = 'running' WHERE id = ?`).run(live.receipt.jobId);
      db.prepare(`UPDATE agency_run_attempt SET thread_id = 'thr_other0000001' WHERE id = ?`).run(
        live.receipt.attemptId,
      );
      expect(listBoundExecutingCandidates(db)).toEqual([]);
    } finally {
      close();
    }
  });
});

describe("sidebarExecutingJobCount rpc", () => {
  it("returns one when get is active and hides lookup failure without error text", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "agency" });
    try {
      await plugin(bb);
      const db = bb.storage.database() as SqlDatabase;
      const live = await seedRunningAttempt(db);
      harness.sdk.stub("threads.get", async () => boundView({
        jobId: live.receipt.jobId,
        attemptId: live.receipt.attemptId,
        launchId: live.receipt.launchId,
        threadId: live.receipt.threadId!,
      }));
      expect(await harness.behavior.callRpc("sidebarExecutingJobCount", null)).toEqual({
        available: true,
        executingJobCount: 1,
      });

      harness.sdk.stub("threads.get", async () => {
        throw new Error("core down");
      });
      expect(await harness.behavior.callRpc("sidebarExecutingJobCount", null)).toEqual({ available: false });
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});

describe("sidebarInProgressJobCount rpc", () => {
  it("counts Job.state running when the bound thread is idle, and keeps executingJobCount honest", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "agency" });
    try {
      await plugin(bb);
      const db = bb.storage.database() as SqlDatabase;
      const live = await seedRunningAttempt(db);
      harness.sdk.stub("threads.get", async () => boundView({
        jobId: live.receipt.jobId,
        attemptId: live.receipt.attemptId,
        launchId: live.receipt.launchId,
        threadId: live.receipt.threadId!,
      }, "idle"));
      expect(await harness.behavior.callRpc("sidebarInProgressJobCount", null)).toEqual({
        available: true,
        inProgressJobCount: 1,
      });
      expect(await harness.behavior.callRpc("sidebarExecutingJobCount", null)).toEqual({
        available: true,
        executingJobCount: 0,
      });
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
