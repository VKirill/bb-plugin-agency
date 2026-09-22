import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { seed } from "./role-types.test";
import { createJobCommandSchema } from "../src/shared/contracts/job";
import { traceQuerySchema, traceViewSchema } from "../src/shared/contracts/trace";
import { configureTrace, listTrace, pruneTrace, recordTrace, traceHealth } from "../src/server/runtime/trace/store";
import { traceHandlers } from "../src/server/runtime/trace/handlers";

function setup() {
  const db = openMigratedDatabase(new Database(":memory:")); const s = seed(db);
  const create = (parentJobId?: string) => {
    const r = s.store.createJob(s.ctx, createJobCommandSchema.parse({ requestId: randomUUID(), bindingId: s.ctx.allowedBindingIds[0], departmentId: s.departmentId, title: "Trace", brief: "Private brief", acceptance: "Private criteria", parentJobId, assignedAgentId: s.developer }));
    if (!r.ok) throw Error(r.error.message); return r.value;
  };
  return { db, create };
}

describe("durable diagnostic trace", () => {
  it("groups repeated waits but preserves a cleared-and-returned condition and paginates a whole job tree", () => {
    const { db, create } = setup(); const root = create(); const child = create(root.id); const other = create();
    const wait = { jobId: child.id, step: "queue.gate", outcome: "waiting" as const, reason: "spec_required", collapse: true };
    recordTrace(db, wait); recordTrace(db, wait);
    recordTrace(db, { ...wait, outcome: "succeeded", reason: "ready" }); recordTrace(db, wait);
    recordTrace(db, { ...wait, jobId: other.id });
    const page = listTrace(db, { jobId: root.key, limit: 2 }); expect(traceViewSchema.safeParse(page).success).toBe(true);
    expect(page.records).toHaveLength(2); expect(page.records.every(r => r.rootJobId === root.id)).toBe(true);
    const older = listTrace(db, { jobId: root.id, beforeId: page.nextBeforeId!, limit: 2 });
    expect(older.records).toHaveLength(1); expect(older.records[0]!.repeats).toBe(2);
    expect(older.summary.find(s => s.reason === "spec_required")?.observations).toBe(3);
    expect(listTrace(db, { jobId: root.id, minRepeats: 2 }).records).toHaveLength(1);
    db.close();
  });
  it("logs both sides of failed commands with one request id, never the payload/error text", async () => {
    const { db, create } = setup(); const job = create(); const error = new Error("Bearer secret-value");
    const h = traceHandlers(db, { updateJob: async (_: unknown) => { throw error; } });
    await expect(h.updateJob({ jobId: job.id, requestId: randomUUID(), brief: "sensitive", password: "secret-value" })).rejects.toBe(error);
    const rows = listTrace(db, { jobId: job.id }).records;
    expect(rows.map(r => r.outcome)).toEqual(["failed", "started"]); expect(rows[0]!.requestId).toBe(rows[1]!.requestId);
    recordTrace(db, { jobId: job.id, step: "test", outcome: "failed", reason: "Bearer secret-value", facts: { password: "secret-value", count: 2, cause: "Bearer secret-value" } });
    const serialized = JSON.stringify(listTrace(db, {})); expect(serialized).not.toMatch(/secret-value|sensitive|Private brief|password/);
    expect(listTrace(db, { jobId: job.id, minDurationMs: 0 }).records).toHaveLength(1);
    db.close();
  });
  it("does not break execution when logging fails, reports its health, and applies row/time retention", async () => {
    const { db, create } = setup(); const job = create();
    for (let i=0;i<5;i++) recordTrace(db, { jobId: job.id, step: "test", outcome: "succeeded", reason: "ok" });
    pruneTrace(db, new Date().toISOString(), 2); expect(listTrace(db, {}).records).toHaveLength(2);
    pruneTrace(db, new Date(Date.now()+31*86400000).toISOString()); expect(listTrace(db, {}).records).toHaveLength(0);
    const warn=vi.fn(); configureTrace(db,warn); db.close();
    const h=traceHandlers(db,{ updateJob: async (_: unknown) => ({ok:true,value:42}) });
    await expect(h.updateJob({jobId:job.id})).resolves.toEqual({ok:true,value:42});
    expect(traceHealth(db).writeFailures).toBe(2);expect(warn).toHaveBeenCalledTimes(1);
  });
  it("rejects unbounded/unknown query fields", () => {
    expect(traceQuerySchema.safeParse({limit:10000}).success).toBe(false);
    expect(traceQuerySchema.safeParse({sql:"SELECT *"}).success).toBe(false);
  });
});
