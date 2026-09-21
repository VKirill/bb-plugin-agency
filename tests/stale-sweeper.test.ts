import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { withCallerThread } from "../src/server/api/caller";
import { openMigratedDatabase } from "../src/server/db";
import { applyStaleAnswer } from "../src/server/runtime/stale-answer";
import type { IsolatedSendPort } from "../src/server/runtime/isolated-sdk/send-port";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  escalateStale,
  flushStaleNudges,
  isStaleCandidate,
  recoverStaleNudges,
  STALE_SWEEP_INTERVAL_MS,
  sweepStaleJobs,
  sweepStaleNudges,
} from "../src/server/runtime/stale-sweeper";
import { DEFAULT_WORK_RULES } from "../src/shared/contracts/work-rules";
import { STALE_OUTCOME_CODE } from "../src/shared/contracts/stale-nudge";
import { seed } from "./role-types.test";

const ORIGIN = "thr_originchat01";
const NOW = new Date("2026-09-21T14:00:00.000Z");
const STALE_AT = "2026-09-21T10:00:00.000Z";
const REQUEST = "11111111-1111-4111-8111-111111111111";

function recordingSend(): IsolatedSendPort & { calls: Array<{ threadId: string; text: string }> } {
  const port: IsolatedSendPort & { calls: Array<{ threadId: string; text: string }> } = {
    calls: [],
    async send(args) {
      port.calls.push(args);
      return { kind: "confirmed", delivery: "sent" };
    },
    async recoverContinuation() {
      return "absent";
    },
  };
  return port;
}

function age(db: Database.Database, jobId: string) {
  db.prepare(`UPDATE agency_job SET updated_at = ? WHERE id = ?`).run(STALE_AT, jobId);
}

function comments(s: ReturnType<typeof seed>) {
  const texts: string[] = [];
  return {
    texts,
    comment: (job: { id: string }, text: string) => {
      texts.push(text);
      return s.store.createActivity(s.ctx, {
        requestId: randomUUID(),
        jobId: job.id,
        actor: { kind: "system" },
        kind: "comment",
        causationId: null,
        references: [],
        comment: text,
      }).ok;
    },
  };
}

