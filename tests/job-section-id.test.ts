import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ok } from "../src/domain";
import { openMigratedDatabase } from "../src/server/db";
import { reviewJobText, startAutoReview, type AutoReviewPorts } from "../src/server/runtime/auto-review/service";
import { saveNextStep, sweepNextSteps, type NextStepPorts } from "../src/server/flow/service";
import { createJobCommandSchema, jobSchema, updateJobCommandSchema } from "../src/shared/contracts/job";
import { knowledgeSectionIdSchema } from "../src/shared/contracts/knowledge-scope";
import { seed } from "./role-types.test";

const SECTION = "sec_job_section_aaaa";
const OTHER = "sec_job_section_bbbb";

function setup() {
  const db = openMigratedDatabase(new Database(":memory:"));
  const s = seed(db);
  return { db, s };
}

function create(
  s: ReturnType<typeof seed>,
  extra: Record<string, unknown> = {},
) {
  return s.store.createJob(
    s.ctx,
    createJobCommandSchema.parse({
      requestId: randomUUID(),
      bindingId: s.ctx.allowedBindingIds[0],
      departmentId: s.departmentId,
      title: extra.title ?? "Задача",
      brief: "Бриф.",
      acceptance: "Критерий.",
      assignedAgentId: extra.assignedAgentId ?? s.developer,
      ...extra,
    }),
  );
}

describe("Job.sectionId", () => {
  it("stores the field, defaults to null, and reuses the section id schema", () => {
    expect(knowledgeSectionIdSchema.parse(`  ${SECTION}  `)).toBe(SECTION);
    const { s } = setup();
    const withSection = create(s, { title: "С разделом", sectionId: SECTION });
    expect(withSection.ok && withSection.value.sectionId).toBe(SECTION);
    expect(jobSchema.parse(withSection.ok && withSection.value).sectionId).toBe(SECTION);
    expect(s.store.getJob(withSection.ok ? withSection.value.id : "")?.sectionId).toBe(SECTION);

    const omitted = create(s, { title: "Без раздела" });
    expect(omitted.ok && omitted.value.sectionId).toBeNull();
    expect(s.store.getJob(omitted.ok ? omitted.value.id : "")?.sectionId).toBeNull();

    expect(updateJobCommandSchema.safeParse({
      requestId: randomUUID(),
      expectedRevision: 1,
      jobId: "job_aaaaaaaaaaaa",
      sectionId: SECTION,
    }).success).toBe(false);
  });

  it("lets a subtask inherit the main job section and rejects a different one", () => {
    const { s } = setup();
    const main = create(s, { title: "Главная", sectionId: SECTION, assignedAgentId: s.lead });
    expect(main.ok).toBe(true);
    if (!main.ok) throw new Error(main.error.message);

    const inherited = create(s, { title: "Под", parentJobId: main.value.id });
    expect(inherited.ok && inherited.value.sectionId).toBe(SECTION);

    const same = create(s, { title: "Та же", parentJobId: main.value.id, sectionId: SECTION });
    expect(same.ok && same.value.sectionId).toBe(SECTION);

    const other = create(s, { title: "Чужая", parentJobId: main.value.id, sectionId: OTHER });
    expect(other.ok).toBe(false);
    if (other.ok) throw new Error("expected invalid_command");
    expect(other.error.code).toBe("invalid_command");
    expect(other.error.message).toMatch(/sectionId|раздел/i);
  });

  it("auto-review inherits sectionId through createJob", async () => {
    const { db, s } = setup();
    const main = create(s, { title: "Главная", sectionId: SECTION, assignedAgentId: s.lead });
    if (!main.ok) throw new Error(main.error.message);
    const work = create(s, { title: "Реализация", parentJobId: main.value.id });
    if (!work.ok) throw new Error(work.error.message);
    db.prepare(`UPDATE agency_job SET state = 'review' WHERE id = ?`).run(work.value.id);
    const version = { artifactId: "art_section01", version: 1, hash: "ab".repeat(32) };
    const ports: AutoReviewPorts = {
      db,
      getJob: (id) => s.store.getJob(id),
      enabled: () => true,
      memberRole: (departmentId, agentId) => s.store.memberRole(departmentId, agentId),
      latestVersion: () => version,
      createReview: (job, v) => {
        const text = reviewJobText(job, v);
        return s.store.createJob({ actor: { kind: "system" }, allowedBindingIds: [job.bindingId] }, {
          requestId: randomUUID(),
          bindingId: job.bindingId,
          departmentId: job.departmentId,
          title: text.title,
          brief: text.brief,
          acceptance: text.acceptance,
          parentJobId: job.parentJobId ?? job.id,
          assignedAgentId: null,
          assignment: "reviewer",
          priority: job.priority,
          dueAt: job.dueAt,
        });
      },
      attachInput: async () => ok({}),
      queue: () => ok("queued"),
      comment: () => true,
      discard: () => undefined,
      now: () => "2026-09-20T00:00:00.000Z",
    };
    expect(await startAutoReview(ports, work.value.id)).toBe("created");
    const review = db.prepare(`SELECT id FROM agency_job WHERE title LIKE 'Проверка %'`).get() as { id: string };
    expect(s.store.getJob(review.id)?.sectionId).toBe(SECTION);
  });

  it("next-step keeps the source sectionId even on a root job", async () => {
    const { db, s } = setup();
    const source = create(s, { title: "Исследование", sectionId: SECTION });
    if (!source.ok) throw new Error(source.error.message);
    const saved = saveNextStep(
      db,
      source.value,
      { departmentId: s.departmentId, title: "Проверить", brief: "Бриф.", acceptance: "Критерий.", assignment: "lead" },
      "2026-09-20T00:00:00.000Z",
      false,
    );
    expect(saved.ok).toBe(true);
    db.prepare(`UPDATE agency_job SET state = 'done' WHERE id = ?`).run(source.value.id);
    const ports: NextStepPorts = {
      db,
      getJob: (id) => s.store.getJob(id),
      createJob: (from, step) =>
        s.store.createJob(s.ctx, {
          requestId: randomUUID(),
          bindingId: from.bindingId,
          departmentId: step.departmentId,
          title: step.title,
          brief: step.brief,
          acceptance: step.acceptance,
          parentJobId: from.parentJobId,
          sectionId: from.sectionId ?? null,
          assignedAgentId: null,
          assignment: step.assignment,
          priority: from.priority,
          dueAt: null,
        }),
      attachAccepted: async () => ok(0),
      queue: (job) => ok(job.id),
      comment: () => undefined,
      now: () => "2026-09-20T00:00:00.000Z",
      en: () => false,
    };
    const createdKeys = await sweepNextSteps(ports);
    expect(createdKeys).toHaveLength(1);
    const nextId = (db.prepare(`SELECT id FROM agency_job WHERE key = ?`).get(createdKeys[0]!) as { id: string }).id;
    expect(s.store.getJob(nextId)?.sectionId).toBe(SECTION);
  });
});
