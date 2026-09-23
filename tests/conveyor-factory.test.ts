/**
 * The factory rule of the conveyor: the customer orders a product and gets a product.
 * Stations close themselves; the customer is called only for raw material (waiting_input)
 * and may return the delivered product as a whole (reclamation).
 */
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ok } from "../src/domain";
import { inboxDecisionJobs } from "../src/app/data/inbox";
import { HUMAN_BLOCKING_STATES, jobAttention } from "../src/app/data/job-attention";
import type { Job as UiJob } from "../src/app/prototype/data";
import { runAgencyCli } from "../src/server/cli/run";
import { openMigratedDatabase } from "../src/server/db";
import { buildDigest } from "../src/server/owner-messages/service";
import {
  acceptOnLine,
  advanceAfterHandIn,
  closeBlockedReviewStation,
  closeStation,
  productReadyMessage,
  sweepStaleReviewStations,
  pendingHandInJobIds,
  type ConveyorPorts,
} from "../src/server/runtime/conveyor";
import type { AutoReviewPorts } from "../src/server/runtime/auto-review/service";
import { uuidV5 } from "../src/server/runtime/launch/operation-ids";
import { returnJobForRework, type ReworkDeps } from "../src/server/runtime/rework/service";
import { createInternalRunStoreReads, createRunStore } from "../src/server/runtime/run-store";
import type { ServiceContext } from "../src/server/services";
import type { Job } from "../src/shared/contracts";
import { seed } from "./role-types.test";

type Db = ReturnType<typeof openMigratedDatabase>;
type Seed = ReturnType<typeof seed>;

const NAMESPACE = "5b1f6c1e-3c0a-4a53-9f3e-2f1d6a7b8c9d";
const T0 = "2026-09-20T00:00:00.000Z";

let hashNo = 0;
function nextHash(): string {
  hashNo += 1;
  return hashNo.toString(16).padStart(64, "0");
}

function publish(s: Seed, jobId: string, relativePath = "report.md") {
  const artifact = s.store.createArtifact(s.ctx, { requestId: randomUUID(), jobId });
  if (!artifact.ok) throw new Error(artifact.error.message);
  const published = s.store.publishArtifactVersion(s.ctx, {
    requestId: randomUUID(),
    artifactId: artifact.value.id,
    jobId,
    hostId: "host_mini",
    relativePath,
    mime: "text/markdown",
    size: 4,
    hash: nextHash(),
    author: { kind: "system" },
  });
  if (!published.ok) throw new Error(published.error.message);
  return published.value;
}

/** Hand-in: the job is in review on its published version. */
function handIn(s: Seed, db: Db, jobId: string) {
  const version = publish(s, jobId);
  db.prepare(`UPDATE agency_job SET state = 'review', updated_at = ? WHERE id = ?`).run(T0, jobId);
  return version;
}

