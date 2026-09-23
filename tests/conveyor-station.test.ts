import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ok } from "../src/domain";
import { openMigratedDatabase } from "../src/server/db";
import { formatJobPack, parseReviewVerdict } from "../src/server/runtime/conveyor";
import {
  advanceAfterHandIn,
  closeParentIfChildrenDone,
  sweepStaleReviewStations,
  closeStation,
  acceptOnLine,
  type ConveyorPorts,
} from "../src/server/runtime/conveyor";
import { startAutoReview, type AutoReviewPorts } from "../src/server/runtime/auto-review/service";
import type { Job } from "../src/shared/contracts";
import { seed } from "./role-types.test";

const HASH = "cd".repeat(32);

function publish(s: ReturnType<typeof seed>, jobId: string) {
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
    hash: HASH,
    author: { kind: "system" },
  });
  if (!published.ok) throw new Error(published.error.message);
  return published.value;
}

function intoReview(s: ReturnType<typeof seed>, db: ReturnType<typeof openMigratedDatabase>, jobId: string) {
  db.prepare(`UPDATE agency_job SET state = 'review' WHERE id = ?`).run(jobId);
  return s.store.getJob(jobId)!;
}

function closePorts(s: ReturnType<typeof seed>, db: ReturnType<typeof openMigratedDatabase>): ConveyorPorts {
  const comments: string[] = [];
  const autoReview: AutoReviewPorts = {
    db,
    getJob: (id) => s.store.getJob(id),
    enabled: () => false,
    memberRole: (departmentId, agentId) => s.store.memberRole(departmentId, agentId),
    latestVersion: (jobId) => {
      const row = db
        .prepare(`SELECT artifact_id, version, hash FROM agency_artifact_version WHERE job_id = ? ORDER BY rowid DESC LIMIT 1`)
        .get(jobId) as { artifact_id: string; version: number; hash: string } | undefined;
      return row ? { artifactId: row.artifact_id, version: row.version, hash: row.hash } : null;
    },
    createReview: () => ({ ok: false, error: { code: "unused", message: "unused" } }),
    attachInput: async () => ok({}),
    queue: (review: Job) => ok(review.id),
    discard: () => undefined,
    comment: (_job, text) => {
      comments.push(text);
      return true;
    },
    now: () => "2026-09-20T00:00:00.000Z",
  };
  return {
    db,
    store: {
      getJob: (id) => s.store.getJob(id),
      acceptArtifactVersion: (ctx, input) => s.store.acceptArtifactVersion(ctx, input),
      transitionJob: (ctx, input) => s.store.transitionJob(ctx, input),
    },
    ctx: s.ctx,
    requestId: () => randomUUID(),
    comment: autoReview.comment,
    autoReview,
  };
}

describe("review verdict", () => {
  it("reads explicit verdicts including AG-177 punctuation and keeps unknown undecided", () => {
    expect(parseReviewVerdict("Вердикт: доработать\nкритерий не пройден")).toBe("rework");
    expect(parseReviewVerdict("Verdict: accept\nall green")).toBe("accept");
    expect(parseReviewVerdict("AG-181 сдана: вердикт — доработать.")).toBe("rework");
    expect(parseReviewVerdict("**Verdict:** — accept")).toBe("accept");
    expect(parseReviewVerdict("Looks fine overall.")).toBe("inconclusive");
    expect(parseReviewVerdict("Конвейер: этот отчёт проверки продукт не закрывает.")).toBe("inconclusive");
  });
});

describe("job pack", () => {
  it("skips the handoff-none sentinel", () => {
    const pack = formatJobPack({
      job: { key: "AG-1", title: "T", brief: "Сделать.", acceptance: "Готово." },
      role: "executor",
      handoff: "handoff none",
      lang: "en",
    });
    expect(pack).toContain("# AG-1: T");
    expect(pack).toContain("What to do");
    expect(pack).not.toContain("handoff none");
    expect(pack).not.toContain("## Handoff");
  });
});

