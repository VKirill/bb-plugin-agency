import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { listJobsForBindings } from "../src/server/api/catalog";
import { contractText, createJobCommandSchema } from "../src/shared/contracts/job";
import { seed } from "./role-types.test";

describe("execution contract", () => {
  it("renders a stable text with only the filled blocks", () => {
    expect(contractText(undefined)).toBe("");
    expect(contractText({ mayChange: [], mustNotTouch: [], checks: [] })).toBe("");
    expect(contractText({ mayChange: ["src/cards/**"], mustNotTouch: [], checks: ["npm test", "npm run build"] })).toBe(
      "Можно менять:\n- src/cards/**\nПроверки перед сдачей:\n- npm test\n- npm run build",
    );
  });

  it("is stored with the job, read back by the workspace and cleared with null", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const created = s.store.createJob(s.ctx, {
      ...createJobCommandSchema.parse({
        requestId: randomUUID(),
        bindingId: s.ctx.allowedBindingIds[0],
        departmentId: s.departmentId,
        title: "С контрактом",
        brief: "Бриф.",
        acceptance: "Критерий.",
        assignedAgentId: s.developer,
      }),
      contract: { mayChange: ["src/cards/**"], mustNotTouch: ["src/billing/**"], checks: ["npm test"] },
    });
    if (!created.ok) throw new Error(created.error.message);
    expect(s.store.getJob(created.value.id)?.contract).toEqual({ mayChange: ["src/cards/**"], mustNotTouch: ["src/billing/**"], checks: ["npm test"] });
    expect(listJobsForBindings(db, s.ctx.allowedBindingIds).find((job) => job.id === created.value.id)?.contract?.checks).toEqual(["npm test"]);

    const untouched = s.store.updateJob(s.ctx, { requestId: randomUUID(), expectedRevision: 1, jobId: created.value.id, title: "Новое имя" });
    expect(untouched.ok && untouched.value.contract?.mayChange).toEqual(["src/cards/**"]);

    const cleared = s.store.updateJob(s.ctx, { requestId: randomUUID(), expectedRevision: 2, jobId: created.value.id, contract: null });
    expect(cleared.ok && "contract" in cleared.value).toBe(false);
    expect(s.store.getJob(created.value.id)?.contract).toBeUndefined();
  });

  it("does not store an empty contract", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const created = s.store.createJob(s.ctx, {
      ...createJobCommandSchema.parse({
        requestId: randomUUID(),
        bindingId: s.ctx.allowedBindingIds[0],
        departmentId: s.departmentId,
        title: "Пустой контракт",
        brief: "Бриф.",
        acceptance: "Критерий.",
      }),
      contract: { mayChange: [], mustNotTouch: [], checks: [] },
    });
    expect(created.ok && "contract" in created.value).toBe(false);
    const row = db.prepare(`SELECT contract_json FROM agency_job WHERE title = 'Пустой контракт'`).get() as { contract_json: string | null };
    expect(row.contract_json).toBe(null);
  });
});
