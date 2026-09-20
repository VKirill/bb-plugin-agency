import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ok } from "../src/domain";
import { openMigratedDatabase } from "../src/server/db";
import { formatJobPack, parseReviewVerdict } from "../src/server/runtime/conveyor";
import {
  advanceAfterHandIn,
  closeParentIfChildrenDone,
  closeStation,
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
  it("reads an explicit verdict line and defaults unknown to accept", () => {
    expect(parseReviewVerdict("Вердикт: доработать\nкритерий не пройден")).toBe("rework");
    expect(parseReviewVerdict("Verdict: accept\nall green")).toBe("accept");
    expect(parseReviewVerdict("Looks fine overall.")).toBe("accept");
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

  it("closes the parent in review when every work child is done", () => {
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