describe("conveyor close", () => {
  it.each(["accept", "legacy_publication", "no_resolution", "wrong_hash", "late_input", "rework", "unfinished", "self_review", "executor", "active_qc", "revision_conflict", "foreign_parent"] as const)("resolves an advisory hold using exact independent evidence: %s", (mode) => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const main = s.job("Руководство", s.lead);
    const work = s.job("Реализация", s.developer);
    const review = s.job("Независимая проверка", s.reviewer);
    db.prepare("UPDATE agency_job SET parent_job_id = ? WHERE id IN (?, ?)").run(main.id, work.id, review.id);
    const version = publish(s, work.id);
    intoReview(s, db, work.id);
    s.input(review.id, work.id);
    db.prepare("UPDATE agency_job_input_ref SET artifact_id = ?, version = ?, hash = ? WHERE target_job_id = ?")
      .run(version.artifactId, version.version, mode === "wrong_hash" ? "ef".repeat(32) : version.hash, review.id);
    if (mode === "late_input") db.prepare("UPDATE agency_job_input_ref SET created_at = '2099-01-01T00:00:00.000Z' WHERE target_job_id = ?").run(review.id);
    publish(s, review.id);
    if (mode === "legacy_publication") {
      // The host publication metadata port historically did not emit artifact_published.
      // Require the input to predate the report author's actual attempt instead.
      s.attempt(review.id, "succeeded");
      db.prepare("UPDATE agency_artifact_version SET author = ? WHERE job_id = ?").run(JSON.stringify({ kind: "run", runId: `run_${review.id}` }), review.id);
      db.prepare("DELETE FROM agency_activity WHERE job_id = ? AND kind = 'artifact_published'").run(review.id);
    }
    s.store.createActivity(s.ctx, { requestId: randomUUID(), jobId: review.id, actor: { kind: "agent", agentId: s.reviewer }, kind: "comment", causationId: null, references: [], comment: mode === "rework" ? "Вердикт: доработать" : "Вердикт: принять" });
    db.prepare("UPDATE agency_job SET state = ? WHERE id = ?").run(mode === "unfinished" ? "running" : "done", review.id);
    if (mode === "self_review") db.prepare("UPDATE agency_job SET assigned_agent_id = ? WHERE id = ?").run(s.developer, review.id);
    if (mode === "foreign_parent") db.prepare("UPDATE agency_job SET parent_job_id = NULL WHERE id = ?").run(review.id);
    db.prepare("INSERT INTO agency_handin_hold (job_id, hash, remark) VALUES (?, ?, 'Preliminary evaluator rejected')").run(work.id, version.hash);
    let priorQc: string | null = null;
    if (mode === "active_qc") {
      const qc = s.job("Текущая проверка", s.reviewer);
      db.prepare("UPDATE agency_job SET state = 'running' WHERE id = ?").run(qc.id);
      priorQc = qc.id;
    }
    db.prepare("INSERT INTO agency_auto_review (job_id, hash, review_job_id, outcome, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(work.id, version.hash, priorQc, priorQc ? "queued" : "failed", new Date().toISOString());
    const ports = closePorts(s, db);
    ports.ctx = { ...s.ctx, actor: { kind: "agent", agentId: mode === "executor" ? s.developer : s.lead } };
    const input = { requestId: randomUUID(), jobId: work.id, expectedRevision: s.store.getJob(work.id)!.revision + (mode === "revision_conflict" ? 1 : 0), artifactId: version.artifactId, version: version.version, hash: version.hash,
      ...(mode === "no_resolution" ? {} : { reviewResolution: { reviewJobId: review.id, reason: "The independent report verified the exact version after the preliminary rejection." } }) };
    const result = acceptOnLine(ports, input);
    if (mode === "accept" || mode === "legacy_publication") {
      expect(result.ok).toBe(true);
      expect(s.store.getJob(work.id)?.state).toBe("done");
      expect(db.prepare("SELECT 1 FROM agency_handin_hold WHERE job_id = ?").get(work.id)).toBeUndefined();
      expect(db.prepare("SELECT review_job_id, outcome FROM agency_auto_review WHERE job_id = ?").get(work.id)).toEqual({ review_job_id: review.id, outcome: "resolved" });
      expect(acceptOnLine(ports, input)).toEqual(result);
    } else {
      expect(result.ok).toBe(false);
      expect(s.store.getJob(work.id)?.state).toBe("review");
      expect(db.prepare("SELECT 1 FROM agency_handin_hold WHERE job_id = ?").get(work.id)).toBeTruthy();
      expect(db.prepare("SELECT review_job_id FROM agency_auto_review WHERE job_id = ?").get(work.id)).toEqual({ review_job_id: priorQc });
    }
    db.close();
  });

  it("accepts a review job into done in the same command", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const job = s.job("Станция", s.developer);
    const version = publish(s, job.id);
    intoReview(s, db, job.id);
    const accepted = s.store.acceptArtifactVersion(s.ctx, {
      requestId: randomUUID(),
      expectedRevision: s.store.getJob(job.id)!.revision,
      jobId: job.id,
      artifactId: version.artifactId,
      version: version.version,
      hash: version.hash,
    });
    expect(accepted.ok).toBe(true);
    expect(s.store.getJob(job.id)?.state).toBe("done");
    db.close();
  });

  it("requires a fresh parent summary after every work child is done", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const main = s.job("Корень", s.lead);
    const first = s.store.createJob(s.ctx, {
      requestId: randomUUID(),
      bindingId: s.ctx.allowedBindingIds[0]!,
      departmentId: s.departmentId,
      title: "Крой",
      brief: "Бриф.",
      acceptance: "Критерий.",
      parentJobId: main.id,
      assignedAgentId: s.developer,
      priority: "normal",
      dueAt: null,
    });
    const second = s.store.createJob(s.ctx, {
      requestId: randomUUID(),
      bindingId: s.ctx.allowedBindingIds[0]!,
      departmentId: s.departmentId,
      title: "Пошив",
      brief: "Бриф.",
      acceptance: "Критерий.",
      parentJobId: main.id,
      assignedAgentId: s.developer,
      priority: "normal",
      dueAt: null,
    });
    if (!first.ok || !second.ok) throw new Error("children");
    publish(s, main.id);
    const v1 = publish(s, first.value.id);
    const v2 = publish(s, second.value.id);
    intoReview(s, db, main.id);
    intoReview(s, db, first.value.id);
    intoReview(s, db, second.value.id);
    const ports = closePorts(s, db);
    expect(
      s.store.acceptArtifactVersion(s.ctx, {
        requestId: randomUUID(),
        expectedRevision: s.store.getJob(first.value.id)!.revision,
        jobId: first.value.id,
        artifactId: v1.artifactId,
        version: v1.version,
        hash: v1.hash,
      }).ok,
    ).toBe(true);
    expect(s.store.getJob(main.id)?.state).toBe("review");
    expect(
      s.store.acceptArtifactVersion(s.ctx, {
        requestId: randomUUID(),
        expectedRevision: s.store.getJob(second.value.id)!.revision,
        jobId: second.value.id,
        artifactId: v2.artifactId,
        version: v2.version,
        hash: v2.hash,
      }).ok,
    ).toBe(true);
    expect(closeParentIfChildrenDone(ports, second.value.id).ok).toBe(true);
    expect(s.store.getJob(main.id)?.state).toBe("review");
    publish(s, main.id);
    expect(closeStation(ports, main.id, "final-summary").ok).toBe(true);
    expect(s.store.getJob(main.id)?.state).toBe("done");
    db.close();
  });

  it("closes a lead station when automatic QC does not apply", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const job = s.job("Сводка", s.lead);
    publish(s, job.id);
    intoReview(s, db, job.id);
    const ports = closePorts(s, db);
    expect(await startAutoReview(ports.autoReview, job.id)).toBe("skipped");
    expect(await advanceAfterHandIn(ports, job.id)).toBe("closed");
    expect(s.store.getJob(job.id)?.state).toBe("done");
    db.close();
  });

  it("does not close a station while QC is already claimed", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const work = s.job("Реализация", s.developer);
    publish(s, work.id);
    intoReview(s, db, work.id);
    const ports = closePorts(s, db);
    ports.autoReview.enabled = () => true;
    ports.autoReview.createReview = (job, _version) =>
      s.store.createJob(
        { actor: { kind: "system" }, allowedBindingIds: [job.bindingId] },
        {
          requestId: randomUUID(),
          bindingId: job.bindingId,
          departmentId: job.departmentId,
          title: `Проверка ${job.key}`,
          brief: "Проверить.",
          acceptance: "Вердикт: принять",
          parentJobId: job.parentJobId ?? job.id,
          assignedAgentId: null,
          assignment: "reviewer",
          priority: job.priority,
          dueAt: job.dueAt,
        },
      );
    expect(await advanceAfterHandIn(ports, work.id)).toBe("created");
    expect(await advanceAfterHandIn(ports, work.id)).toBe("pending");
    expect(s.store.getJob(work.id)?.state).toBe("review");
    db.close();
  });

  it("closeStation is a no-op when the job is already done", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const job = s.job("Станция", s.developer);
    const version = publish(s, job.id);
    intoReview(s, db, job.id);
    const ports = closePorts(s, db);
    expect(closeStation(ports, job.id, randomUUID()).ok).toBe(true);
    expect(s.store.getJob(job.id)?.state).toBe("done");
    expect(closeStation(ports, job.id, randomUUID()).ok).toBe(true);
    expect(version.hash).toBe(HASH);
    db.close();
  });

  it("holds a rejected hand-in even if the worker cannot be resumed and the sweeper runs", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const work = s.job("Итог", s.lead);
    publish(s, work.id);
    intoReview(s, db, work.id);
    const ports = closePorts(s, db);
    ports.handInGate = async () => ({ action: "rework", remark: "Only an organisational report; no code exists." });
    ports.returnForRework = async () => ({ ok: false, error: { code: "rework_no_thread", message: "thread missing" } });
    expect(await advanceAfterHandIn(ports, work.id)).toBe("pending");
    expect(sweepStaleReviewStations({ ...ports, now: () => "2099-01-01T00:00:00.000Z" })).toBe(0);
    expect(s.store.getJob(work.id)?.state).toBe("review");
    db.close();
  });

  it("sends a junk hand-in back for rework before automatic QC", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const work = s.job("Реализация", s.developer);
    publish(s, work.id);
    intoReview(s, db, work.id);
    const ports = closePorts(s, db);
    const remarks: string[] = [];
    ports.handInGate = async () => ({ action: "rework", remark: "junk" });
    ports.returnForRework = async (job, comment) => {
      remarks.push(comment);
      db.prepare(`UPDATE agency_job SET state = 'running' WHERE id = ?`).run(job.id);
      return ok(s.store.getJob(job.id)!);
    };
    ports.autoReview.enabled = () => true;
    ports.autoReview.createReview = () => {
      throw new Error("automatic QC must not start after a hand-in rework");
    };
    expect(await advanceAfterHandIn(ports, work.id)).toBe("rework");
    expect(remarks).toEqual(["junk"]);
    expect(s.store.getJob(work.id)?.state).toBe("running");
    db.close();
  });
});