function child(s: Seed, parentJobId: string, title: string, assignedAgentId = s.developer): Job {
  const created = s.store.createJob(s.ctx, {
    requestId: randomUUID(),
    bindingId: s.bindingId,
    departmentId: s.departmentId,
    title,
    brief: "Бриф.",
    acceptance: "Критерий.",
    parentJobId,
    assignedAgentId,
    priority: "normal",
    dueAt: null,
  });
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

function comment(s: Seed, jobId: string, text: string) {
  const written = s.store.createActivity(s.ctx, {
    requestId: randomUUID(),
    jobId,
    actor: { kind: "system" },
    kind: "comment",
    causationId: null,
    references: [],
    comment: text,
  });
  if (!written.ok) throw new Error(written.error.message);
}

/** What the customer's inbox «Нужно ваше решение» shows for the whole database. */
function ownerInbox(s: Seed, db: Db): string[] {
  const rows = db.prepare(`SELECT id FROM agency_job`).all() as Array<{ id: string }>;
  const jobs = rows.map((row) => s.store.getJob(row.id)!);
  const ui = jobs.map(
    (job) =>
      ({
        id: job.key,
        title: job.title,
        state: job.state,
        sourceState: job.state,
        parentId: job.parentJobId ? jobs.find((item) => item.id === job.parentJobId)?.key : undefined,
      }) as unknown as UiJob,
  );
  return inboxDecisionJobs(ui).map((job) => job.id);
}

function conveyor(s: Seed, db: Db, options: { qc?: boolean; now?: () => string } = {}) {
  const comments: string[] = [];
  const ready: Array<{ key: string; text: string; dedupeKey: string }> = [];
  const autoReview: AutoReviewPorts = {
    db,
    getJob: (id) => s.store.getJob(id),
    enabled: () => options.qc === true,
    memberRole: (departmentId, agentId) => s.store.memberRole(departmentId, agentId),
    latestVersion: (jobId) => {
      const row = db
        .prepare(`SELECT artifact_id, version, hash FROM agency_artifact_version WHERE job_id = ? ORDER BY rowid DESC LIMIT 1`)
        .get(jobId) as { artifact_id: string; version: number; hash: string } | undefined;
      return row ? { artifactId: row.artifact_id, version: row.version, hash: row.hash } : null;
    },
    createReview: (job) =>
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
          assignedAgentId: s.reviewer,
          assignment: "reviewer",
          priority: job.priority,
          dueAt: job.dueAt,
        },
      ),
    attachInput: async () => ok({}),
    queue: (review: Job) => ok(review.id),
    discard: () => undefined,
    comment: (_job, text) => {
      comments.push(text);
      return true;
    },
    now: options.now ?? (() => T0),
  };
  const ports: ConveyorPorts = {
    db,
    store: {
      getJob: (id) => s.store.getJob(id),
      acceptArtifactVersion: (ctx, input) => s.store.acceptArtifactVersion(ctx, input),
      transitionJob: (ctx, input) => s.store.transitionJob(ctx, input),
    },
    ctx: s.ctx,
    // Deterministic, like production: the same seed gives the same request id.
    requestId: (seedText) => uuidV5(NAMESPACE, seedText),
    comment: autoReview.comment,
    productReady: (job, result) => ready.push({ key: job.key, ...productReadyMessage(db, job, result) }),
    autoReview,
    now: options.now,
  };
  return { ports, comments, ready };
}

function qcJobFor(db: Db, workJobId: string): string {
  const row = db
    .prepare(`SELECT review_job_id FROM agency_auto_review WHERE job_id = ? ORDER BY rowid DESC LIMIT 1`)
    .get(workJobId) as { review_job_id: string };
  return row.review_job_id;
}