describe("stale sweeper", () => {
  it("skips waiting_input, live attempts, open dependencies and fresh jobs", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const fresh = s.job("Свежая", s.developer);
    const blocked = s.store.transitionJob(s.ctx, {
      requestId: randomUUID(),
      jobId: fresh.id,
      expectedRevision: fresh.revision,
      to: "blocked",
    });
    expect(blocked.ok).toBe(true);
    db.prepare(`UPDATE agency_job SET updated_at = ? WHERE id = ?`).run(NOW.toISOString(), fresh.id);
    expect(isStaleCandidate(db, s.store.getJob(fresh.id)!, DEFAULT_WORK_RULES, NOW).ok).toBe(false);

    const hung = s.job("Зависла", s.developer);
    const hungBlocked = s.store.transitionJob(s.ctx, {
      requestId: randomUUID(),
      jobId: hung.id,
      expectedRevision: hung.revision,
      to: "blocked",
    });
    expect(hungBlocked.ok).toBe(true);
    age(db, hung.id);
    expect(isStaleCandidate(db, s.store.getJob(hung.id)!, DEFAULT_WORK_RULES, NOW).ok).toBe(true);

    s.attempt(hung.id, "running");
    expect(isStaleCandidate(db, s.store.getJob(hung.id)!, DEFAULT_WORK_RULES, NOW).ok).toBe(true);

    const live = s.job("Идёт попытка", s.developer);
    db.prepare(`UPDATE agency_job SET state = 'running', updated_at = ? WHERE id = ?`).run(STALE_AT, live.id);
    s.attempt(live.id, "running");
    expect(isStaleCandidate(db, s.store.getJob(live.id)!, DEFAULT_WORK_RULES, NOW)).toMatchObject({
      ok: false,
      reason: "live_attempt",
    });
    expect(
      isStaleCandidate(db, s.store.getJob(live.id)!, DEFAULT_WORK_RULES, NOW, { liveAttemptWatched: false }).ok,
    ).toBe(true);
    db.close();
  });

  it("nudges a running job whose leftover attempt is idle, not an active one", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const idle = s.job("Idle зомби", s.developer);
    const active = s.job("Живой ран", s.developer);
    for (const job of [idle, active]) {
      db.prepare(`UPDATE agency_job SET state = 'running', updated_at = ? WHERE id = ?`).run(STALE_AT, job.id);
      const withOrigin = s.store.updateJob(s.ctx, {
        requestId: randomUUID(),
        jobId: job.id,
        expectedRevision: s.store.getJob(job.id)!.revision,
        originThreadId: ORIGIN,
      });
      if (!withOrigin.ok) throw new Error(withOrigin.error.message);
      age(db, job.id);
      s.attempt(job.id, "running");
    }
    db.prepare(`UPDATE agency_run_attempt SET thread_id = 'thr_idlezombie01' WHERE job_id = ?`).run(idle.id);
    db.prepare(`UPDATE agency_run_attempt SET thread_id = 'thr_activerun01' WHERE job_id = ?`).run(active.id);
    const send = recordingSend();
    const first = await sweepStaleNudges({
      db,
      getJob: (id) => s.store.getJob(id),
      rulesFor: () => DEFAULT_WORK_RULES,
      comment: comments(s).comment,
      send,
      now: () => NOW,
      lang: "ru",
      observeThread: async (threadId) => (threadId === "thr_idlezombie01" ? "idle" : "active"),
    });
    expect(first.inserted).toBe(1);
    expect(first.sent).toBe(1);
    expect(send.calls[0]?.text).toContain(idle.key);
    expect(send.calls[0]?.text).not.toContain(active.key);
    db.close();
  });

  it("sends one batched message to the origin chat and comments when origin is missing", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const one = s.job("Первая", s.developer);
    const two = s.job("Вторая", s.developer);
    const none = s.job("Без чата", s.developer);
    for (const job of [one, two]) {
      const moved = s.store.transitionJob(s.ctx, {
        requestId: randomUUID(),
        jobId: job.id,
        expectedRevision: job.revision,
        to: "blocked",
      });
      if (!moved.ok) throw new Error(moved.error.message);
      const updated = s.store.updateJob(s.ctx, {
        requestId: randomUUID(),
        jobId: moved.value.id,
        expectedRevision: moved.value.revision,
        originThreadId: ORIGIN,
      });
      if (!updated.ok) throw new Error(updated.error.message);
      age(db, job.id);
    }
    const blockedNone = s.store.transitionJob(s.ctx, {
      requestId: randomUUID(),
      jobId: none.id,
      expectedRevision: none.revision,
      to: "blocked",
    });
    if (!blockedNone.ok) throw new Error(blockedNone.error.message);
    age(db, none.id);

    const send = recordingSend();
    const log = comments(s);
    const first = await sweepStaleNudges({
      db,
      getJob: (id) => s.store.getJob(id),
      rulesFor: () => DEFAULT_WORK_RULES,
      comment: log.comment,
      send,
      now: () => NOW,
      lang: "ru",
    });
    expect(first.inserted).toBe(3);
    expect(first.sent).toBe(1);
    expect(first.commented).toBe(1);
    expect(send.calls).toHaveLength(1);
    expect(send.calls[0]?.threadId).toBe(ORIGIN);
    expect(send.calls[0]?.text).toContain(one.key);
    expect(send.calls[0]?.text).toContain(two.key);
    expect(send.calls[0]?.text).toContain("stale-answer");
    expect(send.calls[0]?.text).toContain("agency.staleBatch:");
    expect(send.calls[0]?.text).not.toContain(none.key);
    expect(log.texts.some((text) => text.includes("originThreadId пуст"))).toBe(true);

    const again = await sweepStaleNudges({
      db,
      getJob: (id) => s.store.getJob(id),
      rulesFor: () => DEFAULT_WORK_RULES,
      comment: log.comment,
      send,
      now: () => NOW,
      lang: "ru",
    });
    expect(again.inserted).toBe(0);
    expect(again.sent).toBe(0);
    expect(send.calls).toHaveLength(1);
    db.close();
  });

  it("applies cancel from the origin thread and refuses a foreign thread or published close", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const job = s.job("Отменить", s.developer);
    const moved = s.store.transitionJob(s.ctx, {
      requestId: randomUUID(),
      jobId: job.id,
      expectedRevision: job.revision,
      to: "blocked",
    });
    if (!moved.ok) throw new Error(moved.error.message);
    const withOrigin = s.store.updateJob(s.ctx, {
      requestId: randomUUID(),
      jobId: moved.value.id,
      expectedRevision: moved.value.revision,
      originThreadId: ORIGIN,
    });
    if (!withOrigin.ok) throw new Error(withOrigin.error.message);
    age(db, job.id);
    const send = recordingSend();
    await sweepStaleNudges({
      db,
      getJob: (id) => s.store.getJob(id),
      rulesFor: () => DEFAULT_WORK_RULES,
      comment: comments(s).comment,
      send,
      now: () => NOW,
      lang: "en",
    });
    const live = s.store.getJob(job.id)!;
    const id = (db.prepare(`SELECT nudge_id FROM agency_stale_nudge WHERE job_id = ?`).get(live.id) as { nudge_id: string }).nudge_id;
    expect(id.startsWith(`stale:${live.id}:`)).toBe(true);

    const foreign = applyStaleAnswer({ db, store: s.store, now: () => NOW }, s.ctx, {
      requestId: REQUEST,
      jobId: live.key,
      nudgeId: id,
      expectedJobRevision: live.revision,
      decision: "cancel",
      reason: "Тест маршрута закрыт.",
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe("foreign_thread");

    const staleRev = withCallerThread(ORIGIN, () =>
      applyStaleAnswer({ db, store: s.store, now: () => NOW }, s.ctx, {
        requestId: randomUUID(),
        jobId: live.key,
        nudgeId: id,
        expectedJobRevision: live.revision - 1,
        decision: "cancel",
        reason: "Тест маршрута закрыт.",
      }),
    );
    expect(staleRev.ok).toBe(false);
    if (!staleRev.ok) expect(staleRev.error.code).toBe("revision_conflict");
    expect(s.store.getJob(live.id)?.state).toBe("blocked");

    const canceled = withCallerThread(ORIGIN, () =>
      applyStaleAnswer({ db, store: s.store, now: () => NOW }, s.ctx, {
        requestId: randomUUID(),
        jobId: live.key,
        nudgeId: id,
        expectedJobRevision: live.revision,
        decision: "cancel",
        reason: "Тест маршрута закрыт.",
      }),
    );
    expect(canceled.ok).toBe(true);
    if (canceled.ok) {
      expect(canceled.value.jobState).toBe("canceled");
      expect(canceled.value.outcomeCode).toBe(STALE_OUTCOME_CODE);
      expect(canceled.value.decision).toBe("cancel");
    }
    expect(s.store.getJob(live.id)?.state).toBe("canceled");

    const published = s.job("С версией", s.developer);
    const pubBlocked = s.store.transitionJob(s.ctx, {
      requestId: randomUUID(),
      jobId: published.id,
      expectedRevision: published.revision,
      to: "blocked",
    });
    if (!pubBlocked.ok) throw new Error(pubBlocked.error.message);
    const pubOrigin = s.store.updateJob(s.ctx, {
      requestId: randomUUID(),
      jobId: pubBlocked.value.id,
      expectedRevision: pubBlocked.value.revision,
      originThreadId: ORIGIN,
    });
    if (!pubOrigin.ok) throw new Error(pubOrigin.error.message);
    age(db, published.id);
    const artifact = s.store.createArtifact(s.ctx, { requestId: randomUUID(), jobId: published.id });
    if (!artifact.ok) throw new Error(artifact.error.message);
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO agency_artifact_version (artifact_id, job_id, version, host_id, relative_path, mime, size, hash, author)
       VALUES (?, ?, 1, 'host_mini', 'report.md', 'text/markdown', 12, ?, '{"kind":"system"}')`,
    ).run(artifact.value.id, published.id, "ab".repeat(32));
    db.pragma("foreign_keys = ON");
    await sweepStaleNudges({
      db,
      getJob: (id) => s.store.getJob(id),
      rulesFor: () => DEFAULT_WORK_RULES,
      comment: comments(s).comment,
      send: recordingSend(),
      now: () => new Date(NOW.getTime() + 2 * 3_600_000),
      lang: "en",
    });
    const pubLive = s.store.getJob(published.id)!;
    const pubNudge = (db.prepare(`SELECT nudge_id FROM agency_stale_nudge WHERE job_id = ?`).get(pubLive.id) as { nudge_id: string } | undefined)
      ?.nudge_id;
    expect(pubNudge).toBeDefined();
    const refused = withCallerThread(ORIGIN, () =>
      applyStaleAnswer({ db, store: s.store, now: () => NOW }, s.ctx, {
        requestId: randomUUID(),
        jobId: pubLive.key,
        nudgeId: pubNudge!,
        expectedJobRevision: pubLive.revision,
        decision: "close",
        reason: "Кажется, уже готово.",
      }),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("needs_acceptance");
    expect(s.store.getJob(published.id)?.state).toBe("blocked");
    db.close();
  });

  it("keep moves nextCheckAt without changing state or resetting the episode", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const job = s.job("Подождать", s.developer);
    const moved = s.store.transitionJob(s.ctx, {
      requestId: randomUUID(),
      jobId: job.id,
      expectedRevision: job.revision,
      to: "blocked",
    });
    if (!moved.ok) throw new Error(moved.error.message);
    s.store.updateJob(s.ctx, {
      requestId: randomUUID(),
      jobId: moved.value.id,
      expectedRevision: moved.value.revision,
      originThreadId: ORIGIN,
    });
    age(db, job.id);
    await sweepStaleNudges({
      db,
      getJob: (id) => s.store.getJob(id),
      rulesFor: () => DEFAULT_WORK_RULES,
      comment: comments(s).comment,
      send: recordingSend(),
      now: () => NOW,
      lang: "en",
    });
    const live = s.store.getJob(job.id)!;
    const id = (db.prepare(`SELECT nudge_id FROM agency_stale_nudge WHERE job_id = ?`).get(live.id) as { nudge_id: string }).nudge_id;
    const kept = withCallerThread(ORIGIN, () =>
      applyStaleAnswer({ db, store: s.store, now: () => NOW }, s.ctx, {
        requestId: randomUUID(),
        jobId: live.id,
        nudgeId: id,
        expectedJobRevision: live.revision,
        decision: "keep",
        reason: "Ждём деплой.",
        nextCheckHours: 48,
      }),
    );
    expect(kept.ok).toBe(true);
    if (kept.ok) {
      expect(kept.value.jobState).toBe("blocked");
      expect(kept.value.nextCheckAt).toBe("2026-09-23T14:00:00.000Z");
    }
    expect(s.store.getJob(live.id)?.state).toBe("blocked");
    const row = db.prepare(`SELECT decision, next_check_at, attempt FROM agency_stale_nudge WHERE nudge_id = ?`).get(id) as {
      decision: string;
      next_check_at: string;
      attempt: number;
    };
    expect(row.decision).toBe("keep");
    expect(row.attempt).toBe(1);
    expect(row.next_check_at).toBe("2026-09-23T14:00:00.000Z");
    db.close();
  });

  it("skips waiting_input, queued, open dependency and a zero threshold", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const wait = s.job("Ждёт сырьё", s.developer);
    db.prepare(`UPDATE agency_job SET state = 'waiting_input', updated_at = ? WHERE id = ?`).run(STALE_AT, wait.id);
    const queued = s.job("В очереди", s.developer);
    const queuedBlocked = s.store.transitionJob(s.ctx, {
      requestId: randomUUID(),
      jobId: queued.id,
      expectedRevision: queued.revision,
      to: "blocked",
    });
    if (!queuedBlocked.ok) throw new Error(queuedBlocked.error.message);
    age(db, queued.id);
    db.prepare(`INSERT INTO agency_launch_queue (job_id, requested_at, updated_at) VALUES (?, ?, ?)`).run(
      queued.id,
      STALE_AT,
      STALE_AT,
    );
    const blocker = s.job("Блокер", s.developer);
    const waiting = s.job("Ждёт зависимость", s.developer);
    const waitingBlocked = s.store.transitionJob(s.ctx, {
      requestId: randomUUID(),
      jobId: waiting.id,
      expectedRevision: waiting.revision,
      to: "blocked",
    });
    if (!waitingBlocked.ok) throw new Error(waitingBlocked.error.message);
    s.store.updateJob(s.ctx, {
      requestId: randomUUID(),
      jobId: waitingBlocked.value.id,
      expectedRevision: waitingBlocked.value.revision,
      originThreadId: ORIGIN,
    });
    age(db, waiting.id);
    db.prepare(`INSERT INTO agency_job_dependency (job_id, depends_on_job_id) VALUES (?, ?)`).run(waiting.id, blocker.id);
    const off = s.job("Порог ноль", s.developer);
    const offBlocked = s.store.transitionJob(s.ctx, {
      requestId: randomUUID(),
      jobId: off.id,
      expectedRevision: off.revision,
      to: "blocked",
    });
    if (!offBlocked.ok) throw new Error(offBlocked.error.message);
    s.store.updateJob(s.ctx, {
      requestId: randomUUID(),
      jobId: offBlocked.value.id,
      expectedRevision: offBlocked.value.revision,
      originThreadId: ORIGIN,
    });
    age(db, off.id);

    const send = recordingSend();
    const ports = {
      db,
      getJob: (id: string) => s.store.getJob(id),
      rulesForDepartment: (departmentId: string) =>
        departmentId === s.departmentId && off.id
          ? DEFAULT_WORK_RULES
          : DEFAULT_WORK_RULES,
      comment: comments(s).comment,
      send,
      now: () => NOW,
      lang: "ru" as const,
    };
    expect(isStaleCandidate(db, s.store.getJob(wait.id)!, DEFAULT_WORK_RULES, NOW).ok).toBe(false);
    expect(isStaleCandidate(db, s.store.getJob(queued.id)!, DEFAULT_WORK_RULES, NOW)).toMatchObject({
      ok: false,
      reason: "launch_queue",
    });
    expect(isStaleCandidate(db, s.store.getJob(waiting.id)!, DEFAULT_WORK_RULES, NOW)).toMatchObject({
      ok: false,
      reason: "open_dependency",
    });
    expect(isStaleCandidate(db, s.store.getJob(off.id)!, { ...DEFAULT_WORK_RULES, staleHoursBlocked: 0 }, NOW)).toMatchObject({
      ok: false,
      reason: "rule_off",
    });
    const result = await sweepStaleJobs({
      ...ports,
      rulesFor: () => ({ ...DEFAULT_WORK_RULES, staleHoursBlocked: 0, staleHoursRunning: 0 }),
    });
    expect(result.inserted).toBe(0);
    expect(send.calls).toHaveLength(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM agency_stale_nudge`).get() as { n: number }).toEqual({ n: 0 });
    db.close();
  });

  it("recovers a claimed batch after restart without a second send", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const job = s.job("Рестарт", s.developer);
    const moved = s.store.transitionJob(s.ctx, {
      requestId: randomUUID(),
      jobId: job.id,
      expectedRevision: job.revision,
      to: "blocked",
    });
    if (!moved.ok) throw new Error(moved.error.message);
    s.store.updateJob(s.ctx, {
      requestId: randomUUID(),
      jobId: moved.value.id,
      expectedRevision: moved.value.revision,
      originThreadId: ORIGIN,
    });
    age(db, job.id);
    const send = recordingSend();
    const ports = {
      db,
      getJob: (id: string) => s.store.getJob(id),
      rulesFor: () => DEFAULT_WORK_RULES,
      comment: comments(s).comment,
      send,
      now: () => NOW,
      lang: "ru" as const,
    };
    await sweepStaleJobs(ports);
    expect(send.calls).toHaveLength(1);
    db.prepare(`UPDATE agency_stale_nudge SET send_state = 'pending'`).run();
    send.recoverContinuation = async () => "present";
    const recovered = await recoverStaleNudges(ports);
    expect(recovered.sent).toBe(1);
    expect(send.calls).toHaveLength(1);
    const again = await sweepStaleJobs(ports);
    expect(again.inserted).toBe(0);
    expect(send.calls).toHaveLength(1);
    db.close();
  });

  it("comments once on rejected send and does not send again", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const job = s.job("Чат удалён", s.developer);
    const moved = s.store.transitionJob(s.ctx, {
      requestId: randomUUID(),
      jobId: job.id,
      expectedRevision: job.revision,
      to: "blocked",
    });
    if (!moved.ok) throw new Error(moved.error.message);
    s.store.updateJob(s.ctx, {
      requestId: randomUUID(),
      jobId: moved.value.id,
      expectedRevision: moved.value.revision,
      originThreadId: ORIGIN,
    });
    age(db, job.id);
    const log = comments(s);
    const send: IsolatedSendPort & { calls: Array<{ threadId: string; text: string }> } = {
      calls: [],
      async send(args) {
        send.calls.push(args);
        return { kind: "rejected", code: "thread_gone", message: "archived" };
      },
      async recoverContinuation() {
        return "absent";
      },
    };
    const ports = {
      db,
      getJob: (id: string) => s.store.getJob(id),
      rulesFor: () => DEFAULT_WORK_RULES,
      comment: log.comment,
      send,
      now: () => NOW,
      lang: "ru" as const,
    };
    await sweepStaleJobs(ports);
    expect(send.calls).toHaveLength(1);
    expect(log.texts.filter((text) => text.includes("не доставил"))).toHaveLength(1);
    await sweepStaleJobs(ports);
    expect(send.calls).toHaveLength(1);
    expect(log.texts.filter((text) => text.includes("не доставил"))).toHaveLength(1);
    expect(s.store.getJob(job.id)?.state).toBe("blocked");
    db.close();
  });

  it("escalates once after three unanswered attempts and leaves the job state", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const job = s.job("Молчание", s.developer);
    const moved = s.store.transitionJob(s.ctx, {
      requestId: randomUUID(),
      jobId: job.id,
      expectedRevision: job.revision,
      to: "blocked",
    });
    if (!moved.ok) throw new Error(moved.error.message);
    const withOrigin = s.store.updateJob(s.ctx, {
      requestId: randomUUID(),
      jobId: moved.value.id,
      expectedRevision: moved.value.revision,
      originThreadId: ORIGIN,
    });
    if (!withOrigin.ok) throw new Error(withOrigin.error.message);
    age(db, job.id);
    const live = s.store.getJob(job.id)!;
    const candidate = isStaleCandidate(db, live, DEFAULT_WORK_RULES, NOW);
    if (!candidate.ok) throw new Error(candidate.reason);
    const stateSince = candidate.stateSince;
    const owner: Array<{ dedupeKey?: string; text: string }> = [];
    const send = recordingSend();
    const ports = {
      db,
      getJob: (id: string) => s.store.getJob(id),
      rulesFor: () => DEFAULT_WORK_RULES,
      comment: comments(s).comment,
      recordOwnerMessage: (
        _db: Database.Database,
        input: { text: string; dedupeKey?: string },
        _source: string,
        _now: string,
      ) => {
        if (owner.some((item) => item.dedupeKey === input.dedupeKey)) {
          return { ok: true as const, value: { message: { id: "msg_test" } as never, duplicate: true } };
        }
        owner.push({ dedupeKey: input.dedupeKey, text: input.text });
        return { ok: true as const, value: { message: { id: "msg_test" } as never, duplicate: false } };
      },
      send,
      now: () => NOW,
      lang: "ru" as const,
    };
    for (const n of [1, 2, 3]) {
      db.prepare(
        `INSERT INTO agency_stale_nudge (
           nudge_id, batch_id, job_id, origin_thread_id, state_since, attempt, send_state,
           dispatch_claimed, queued_message_id, revision_at_send, next_check_at, decision, reason_code, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 1, NULL, 1, NULL, NULL, NULL, ?)`,
      ).run(`stale:${live.id}:${stateSince}:${n}`, `stalebatch:${ORIGIN}:1`, live.id, ORIGIN, stateSince, n, STALE_AT);
    }
    const first = await sweepStaleJobs(ports);
    expect(first.escalated).toBe(1);
    expect(owner).toHaveLength(1);
    expect(owner[0]?.dedupeKey).toBe(`stale:${live.id}:${stateSince}:exhausted`);
    expect(send.calls).toHaveLength(0);
    expect(s.store.getJob(live.id)?.state).toBe("blocked");
    const second = await sweepStaleJobs(ports);
    expect(second.escalated).toBe(0);
    expect(owner).toHaveLength(1);
    const once = escalateStale(ports, live, "повтор", `stale:${live.id}:${stateSince}:exhausted`);
    expect(once).toBe(false);
    db.close();
  });

  it("exports the sweep interval and never transitions a job to done", () => {
    expect(STALE_SWEEP_INTERVAL_MS).toBe(5 * 60 * 1000);
    const source = readFileSync(resolve(__dirname, "../src/server/runtime/stale-sweeper/service.ts"), "utf8");
    expect(source).not.toMatch(/transitionJob/);
    expect(source).not.toMatch(/to:\s*"done"/);
    expect(flushStaleNudges).toEqual(expect.any(Function));
    expect(sweepStaleNudges).toBe(sweepStaleJobs);
  });
});
