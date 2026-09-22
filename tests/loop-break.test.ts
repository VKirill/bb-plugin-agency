import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { askLoopBreak, LOOP_BREAK_POINT } from "../src/server/decisions/loop-break";
import { loopEffect } from "../src/server/runtime/loop-break/mark";
import { insertLoopMark } from "../src/server/runtime/loop-break/store";
import { advanceAfterHandIn, closeParentIfChildrenDone } from "../src/server/runtime/conveyor";
import { formatParentWakeText } from "../src/server/runtime/parent-wake";
import { DEFAULT_DECISION_SETTINGS } from "../src/shared/decisions";
import { seed } from "./role-types.test";

const HASH = "ab".repeat(32);

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
}

function comment(s: ReturnType<typeof seed>, jobId: string, text: string) {
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

describe("loop effect", () => {
  it("blocks the same hypothesis and an environment or contract cause, and lets new evidence lift it", () => {
    expect(loopEffect(null)).toBe("allow");
    expect(loopEffect({ relation: "same_loop", cause: "code" })).toBe("block");
    expect(loopEffect({ relation: null, cause: "env" })).toBe("block");
    expect(loopEffect({ relation: null, cause: "contract" })).toBe("block");
    expect(loopEffect({ relation: "new_evidence", cause: "env" })).toBe("allow");
    expect(loopEffect({ relation: null, cause: "code" })).toBe("allow");
    expect(loopEffect({ relation: null, cause: "context" })).toBe("allow");
  });

  it("keeps the wake token last when a note is attached", () => {
    const text = formatParentWakeText({ key: "AG-7", state: "done" }, "act_1", "en", "Loop mark same_loop: stop.");
    const lines = text.split("\n");
    expect(lines.at(-1)).toBe("agency.parentWake:act_1");
    expect(lines).toContain("Loop mark same_loop: stop.");
  });
});

describe("loop break on the line", () => {
  it("does not accept the product when the latest reviewer asked for rework", async () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const main = s.job("Корень", s.lead);
    const review = s.store.createJob(s.ctx, {
      requestId: randomUUID(),
      bindingId: s.ctx.allowedBindingIds[0]!,
      departmentId: s.departmentId,
      title: "Проверка",
      brief: "Проверить.",
      acceptance: "Вердикт.",
      parentJobId: main.id,
      assignedAgentId: s.reviewer,
      priority: "normal",
      dueAt: null,
    });
    if (!review.ok) throw new Error(review.error.message);
    publish(s, main.id);
    publish(s, review.value.id);
    db.prepare(`UPDATE agency_job SET state = 'review' WHERE id = ?`).run(main.id);
    db.prepare(`UPDATE agency_job SET state = 'review' WHERE id = ?`).run(review.value.id);
    comment(s, review.value.id, "Вердикт: доработать\nбаннер исчезает");
    const ports = {
      db,
      store: {
        getJob: (id: string) => s.store.getJob(id),
        acceptArtifactVersion: s.store.acceptArtifactVersion.bind(s.store),
        transitionJob: s.store.transitionJob.bind(s.store),
      },
      ctx: s.ctx,
      requestId: () => randomUUID(),
      comment: () => true,
      autoReview: {
        db,
        getJob: (id: string) => s.store.getJob(id),
        enabled: () => false,
        memberRole: s.store.memberRole,
        latestVersion: () => null,
        createReview: () => ({ ok: false as const, error: { code: "unused", message: "unused" } }),
        attachInput: async () => ({ ok: true as const, value: {} }),
        queue: () => ({ ok: true as const, value: "x" }),
        discard: () => undefined,
        comment: () => true,
        now: () => "2026-09-22T00:00:00.000Z",
      },
    };
    expect(await advanceAfterHandIn(ports, review.value.id)).toBe("closed");
    expect(s.store.getJob(review.value.id)?.state).toBe("done");
    expect(s.store.getJob(main.id)?.state).toBe("review");
    expect(closeParentIfChildrenDone(ports, review.value.id).ok).toBe(true);
    expect(s.store.getJob(main.id)?.state).toBe("review");
    expect(await advanceAfterHandIn(ports, main.id)).toBe("rework");
    expect(s.store.getJob(main.id)?.state).toBe("review");
    db.close();
  });

  it("refuses a subtask of a closed parent and a subtask while the loop mark blocks", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const main = s.job("Корень", s.lead);
    const child = (request: string) =>
      s.store.createJob(s.ctx, {
        requestId: request,
        bindingId: s.ctx.allowedBindingIds[0]!,
        departmentId: s.departmentId,
        title: "Доработка",
        brief: "Починить.",
        acceptance: "Тест.",
        parentJobId: main.id,
        assignedAgentId: s.developer,
        priority: "normal",
        dueAt: null,
      });
    insertLoopMark(db, {
      rootJobId: main.id,
      attemptId: "run_testattempt000000000001",
      fingerprint: "fp-1",
      relation: "same_loop",
      cause: "contract",
      createdAt: "2026-09-22T01:00:00.000Z",
    });
    const blocked = child(randomUUID());
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("loop_blocked");
    const notes = db.prepare(`SELECT dedupe_key FROM agency_owner_message`).all() as Array<{ dedupe_key: string }>;
    expect(notes.map((row) => row.dedupe_key)).toEqual([`loop-blocked:${main.id}:same_loop/contract`]);
    expect(child(randomUUID()).ok).toBe(false);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM agency_owner_message`).get() as { n: number }).n).toBe(1);

    insertLoopMark(db, {
      rootJobId: main.id,
      attemptId: "run_testattempt000000000001",
      fingerprint: "fp-2",
      relation: "new_evidence",
      cause: "code",
      createdAt: "2026-09-22T02:00:00.000Z",
    });
    const allowed = child(randomUUID());
    expect(allowed.ok).toBe(true);

    db.prepare(`UPDATE agency_job SET state = 'done' WHERE id = ?`).run(main.id);
    const closed = child(randomUUID());
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.error.code).toBe("parent_closed");
    db.close();
  });
});

describe("loop break question", () => {
  it("reads a confident same_loop and ignores a low-confidence cause", async () => {
    const settings = { ...DEFAULT_DECISION_SETTINGS, enabled: true, endpointKind: "openrouter" as const, points: [LOOP_BREAK_POINT], revision: 1 };
    const asked = await askLoopBreak(settings, "вердикт", {
      key: "k",
      fetch: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    relation: { value: "same_loop", confidence: 0.91 },
                    cause: { value: "code", confidence: 0.2 },
                  }),
                },
              },
            ],
          }),
        }) as Response) as unknown as typeof fetch,
    });
    expect(asked?.relation).toBe("same_loop");
    expect(asked?.cause).toBeNull();
    expect(loopEffect(asked)).toBe("block");
  });
});
