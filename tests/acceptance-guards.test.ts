import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { callerAttemptForThread, withCallerThread } from "../src/server/api/caller";
import { resolveRpcAccess } from "../src/server/api/auth";
import type { ServiceContext } from "../src/server/services";
import { seed } from "./role-types.test";

function setup() {
  const db = openMigratedDatabase(new Database(":memory:"));
  const s = seed(db);
  const main = s.job("Главная", s.lead);
  const child = s.store.createJob(s.ctx, {
    requestId: randomUUID(),
    bindingId: s.ctx.allowedBindingIds[0]!,
    departmentId: s.departmentId,
    title: "Реализация",
    brief: "Бриф.",
    acceptance: "Критерий.",
    parentJobId: main.id,
    assignedAgentId: s.developer,
    priority: "normal",
    dueAt: null,
  });
  if (!child.ok) throw new Error(child.error.message);
  const attempt = (id: string, jobId: string, threadId: string) => {
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO agency_run_attempt (id, job_id, attempt_no, snapshot_id, digest, thread_id, launch_id, state, revision, created_at, updated_at)
       VALUES (?, ?, 1, 'snp_fixture', 'digest', ?, ?, 'running', 1, '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z')`,
    ).run(id, jobId, threadId, randomUUID());
    db.pragma("foreign_keys = ON");
  };
  attempt("run_lead0001", main.id, "thr_lead00001");
  attempt("run_dev00001", child.value.id, "thr_dev000001");
  const version = (jobId: string, runId: string) => {
    const artifact = s.store.createArtifact(s.ctx, { requestId: randomUUID(), jobId });
    if (!artifact.ok) throw new Error(artifact.error.message);
    const published = s.store.publishArtifactVersion(s.ctx, {
      requestId: randomUUID(),
      artifactId: artifact.value.id,
      jobId,
      hostId: "host_mini",
      relativePath: "report.md",
      mime: "text/markdown",
      size: 4,
      hash: "cd".repeat(32),
      author: { kind: "run", runId },
    });
    if (!published.ok) throw new Error(published.error.message);
    return published.value;
  };
  const accept = (ctx: ServiceContext, jobId: string, v: { artifactId: string; version: number; hash: string }) =>
    s.store.acceptArtifactVersion(ctx, {
      requestId: randomUUID(),
      expectedRevision: s.store.getJob(jobId)!.revision,
      jobId,
      artifactId: v.artifactId,
      version: v.version,
      hash: v.hash,
    });
  const as = (threadId: string): ServiceContext => ({ ...s.ctx, caller: callerAttemptForThread(db, threadId)! });
  return { db, s, main, child: child.value, version, accept, as };
}

describe("who may accept a version", () => {
  it("resolves the calling attempt only inside a CLI call with a thread", () => {
    const { db } = setup();
    expect(resolveRpcAccess(db).ok && "caller" in (resolveRpcAccess(db) as { value: { ctx: object } }).value.ctx).toBe(false);
    const inside = withCallerThread("thr_dev000001", () => resolveRpcAccess(db));
    expect(inside.ok && inside.value.ctx.caller).toMatchObject({ attemptId: "run_dev00001" });
    expect(withCallerThread("thr_unknown01", () => resolveRpcAccess(db)).ok).toBe(true);
  });

  it("lets the lead accept the subtask it delegated", () => {
    const t = setup();
    const v = t.version(t.child.id, "run_dev00001");
    expect(t.accept(t.as("thr_lead00001"), t.child.id, v).ok).toBe(true);
  });

  it("refuses an employee accepting the result of its own job", () => {
    const t = setup();
    const v = t.version(t.main.id, "run_lead0001");
    const result = t.accept(t.as("thr_lead00001"), t.main.id, v);
    expect(result.ok ? null : result.error.code).toBe("self_acceptance");
    // The owner accepts from the interface: no calling attempt.
    expect(t.accept(t.s.ctx, t.main.id, v).ok).toBe(true);
  });

  it("refuses an employee accepting a job it did not delegate", () => {
    const t = setup();
    const v = t.version(t.main.id, "run_lead0001");
    const result = t.accept(t.as("thr_dev000001"), t.main.id, v);
    expect(result.ok ? null : result.error.code).toBe("accept_not_lead");
  });
});