describe("factory conveyor: the customer gets a product, not stamps", () => {
  it("delivers an explicitly submitted child through one QC and a fresh parent result without owner input", async () => {
    const db = openMigratedDatabase(new Database(":memory:")); const s = seed(db);
    const root = s.job("Adaptation delivery", s.lead); const work = child(s, root.id, "Implementation");
    const start = (id: string) => {
      db.prepare("UPDATE agency_job SET state = 'running' WHERE id = ?").run(id);
      s.attempt(id, "running");
      db.prepare("INSERT INTO agency_handin_protocol VALUES (?)").run(`run_${id}`);
      s.store.setJobExecutionFacts(s.ctx, { requestId: randomUUID(), jobId: id, threadBound: true });
    };
    const submit = (id: string, text: string) => {
      const v = publish(s, id);
      const result = s.store.submitJobResult(s.ctx, { requestId: randomUUID(), jobId: id,
        expectedRevision: s.store.getJob(id)!.revision, artifactId: v.artifactId, version: v.version, hash: v.hash, comment: text });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const changed = s.store.transitionJob(s.ctx, { requestId: randomUUID(), jobId: id,
        expectedRevision: s.store.getJob(id)!.revision, to: "review" });
      expect(changed.ok, JSON.stringify(changed)).toBe(true);
    };
    start(root.id); start(work.id);
    publish(s, root.id); comment(s, root.id, "Delivery plan published; implementation in progress");
    expect(s.store.transitionJob(s.ctx, { requestId: randomUUID(), jobId: root.id, expectedRevision: root.revision, to: "review" }).ok).toBe(false);
    const { ports, ready } = conveyor(s, db, { qc: true });
    submit(work.id, "Implementation and evidence ready");
    expect(await advanceAfterHandIn(ports, work.id)).toBe("created");
    const qcId = qcJobFor(db, work.id); start(qcId);
    submit(qcId, "Вердикт: принять\nТочная версия независимо проверена.");
    expect(await advanceAfterHandIn(ports, qcId)).toBe("closed");
    expect(s.store.getJob(work.id)?.state).toBe("done");
    expect(s.store.getJob(root.id)?.state).toBe("running");
    submit(root.id, "Delivered product; exact accepted child evidence and final report");
    expect(closeStation(ports, root.id, "final-product").ok).toBe(true);
    expect(s.store.getJob(root.id)?.state).toBe("done");
    expect(db.prepare("SELECT COUNT(*) AS n FROM agency_auto_review WHERE job_id = ?").get(work.id)).toEqual({ n: 1 });
    expect(ready).toHaveLength(1); expect(ownerInbox(s, db)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agency_run_attempt").get()).toEqual({ n: 3 });
    db.close();
  });

  it("recovers a review entered without the completion callback, once per published version", async () => {
    const db = openMigratedDatabase(new Database(":memory:")); const s = seed(db);
    const root = s.job("Product", s.lead); const work = child(s, root.id, "Implementation");
    handIn(s, db, work.id); const { ports } = conveyor(s, db, { qc: true, now: () => "2099-01-01T00:00:00Z" });
    let decisions = 0; ports.handInGate = async () => { decisions++; return null; }; ports.returnForRework = async () => { throw new Error("Not a rejection"); };
    expect(pendingHandInJobIds(ports)).toContain(work.id);
    expect(await advanceAfterHandIn(ports, work.id)).toBe("created");
    expect(pendingHandInJobIds(ports)).not.toContain(work.id);
    expect(await advanceAfterHandIn(ports, work.id)).toBe("pending");
    expect(decisions).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agency_auto_review WHERE job_id = ?").get(work.id)).toEqual({ n: 1 });
    db.close();
  });

  it("closes a child station after QC «принять» and leaves the owner's inbox empty", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const root = s.job("Партия кроссовок", s.lead);
    const work = child(s, root.id, "Пошив");
    handIn(s, db, work.id);
    const { ports } = conveyor(s, db, { qc: true });

    expect(await advanceAfterHandIn(ports, work.id)).toBe("created");
    expect(s.store.getJob(work.id)?.state).toBe("review");
    expect(ownerInbox(s, db)).toEqual([]);

    const qcId = qcJobFor(db, work.id);
    handIn(s, db, qcId);
    comment(s, qcId, "Вердикт: принять\nКритерии пройдены.");
    expect(await advanceAfterHandIn(ports, qcId)).toBe("closed");

    expect(s.store.getJob(work.id)?.state).toBe("done");
    expect(s.store.getJob(qcId)?.state).toBe("done");
    expect(ownerInbox(s, db)).toEqual([]);
    db.close();
  });

  it("sends the station back to the previous station on QC «доработать», not to the customer", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const root = s.job("Партия", s.lead);
    const work = child(s, root.id, "Подошва");
    handIn(s, db, work.id);
    const { ports } = conveyor(s, db, { qc: true });
    const returned: string[] = [];
    ports.returnForRework = async (job, remark) => {
      returned.push(`${job.key}: ${remark}`);
      return ok(job);
    };
    expect(await advanceAfterHandIn(ports, work.id)).toBe("created");
    const qcId = qcJobFor(db, work.id);
    handIn(s, db, qcId);
    comment(s, qcId, "Вердикт: доработать\nШов расходится.");
    expect(await advanceAfterHandIn(ports, qcId)).toBe("rework");
    expect(returned).toHaveLength(1);
    expect(returned[0]).toContain("Шов расходится");
    expect(s.store.getJob(work.id)?.state).not.toBe("done");
    expect(ownerInbox(s, db)).toEqual([]);
    db.close();
  });

  it("closes the root when every work child is done and the line's QC passed; the owner is told once, never asked", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const root = s.job("Партия кроссовок", s.lead);
    const cut = child(s, root.id, "Раскрой");
    const sew = child(s, root.id, "Пошив");
    const { ports, ready } = conveyor(s, db);

    // The lead hands in the summary while a station is still working: the root is not a product yet.
    handIn(s, db, cut.id);
    expect(await advanceAfterHandIn(ports, cut.id)).toBe("closed");
    handIn(s, db, root.id);
    expect(await advanceAfterHandIn(ports, root.id)).toBe("pending");
    expect(s.store.getJob(root.id)?.state).toBe("review");
    expect(ready).toEqual([]);
    expect(ownerInbox(s, db)).toEqual([]);

    // The sweep does not close a held root either, and does not spam it with comments.
    const later = () => "2026-09-20T05:00:00.000Z";
    expect(sweepStaleReviewStations({ ...ports, now: later })).toBe(0);
    expect(s.store.getJob(root.id)?.state).toBe("review");

    // The last station closes; the lead must hand in the final product after it.
    handIn(s, db, sew.id);
    expect(await advanceAfterHandIn(ports, sew.id)).toBe("closed");
    expect(s.store.getJob(root.id)?.state).toBe("review");
    handIn(s, db, root.id);
    expect(await advanceAfterHandIn(ports, root.id)).toBe("closed");
    expect(s.store.getJob(root.id)?.state).toBe("done");
    expect(ownerInbox(s, db)).toEqual([]);

    expect(ready).toHaveLength(1);
    expect(ready[0]!.key).toBe(root.key);
    expect(ready[0]!.text).toContain("Продукт готов");
    expect(ready[0]!.text).toContain("report.md");
    db.close();
  });

  it("does not close a root over its own QC that is still reading", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const root = s.job("Изделие", s.developer);
    const part = child(s, root.id, "Деталь");
    const { ports } = conveyor(s, db, { qc: true });
    handIn(s, db, root.id);
    expect(await advanceAfterHandIn(ports, root.id)).toBe("created");
    const partQcOff = conveyor(s, db).ports;
    handIn(s, db, part.id);
    expect(await advanceAfterHandIn(partQcOff, part.id)).toBe("closed");
    expect(s.store.getJob(root.id)?.state).toBe("review");

    // Final summary is published after the child, and receives its own version-bound QC.
    handIn(s, db, root.id);
    expect(await advanceAfterHandIn(ports, root.id)).toBe("created");
    const qcId = qcJobFor(db, root.id);
    handIn(s, db, qcId);
    comment(s, qcId, "Verdict: accept");
    expect(await advanceAfterHandIn(ports, qcId)).toBe("closed");
    expect(s.store.getJob(root.id)?.state).toBe("done");
    db.close();
  });

  it("artifact accept from the CLI gives job.state done in the same command and moves the line", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const root = s.job("Корень", s.lead);
    const only = child(s, root.id, "Единственная станция");
    handIn(s, db, root.id);
    const version = handIn(s, db, only.id);
    const { ports, ready } = conveyor(s, db);

    const result = await runAgencyCli(
      {
        status: () => {
          throw new Error("unused");
        },
        notify: () => {
          throw new Error("unused");
        },
        dispatch: async (operation, input) => {
          if (operation !== "acceptArtifactVersion") throw new Error(`unexpected ${operation}`);
          return acceptOnLine(ports, input as Parameters<typeof acceptOnLine>[1]);
        },
      },
      [
        "artifact",
        "accept",
        "--input-json",
        JSON.stringify({
          requestId: randomUUID(),
          expectedRevision: s.store.getJob(only.id)!.revision,
          jobId: only.id,
          artifactId: version.artifactId,
          version: version.version,
          hash: version.hash,
        }),
      ],
    );
    expect(result.exitCode, result.stderr ?? result.stdout).toBe(0);
    expect(s.store.getJob(only.id)?.state).toBe("done");
    expect(s.store.getJob(root.id)?.state).toBe("review");
    handIn(s, db, root.id);
    expect(await advanceAfterHandIn(ports, root.id)).toBe("closed");
    expect(s.store.getJob(root.id)?.state).toBe("done");
    expect(ready.map((item) => item.key)).toEqual([root.key]);
    db.close();
  });

  it("a stalled auto-review never accepts unverified work or releases dependents", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const root = s.job("Партия", s.lead);
    const work = child(s, root.id, "Подошва");
    const next = child(s, root.id, "Упаковка");
    expect(s.store.addJobDependency(s.ctx, { requestId: randomUUID(), jobId: next.id, dependsOnJobId: work.id }).ok).toBe(true);
    handIn(s, db, work.id);
    const { ports, ready } = conveyor(s, db, { qc: true });
    expect(await advanceAfterHandIn(ports, work.id)).toBe("created");
    const qcId = qcJobFor(db, work.id);
    expect(sweepStaleReviewStations({ ...ports, now: () => "2099-09-20T00:00:00.000Z" })).toBe(0);
    expect(s.store.getJob(work.id)?.state).toBe("review");
    expect(s.store.getJob(qcId)?.state).not.toBe("canceled");
    expect(s.store.transitionJob(s.ctx, { requestId: randomUUID(), expectedRevision: s.store.getJob(next.id)!.revision, jobId: next.id, to: "queued" }))
      .toMatchObject({ ok: false, error: { code: "open_blockers" } });
    expect(ready).toEqual([]);
    db.close();
  });

  it("does not close on an inconclusive QC or reuse a verdict from its previous report", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const root = s.job("Партия", s.lead);
    const work = child(s, root.id, "Работа");
    handIn(s, db, work.id);
    const { ports } = conveyor(s, db, { qc: true });
    expect(await advanceAfterHandIn(ports, work.id)).toBe("created");
    const qcId = qcJobFor(db, work.id);
    handIn(s, db, qcId);
    comment(s, qcId, "Verdict: accept");
    handIn(s, db, qcId); // new published report, previous verdict does not apply
    comment(s, qcId, "Отчёт опубликован, решение не указано.");
    expect(await advanceAfterHandIn(ports, qcId)).toBe("pending");
    expect(s.store.getJob(work.id)?.state).toBe("review");
    expect(sweepStaleReviewStations({ ...ports, now: () => "2099-01-01T00:00:00.000Z" })).toBe(0);
    comment(s, qcId, "Вердикт — принять");
    expect(await advanceAfterHandIn(ports, qcId)).toBe("closed");
    db.close();
  });

  it("keeps work unaccepted when its QC run is blocked", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const root = s.job("Партия", s.lead);
    const work = child(s, root.id, "Раскрой");
    handIn(s, db, work.id);
    const { ports } = conveyor(s, db, { qc: true });
    expect(await advanceAfterHandIn(ports, work.id)).toBe("created");
    const qcId = qcJobFor(db, work.id);
    db.prepare(`UPDATE agency_job SET state = 'blocked' WHERE id = ?`).run(qcId);
    const closed = closeBlockedReviewStation(ports, qcId);
    expect(closed).toEqual({ ok: true, value: null });
    expect(s.store.getJob(work.id)?.state).toBe("review");
    // A blocked QC job is a factory matter: it has a parent and never reaches the customer's inbox.
    expect(ownerInbox(s, db)).toEqual([]);
    db.close();
  });

  it("closes a station again after it came back: the request id carries the revision", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const job = s.job("Станция", s.developer);
    handIn(s, db, job.id);
    const { ports } = conveyor(s, db);
    expect(closeStation(ports, job.id, "conveyor-skip-qc")).toMatchObject({ ok: true, value: { state: "done" } });

    // Second round (rework or reclamation): same seed, new revision, new version.
    const reopened = s.store.transitionJob(s.ctx, {
      requestId: randomUUID(),
      expectedRevision: s.store.getJob(job.id)!.revision,
      jobId: job.id,
      to: "review",
    });
    expect(reopened.ok).toBe(true);
    db.prepare(`UPDATE agency_job SET state = 'running' WHERE id = ?`).run(job.id);
    handIn(s, db, job.id);
    expect(closeStation(ports, job.id, "conveyor-skip-qc")).toMatchObject({ ok: true, value: { state: "done" } });
    db.close();
  });

  it("keeps waiting_input as the only wait for a person; review never reaches the inbox", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const root = s.job("Корень", s.lead);
    const inReview = child(s, root.id, "На проверке");
    const needsSecret = child(s, root.id, "Нужен ключ от заказчика");
    const stuckInside = child(s, root.id, "Внутренний стоп");
    const rootInReview = s.job("Корень на проверке", s.lead);
    const escalated = s.job("Эскалация до заказчика", s.lead);
    const state = (jobId: string, to: string) =>
      db.prepare(`UPDATE agency_job SET state = ?, updated_at = ? WHERE id = ?`).run(to, "2026-09-18T00:00:00.000Z", jobId);
    state(inReview.id, "review");
    state(rootInReview.id, "review");
    state(needsSecret.id, "waiting_input");
    state(stuckInside.id, "blocked");
    state(escalated.id, "blocked");

    // Inbox: the raw-material wait and the escalation that reached the top. No review, no internal stop.
    expect(ownerInbox(s, db).sort()).toEqual([needsSecret.key, escalated.key].sort());

    expect(HUMAN_BLOCKING_STATES).not.toContain("review");
    const now = Date.parse("2026-09-20T00:00:00.000Z");
    expect(jobAttention({ state: "review", updatedAt: "2026-09-18T00:00:00.000Z" }, now).tone).toBe("quiet");
    expect(jobAttention({ state: "waiting_input", updatedAt: "2026-09-18T00:00:00.000Z" }, now).tone).toBe("overdue");

    // The watchdog does not report stations in review to the customer either.
    const watchdog = buildDigest(db, { kind: "watchdog", sinceHours: 24, stuckHours: 12 }, new Date(now), false);
    expect(watchdog.items.map((item) => item.state).sort()).toEqual(["blocked", "blocked", "waiting_input"]);
    expect(watchdog.text).not.toContain(inReview.key);
    expect(watchdog.text).not.toContain(rootInReview.key);
    db.close();
  });
});

