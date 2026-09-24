import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { seed } from "./role-types.test";
import { recoveryHistory } from "../src/server/runtime/recovery/history";
import { getJobDiagnostics, visibleDiagnosticMessages } from "../src/server/runtime/recovery/diagnostics";
import { pendingReviewIncidents } from "../src/server/runtime/recovery/review-incidents";
import { ensureLaunchIssue } from "../src/server/runtime/launch-queue/issues";

function setup() {
  const db = openMigratedDatabase(new Database(":memory:"));
  const s = seed(db);
  const root = s.job("Product", s.lead);
  const work = s.job("Implementation", s.developer);
  db.prepare("UPDATE agency_job SET parent_job_id = ? WHERE id = ?").run(root.id, work.id);
  const comment = (jobId: string, text: string) => s.store.createActivity(s.ctx, { requestId: randomUUID(), jobId,
    actor: { kind: "system" }, kind: "comment", causationId: null, references: [], comment: text });
  return { db, s, root, work, comment };
}

describe("lead diagnostics", () => {
  it("compares actual manual review verdicts and bounded comments, excludes the current verdict and incident echoes", () => {
    const { db, s, work, comment } = setup();
    const first = s.job("Review 1", s.reviewer); s.input(first.id, work.id);
    const second = s.job("Review 2", s.reviewer); s.input(second.id, work.id);
    comment(first.id, "Вердикт: доработать. lang=en navigator=ru must yield EN");
    comment(second.id, "Вердикт: доработать. lang=en navigator=ru must yield RU");
    comment(work.id, "[recovery-dossier] Do not recursively repeat this incident");
    const history = recoveryHistory(db, work.id, second.id);
    expect(history).toContain("must yield EN"); expect(history).not.toContain("must yield RU");
    expect(history).not.toContain("recursively repeat");
    expect(recoveryHistory(db, work.id)).toContain("must yield RU");
    db.close();
  });

  it("allows the responsible lead to inspect attempts, refuses other trees/executors/foreign attempts before reading any thread", async () => {
    const { db, s, work, root } = setup(); s.attempt(work.id, "running");
    const events = vi.fn(async () => [{ seq: 7, type: "item/completed", data: { item: { type: "agentMessage", text: "The same missing input again" } } }]);
    const ctx = { ...s.ctx, caller: { threadId: "thr_lead", attemptId: "run_lead", jobId: root.id, agentId: s.lead } };
    const result = await getJobDiagnostics(db, ctx, { jobId: work.key, limit: 1 }, events);
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.value.conversation.entries[0]?.text).toContain("missing input"); expect(result.value.conversation.nextBeforeSeq).toBe(7); }
    events.mockClear();
    expect((await getJobDiagnostics(db, { ...ctx, caller: { ...ctx.caller, agentId: s.developer } }, { jobId: work.id, limit: 1 }, events)).ok).toBe(false);
    const foreign = s.job("Other product", s.developer);
    expect((await getJobDiagnostics(db, ctx, { jobId: foreign.id, limit: 1 }, events)).ok).toBe(false);
    expect((await getJobDiagnostics(db, ctx, { jobId: work.id, attemptId: "run_foreign", limit: 1 }, events)).ok).toBe(false);
    expect(events).not.toHaveBeenCalled();
    db.close();
  });

  it("exposes visible messages and failure codes without private reasoning or raw tool content", () => {
    const entries = visibleDiagnosticMessages([
      { seq: 3, type: "item/completed", data: { item: { type: "reasoning", text: "private reasoning" } } },
      { seq: 2, type: "item/completed", data: { item: { type: "commandExecution", exitCode: 1, aggregatedOutput: "secret output", command: "secret command" } } },
      { seq: 1, type: "item/completed", data: { item: { type: "agentMessage", text: "Blocked on missing input" } } },
    ]);
    expect(entries).toEqual([{ seq: 1, type: "assistant", text: "Blocked on missing input" }, { seq: 2, type: "command_failed", text: "exitCode=1" }]);
  });

  it("turns a stuck review into one durable lead incident and stops detecting it after resolution", () => {
    const { db, s, work, comment } = setup();
    const artifact = s.store.createArtifact(s.ctx, { requestId: randomUUID(), jobId: work.id }); if (!artifact.ok) throw Error("artifact");
    s.store.publishArtifactVersion(s.ctx, { requestId: randomUUID(), artifactId: artifact.value.id, jobId: work.id,
      hostId: "host_mini", relativePath: "report.md", mime: "text/markdown", size: 1, hash: "ab".repeat(32), author: { kind: "system" } });
    db.prepare("UPDATE agency_job SET state = 'review', updated_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(work.id);
    db.prepare("INSERT INTO agency_handin_hold(job_id,hash,remark) VALUES (?,?,?)").run(work.id, "ab".repeat(32), "not delivered");
    const incidents = pendingReviewIncidents(db, "2026-09-23T00:00:00Z");
    expect(incidents).toEqual([{ jobId: work.id, code: "review_handoff_rejected" }]);
    const create = vi.fn((text: string) => comment(work.id, text));
    const job = s.store.getJob(work.id)!;
    const one = ensureLaunchIssue(db, job, incidents[0]!.code, "2026-09-23T00:00:00Z", create, false);
    const two = ensureLaunchIssue(db, job, incidents[0]!.code, "2026-09-23T00:01:00Z", create, false);
    expect(one?.id).toBe(two?.id); expect(create).toHaveBeenCalledTimes(1);
    expect(one?.comment).toContain("job diagnose"); expect(one?.comment?.length).toBeLessThan(8000);
    db.prepare("UPDATE agency_job SET state = 'done' WHERE id = ?").run(work.id);
    expect(pendingReviewIncidents(db, "2026-09-23T00:02:00Z")).toEqual([]);
    db.close();
  });
});

it("shows system/provider failure categories without exposing raw credential-bearing messages", () => {
  expect(visibleDiagnosticMessages([
    { seq: 2, type: "system/error", data: { code: "thread_command_failed", detail: "Host is not connected" } },
    { seq: 1, type: "provider/error", data: { code: "authentication_error", message: "token=private", willRetry: false } },
  ])).toEqual([
    { seq: 1, type: "execution_error", text: "kind=auth; willRetry=false; inspect the linked turn for details" },
    { seq: 2, type: "execution_error", text: "kind=transient; willRetry=unknown; inspect the linked turn for details" },
  ]);
});
