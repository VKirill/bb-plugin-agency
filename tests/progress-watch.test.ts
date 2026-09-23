import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { seed } from "./role-types.test";
import { progressSignal } from "../src/server/lead-control/observations";
import { sweepProgressSignals } from "../src/server/lead-control/progress-watch";
import { recordTrace, type TraceInput } from "../src/server/runtime/trace/store";
import { ensureLaunchIssue, readLaunchIssue } from "../src/server/runtime/launch-queue/issues";

const dbs: ReturnType<typeof openMigratedDatabase>[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function setup() {
  const db = openMigratedDatabase(new Database(":memory:")); dbs.push(db);
  const s = seed(db); const job = s.job("Implementation", s.developer);
  db.prepare("UPDATE agency_job SET state = 'running' WHERE id = ?").run(job.id); s.attempt(job.id, "running");
  const trace = (extra: Partial<TraceInput> = {}) => recordTrace(db, { jobId: job.id, step: "submitJobResult", reason: "unfinished_work", outcome: "failed", requestId: randomUUID(), ...extra });
  const notify = (job: NonNullable<ReturnType<typeof s.store.getJob>>, code: string) => ensureLaunchIssue(db, job, code, new Date().toISOString(), comment => s.store.createActivity(s.ctx, { requestId: randomUUID(), jobId: job.id, actor: { kind: "system" }, kind: "comment", causationId: null, references: [{ type: "launch_issue", id: code }], comment }), false);
  return { db, s, job, trace, sweep: () => sweepProgressSignals(db, s.store.getJob, notify) };
}
it("ignores polling, duplicate requests, old attempts and less than three distinct failures", () => {
  const { db, job, trace } = setup(); const requestId = randomUUID();
  for (let i = 0; i < 5; i++) trace({ requestId });
  for (let i = 0; i < 5; i++) trace({ step: "getIsolationReadiness" });
  for (let i = 0; i < 5; i++) trace({ attemptId: "run_old_attempt" });
  trace(); expect(progressSignal(db, job.id)).toBeNull();
  trace(); expect(progressSignal(db, job.id)).toMatchObject({ step: "submitJobResult", reason: "unfinished_work", count: 3 });
});
it("clears a recovered operation or new evidence, but same bytes and unrelated success do not hide failure", () => {
  const { db, job, trace } = setup();
  trace({ step: "publishArtifactVersion", outcome: "succeeded", artifactHash: "ab".repeat(32) });
  trace(); trace(); trace();
  trace({ step: "updateJob", outcome: "succeeded" });
  trace({ step: "publishArtifactVersion", outcome: "succeeded", artifactHash: "ab".repeat(32) });
  expect(progressSignal(db, job.id)?.count).toBe(3);
  trace({ outcome: "succeeded" }); expect(progressSignal(db, job.id)).toBeNull();
  trace(); trace(); trace();
  trace({ step: "publishArtifactVersion", outcome: "succeeded", artifactHash: "cd".repeat(32) });
  expect(progressSignal(db, job.id)).toBeNull();
});
it("creates one durable incident, clears it on recovery, allows recurrence and preserves other blockers", () => {
  const { db, s, job, trace, sweep } = setup(); trace(); trace(); trace();
  sweep(); const issue = readLaunchIssue(db, job.id)!; expect(issue.code).toBe("progress_stalled");
  sweep(); expect(readLaunchIssue(db, job.id)!.activity_id).toBe(issue.activity_id);
  expect(s.store.getJob(job.id)!.state).toBe("running");
  trace({ outcome: "succeeded" }); sweep(); expect(readLaunchIssue(db, job.id)).toBeUndefined();
  trace(); trace(); trace(); sweep(); expect(readLaunchIssue(db, job.id)!.activity_id).not.toBe(issue.activity_id);
  db.prepare("UPDATE agency_launch_issue SET code = 'owns_overlap' WHERE job_id = ?").run(job.id);
  sweep(); expect(readLaunchIssue(db, job.id)!.code).toBe("owns_overlap");
});
