import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAlias } from "../src/server/cli/aliases";
import { AWAITING_REVIEW_MIGRATION_ID, applyAgencyMigrations, migrations, openMigratedDatabase } from "../src/server/db";
import { reportNeedsInput } from "../src/server/runtime/needs-input/report";
import { createInternalRunStoreReads, createRunStore } from "../src/server/runtime/run-store";
import type { NeedsInputQuestion, ReportNeedsInputCommand } from "../src/shared/contracts";
import { seedRunningAttempt } from "./attempt-awaiting-review.test";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function openFileDb() {
  const dir = mkdtempSync(join(tmpdir(), "agy-needs-"));
  tempDirs.push(dir);
  const path = join(dir, "agency.sqlite");
  return { db: openMigratedDatabase(new Database(path)), path };
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

function command(
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

describe("reportNeedsInput", () => {
  it("resolves the explicit CLI alias and keeps awaiting_review migration frozen", () => {
    expect(resolveAlias(["job", "report-needs-input"])).toBe("reportNeedsInput");
    expect(migrations[AWAITING_REVIEW_MIGRATION_ID]).toContain("awaiting_review");
    expect(migrations.some((sql) => sql.includes("agency_job_needs_input_wait"))).toBe(true);
  });

  it("moves running job/attempt to waiting_input without artifact or accept", async () => {
    const opened = openFileDb();
    const live = await seedRunningAttempt(opened.db);
    const beforeArtifacts = opened.db.prepare(`SELECT COUNT(*) AS n FROM agency_artifact WHERE job_id = ?`).get(live.seeded.job.id) as { n: number };
    const input = command(live);
    const reported = reportNeedsInput(
      { db: opened.db, store: live.seeded.store, runs: live.runs, reads: live.reads },
      live.seeded.ctx,
      input,
    );
    expect(reported.ok).toBe(true);
    if (!reported.ok) throw new Error(reported.error.message);
    expect(reported.value.jobState).toBe("waiting_input");
    expect(reported.value.attemptState).toBe("waiting_input");
    expect(live.seeded.store.getJob(live.seeded.job.id)?.state).toBe("waiting_input");
    const attempt = live.reads.getAttempt(live.seeded.ctx, live.attempt.attemptId);
    expect(attempt.ok && attempt.value.state).toBe("waiting_input");
    const facts = opened.db.prepare(`SELECT open_questions FROM agency_job_facts WHERE job_id = ?`).get(live.seeded.job.id) as { open_questions: number };
    expect(facts.open_questions).toBe(1);
    const afterArtifacts = opened.db.prepare(`SELECT COUNT(*) AS n FROM agency_artifact WHERE job_id = ?`).get(live.seeded.job.id) as { n: number };
    expect(afterArtifacts.n).toBe(beforeArtifacts.n);
    const accepted = opened.db.prepare(`SELECT COUNT(*) AS n FROM agency_artifact_acceptance WHERE job_id = ?`).get(live.seeded.job.id) as { n: number };
    expect(accepted.n).toBe(0);
    expect(live.seeded.store.getJob(live.seeded.job.id)?.state).not.toBe("done");
    const replay = reportNeedsInput(
      { db: opened.db, store: live.seeded.store, runs: live.runs, reads: live.reads },
      live.seeded.ctx,
      input,
    );
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.value).toEqual(reported.value);
  });

  it("rejects unknown identity and stale CAS", async () => {
    const opened = openFileDb();
    const live = await seedRunningAttempt(opened.db);
    const deps = { db: opened.db, store: live.seeded.store, runs: live.runs, reads: live.reads };
    const unknown = reportNeedsInput(deps, live.seeded.ctx, command(live, { threadId: "thr_wrongthread01" }));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("unknown_identity");
    const stale = reportNeedsInput(deps, live.seeded.ctx, command(live, { expectedRevision: 1 }));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("revision_conflict");
    expect(live.seeded.store.getJob(live.seeded.job.id)?.state).toBe("running");
  });

  it("is idempotent for the same body and conflicts on a different body", async () => {
    const opened = openFileDb();
    const live = await seedRunningAttempt(opened.db);
    const deps = { db: opened.db, store: live.seeded.store, runs: live.runs, reads: live.reads };
    const first = reportNeedsInput(deps, live.seeded.ctx, command(live));
    expect(first.ok).toBe(true);
    const sameBody = reportNeedsInput(deps, live.seeded.ctx, command(live));
    expect(sameBody.ok).toBe(true);
    const conflict = reportNeedsInput(
      deps,
      live.seeded.ctx,
      command(live, { questions: questions(live.seeded.processVersion.id, live.seeded.job.id, "Другой вопрос?") }),
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("request_conflict");
  });

  it("rejects awaiting_review", async () => {
    const opened = openFileDb();
    const live = await seedRunningAttempt(opened.db);
    const reviewJob = live.seeded.store.transitionJob(live.seeded.ctx, {
      requestId: randomUUID(),
      jobId: live.seeded.job.id,
      expectedRevision: live.seeded.store.getJob(live.seeded.job.id)!.revision,
      to: "review",
    });
    expect(reviewJob.ok).toBe(false);
    const launching = live.reads.getAttempt(live.seeded.ctx, live.attempt.attemptId);
    expect(launching.ok).toBe(true);
    const moved = live.runs.transitionAttempt(live.seeded.ctx, {
      requestId: randomUUID(),
      attemptId: live.attempt.attemptId,
      expectedRevision: launching.ok ? launching.value.revision : 1,
      to: "awaiting_review",
    });
    expect(moved.ok).toBe(true);
    const rejected = reportNeedsInput(
      { db: opened.db, store: live.seeded.store, runs: live.runs, reads: live.reads },
      live.seeded.ctx,
      command(live, {
        expectedAttemptRevision: moved.ok ? moved.value.revision : 1,
      }),
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("illegal_transition");
  });
});
