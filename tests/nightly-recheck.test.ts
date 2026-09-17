import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { fail, ok } from "../src/domain";
import { openMigratedDatabase } from "../src/server/db";
import { acceptedBetween, RECHECK_VERSION_LIMIT, recheckJobText, serverDay, sweepNightlyRecheck, type NightlyRecheckPorts } from "../src/server/runtime/nightly-recheck/service";
import { DEFAULT_WORK_RULES, INHERITED_RULE_KEYS } from "../src/shared/contracts/work-rules";
import { createJobCommandSchema, type Job } from "../src/shared/contracts/job";
import { seed } from "./role-types.test";

function setup() {
  const db = openMigratedDatabase(new Database(":memory:"));
  const s = seed(db);
  const bindingId = s.ctx.allowedBindingIds[0]!;
  const job = (title: string) => {
    const created = s.store.createJob(
      s.ctx,
      createJobCommandSchema.parse({ requestId: randomUUID(), bindingId, departmentId: s.departmentId, title, brief: "Бриф.", acceptance: "Критерий.", assignedAgentId: s.developer }),
    );
    if (!created.ok) throw new Error(created.error.message);
    return created.value;
  };
  let artifact = 0;
  const accept = (item: Job, at: string) => {
    artifact += 1;
    const id = `art_${String(artifact).padStart(24, "0")}`;
    db.prepare(`INSERT INTO agency_artifact (id, job_id) VALUES (?, ?)`).run(id, item.id);
    db.prepare(`INSERT INTO agency_artifact_acceptance (artifact_id, job_id, version, hash, accepted_at) VALUES (?, ?, 1, ?, ?)`).run(id, item.id, "a".repeat(64), at);
    return id;
  };
  return { db, s, bindingId, job, accept };
}

function ports(ctx: ReturnType<typeof setup>, now: Date, overrides: Partial<NightlyRecheckPorts> = {}) {
  const attached: [string, string][] = [];
  const queued: string[] = [];
  const comments: [string, string][] = [];
  const base: NightlyRecheckPorts = {
    db: ctx.db,
    departments: () => [{ id: ctx.s.departmentId, name: "Разработка" }],
    rules: () => ({ nightlyRecheck: true, nightlyRecheckHour: 3 }),
    createReview: ({ departmentId, bindingId, day, versions }) => {
      const text = recheckJobText(day, versions, false);
      return ctx.s.store.createJob(ctx.s.ctx, {
        requestId: randomUUID(),
        bindingId,
        departmentId,
        title: text.title,
        brief: text.brief,
        acceptance: text.acceptance,
        parentJobId: null,
        assignedAgentId: null,
        assignment: "reviewer",
        priority: "normal",
        dueAt: null,
      });
    },
    attach: async (review, version) => {
      attached.push([review.key, version.key]);
      return ok(true);
    },
    queue: (review) => {
      queued.push(review.key);
      return ok(review.id);
    },
    comment: (item, text) => {
      comments.push([item.key, text]);
    },
    now: () => now,
    en: () => false,
    ...overrides,
  };
  return { base, attached, queued, comments };
}

describe("nightly recheck", () => {
  it("is an inherited department rule, off by default at 3 o'clock", () => {
    expect(DEFAULT_WORK_RULES.nightlyRecheck).toBe(false);
    expect(DEFAULT_WORK_RULES.nightlyRecheckHour).toBe(3);
    expect(INHERITED_RULE_KEYS).toEqual(expect.arrayContaining(["nightlyRecheck", "nightlyRecheckHour"]));
  });

  it("waits for its hour, rechecks the day's acceptances once, for the reviewer", async () => {
    const ctx = setup();
    const night = new Date(2026, 8, 18, 3, 30);
    const early = new Date(2026, 8, 18, 2, 30);
    const a = ctx.job("Лендинг");
    const b = ctx.job("Письмо");
    ctx.accept(a, new Date(night.getTime() - 5 * 3_600_000).toISOString());
    ctx.accept(b, new Date(night.getTime() - 2 * 3_600_000).toISOString());
    ctx.accept(ctx.job("Давно"), new Date(night.getTime() - 30 * 3_600_000).toISOString());

    expect(await sweepNightlyRecheck(ports(ctx, early).base)).toEqual([]);

    const run = ports(ctx, night);
    const [key] = await sweepNightlyRecheck(run.base);
    expect(key).toBeTruthy();
    const review = ctx.s.store.getJobByKey(key!)!;
    expect(review.title).toBe(`Ночная перепроверка: принятое ${serverDay(night)}`);
    expect(review.assignedAgentId).toBe(ctx.s.reviewer);
    expect(review.brief).toContain(`${a.key} «Лендинг» — v1`);
    expect(run.attached).toEqual([[key, a.key], [key, b.key]]);
    expect(run.queued).toEqual([key]);
    expect(run.comments).toEqual([[key, "Ночная перепроверка: приложено версий 2 из 2."]]);

    expect(await sweepNightlyRecheck(ports(ctx, new Date(2026, 8, 18, 23, 0)).base)).toEqual([]);
    // The recheck's own acceptance is never rechecked.
    ctx.accept(review, new Date(2026, 8, 18, 12, 0).toISOString());
    expect(acceptedBetween(ctx.db, ctx.s.departmentId, new Date(2026, 8, 18, 4, 0).toISOString(), new Date(2026, 8, 19, 4, 0).toISOString())).toEqual([]);
  });

  it("records a quiet night and continues from the previous window", async () => {
    const ctx = setup();
    const first = new Date(2026, 8, 18, 4, 0);
    const run = ports(ctx, first);
    expect(await sweepNightlyRecheck(run.base)).toEqual([]);
    expect(ctx.db.prepare(`SELECT outcome FROM agency_nightly_recheck`).all()).toEqual([{ outcome: "nothing_accepted" }]);
    const item = ctx.job("Днём");
    ctx.accept(item, new Date(2026, 8, 18, 15, 0).toISOString());
    const next = ports(ctx, new Date(2026, 8, 19, 4, 0));
    expect(await sweepNightlyRecheck(next.base)).toHaveLength(1);
    expect(next.attached.map(([, source]) => source)).toEqual([item.key]);
  });

  it("takes at most the limit and leaves the rest for the next night", async () => {
    const ctx = setup();
    const night = new Date(2026, 8, 18, 3, 0);
    for (let index = 0; index < RECHECK_VERSION_LIMIT + 2; index += 1) {
      ctx.accept(ctx.job(`Работа ${index}`), new Date(night.getTime() - (RECHECK_VERSION_LIMIT + 2 - index) * 60_000).toISOString());
    }
    const run = ports(ctx, night);
    await sweepNightlyRecheck(run.base);
    expect(run.attached).toHaveLength(RECHECK_VERSION_LIMIT);
    expect(run.comments[0]![1]).toContain("Ещё 2 версий отдела ждут следующей ночи.");
    const next = ports(ctx, new Date(2026, 8, 19, 3, 0));
    await sweepNightlyRecheck(next.base);
    expect(next.attached).toHaveLength(2);
  });

  it("does not queue a recheck without inputs and says why", async () => {
    const ctx = setup();
    const night = new Date(2026, 8, 18, 3, 0);
    ctx.accept(ctx.job("Своя работа"), new Date(night.getTime() - 3_600_000).toISOString());
    const run = ports(ctx, night, { attach: async () => fail("self_review", "reviewer cannot check own work") });
    const [key] = await sweepNightlyRecheck(run.base);
    expect(run.queued).toEqual([]);
    expect(run.comments[0]).toEqual([key, expect.stringContaining("Ни одну версию не удалось приложить")]);
  });
});