describe("reclamation: the customer returns the delivered product as a whole", () => {
  function reworkDeps(s: Seed, db: Db, sent: Array<{ threadId: string; text: string }>): ReworkDeps {
    return {
      db,
      store: s.store,
      runs: createRunStore(db),
      reads: createInternalRunStoreReads(db),
      send: {
        send: async (args) => {
          sent.push({ threadId: args.threadId, text: args.text });
          return { kind: "confirmed", delivery: "sent" };
        },
        recoverContinuation: async () => "present",
      },
      currentPublishedHash: async (jobId) =>
        (db.prepare(`SELECT hash FROM agency_artifact_version WHERE job_id = ? ORDER BY rowid DESC LIMIT 1`).get(jobId) as { hash: string } | undefined)
          ?.hash ?? null,
      // The department allows no rework rounds at all; a reclamation is not bound by it.
      reworkLimit: () => 0,
    };
  }

  it.each(["awaiting_review", "running"])("allows one audited lead recovery for a %s attempt without respawn or a worker override", async (attemptState) => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const root = s.job("Product", s.lead);
    const work = child(s, root.id, "Fix exit status");
    handIn(s, db, work.id);
    s.attempt(work.id, attemptState);
    s.store.setJobExecutionFacts(s.ctx, { requestId: randomUUID(), jobId: work.id, threadBound: true });
    const sent: Array<{ threadId: string; text: string }> = [];
    const deps = reworkDeps(s, db, sent);
    const owner: ServiceContext = { actor: { kind: "user", userId: "usr_owner" }, allowedBindingIds: [s.bindingId] };
    const input = { requestId: randomUUID(), jobId: work.id, expectedRevision: s.store.getJob(work.id)!.revision, comment: "Reject exit 73 even when stdout says accepted." };
    expect(await returnJobForRework(deps, owner, input)).toMatchObject({ ok: false, error: { code: "rework_limit_reached" } });
    const decision = { ...input, recoveryDecision: { cause: "The exit status was ignored in stdout parsing.", correction: "Return the exact reproducer to the existing worker.", verification: "Confirmed exit 73 reproducer in reviewer artifact." } };
    expect(await returnJobForRework(deps, { ...owner, caller: { threadId: "thr_worker", attemptId: "run_worker", jobId: work.id, agentId: s.developer } }, decision))
      .toMatchObject({ ok: false, error: { code: "recovery_lead_only" } });
    expect(sent).toHaveLength(0);
    expect((await returnJobForRework(deps, { ...owner, caller: { threadId: "thr_lead", attemptId: "run_lead", jobId: root.id, agentId: s.lead } }, decision)).ok).toBe(true);
    expect((await returnJobForRework(deps, { ...owner, caller: { threadId: "thr_lead", attemptId: "run_lead", jobId: root.id, agentId: s.lead } }, decision)).ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agency_run_attempt WHERE job_id = ?").get(work.id)).toEqual({ n: 1 });
    expect(db.prepare("SELECT state FROM agency_run_attempt WHERE job_id = ?").get(work.id)).toEqual({ state: "running" });
    expect(sent[0].text).toContain(decision.recoveryDecision.cause);
    expect(s.store.listActivity(work.id).some(row => row.comment?.includes(decision.recoveryDecision.cause))).toBe(true);
    expect(deps.reworkLimit!(work)).toBe(0);
    expect(db.prepare("SELECT 1 FROM agency_launch_issue WHERE job_id = ?").get(work.id)).toBeUndefined();
    db.close();
  });

  function deliveredRoot(s: Seed, db: Db) {
    const root = s.job("Партия кроссовок", s.lead);
    const facts = s.store.setJobExecutionFacts(s.ctx, { requestId: randomUUID(), jobId: root.id, threadBound: true });
    if (!facts.ok) throw new Error(facts.error.message);
    const station = child(s, root.id, "Пошив");
    const { ports } = conveyor(s, db);
    handIn(s, db, station.id);
    closeStation(ports, station.id, "conveyor-skip-qc");
    handIn(s, db, root.id);
    closeStation(ports, root.id, "conveyor-skip-qc");
    expect(s.store.getJob(root.id)?.state).toBe("done");
    // The line had already marked the attempt as finished.
    s.attempt(root.id, "succeeded");
    return { root, station };
  }

  it("does not return a new result to an older review thread when the latest launch has failed", async () => {
    const db = openMigratedDatabase(new Database(":memory:")); const s = seed(db);
    const root = s.job("Product", s.lead); const work = child(s, root.id, "Implementation");
    handIn(s, db, work.id); s.attempt(work.id, "awaiting_review");
    db.pragma("foreign_keys = OFF");
    db.prepare(`INSERT INTO agency_run_attempt (id, job_id, attempt_no, snapshot_id, digest, thread_id, launch_id, state, revision, created_at, updated_at)
      SELECT ?, job_id, 2, snapshot_id, digest, NULL, ?, 'failed', 1, created_at, updated_at FROM agency_run_attempt WHERE job_id = ?`)
      .run("run_new_failed", randomUUID(), work.id);
    db.pragma("foreign_keys = ON");
    const sent: Array<{ threadId: string; text: string }> = [];
    const deps = { ...reworkDeps(s, db, sent), reworkLimit: undefined };
    const owner: ServiceContext = { actor: { kind: "user", userId: "usr_owner" }, allowedBindingIds: [s.bindingId] };
    expect(await returnJobForRework(deps, owner, { requestId: randomUUID(), jobId: work.id,
      expectedRevision: s.store.getJob(work.id)!.revision, comment: "Fix current result" }))
      .toMatchObject({ ok: false, error: { code: "rework_no_thread" } });
    expect(sent).toHaveLength(0); expect(s.store.getJob(work.id)?.state).toBe("review");
    db.close();
  });

  it("lets the owner return a done root without ever having stamped a station", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const { root, station } = deliveredRoot(s, db);
    // Every accept on the way was the line's own: no person stamped a station.
    const acceptors = db.prepare(`SELECT actor FROM agency_activity WHERE kind = 'artifact_accepted'`).all() as Array<{ actor: string }>;
    expect(acceptors.length).toBeGreaterThan(0);
    expect(acceptors.every((row) => !row.actor.includes("user"))).toBe(true);

    const owner: ServiceContext = { actor: { kind: "user", userId: "usr_owner" }, allowedBindingIds: [s.bindingId] };
    const sent: Array<{ threadId: string; text: string }> = [];
    const live = s.store.getJob(root.id)!;
    const returned = await returnJobForRework(reworkDeps(s, db, sent), owner, {
      requestId: randomUUID(),
      jobId: root.id,
      expectedRevision: live.revision,
      comment: "Подошва отклеивается на всей партии.",
    });
    expect(returned.ok, returned.ok ? "" : returned.error.message).toBe(true);
    expect(s.store.getJob(root.id)?.state).toBe("running");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.threadId).toBe("thr_fixture01");
    expect(sent[0]!.text).toContain("Подошва отклеивается");
    const attempt = db.prepare(`SELECT state FROM agency_run_attempt WHERE job_id = ?`).get(root.id) as { state: string };
    expect(attempt.state).toBe("running");
    const note = db
      .prepare(`SELECT comment FROM agency_activity WHERE job_id = ? AND kind = 'comment' ORDER BY rowid DESC LIMIT 1`)
      .get(root.id) as { comment: string };
    expect(note.comment).toContain("Рекламация");
    // Closed stations inside stay closed: the lead decides what is redone.
    expect(s.store.getJob(station.id)?.state).toBe("done");

    // The reworked product goes down the line again and is delivered again, with a new notice.
    const { ports, ready } = conveyor(s, db);
    handIn(s, db, root.id);
    expect(await advanceAfterHandIn(ports, root.id)).toBe("closed");
    expect(s.store.getJob(root.id)?.state).toBe("done");
    expect(ready).toHaveLength(1);
    db.close();
  });

  it("refuses an employee and refuses to reclaim a single closed station", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const { root, station } = deliveredRoot(s, db);
    const sent: Array<{ threadId: string; text: string }> = [];
    const owner: ServiceContext = { actor: { kind: "user", userId: "usr_owner" }, allowedBindingIds: [s.bindingId] };
    const employee: ServiceContext = {
      ...owner,
      caller: { threadId: "thr_worker0001", attemptId: "run_x", jobId: station.id, agentId: s.developer },
    };
    expect(
      await returnJobForRework(reworkDeps(s, db, sent), employee, {
        requestId: randomUUID(),
        jobId: root.id,
        expectedRevision: s.store.getJob(root.id)!.revision,
        comment: "Верните.",
      }),
    ).toMatchObject({ ok: false, error: { code: "reclamation_owner_only" } });
    expect(
      await returnJobForRework(reworkDeps(s, db, sent), owner, {
        requestId: randomUUID(),
        jobId: station.id,
        expectedRevision: s.store.getJob(station.id)!.revision,
        comment: "Верните.",
      }),
    ).toMatchObject({ ok: false, error: { code: "reclamation_root_only" } });
    expect(sent).toEqual([]);
    expect(s.store.getJob(root.id)?.state).toBe("done");
    db.close();
  });
});
