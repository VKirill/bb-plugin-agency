import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { createRepositories } from "../src/server/db/repositories";
import { seed } from "./role-types.test";

it("shows the newest 400 tree events in stable chronological order without losing stored history", () => {
  const db = openMigratedDatabase(new Database(":memory:")); const s = seed(db);
  const root = s.job("Root", s.lead); const unrelated = s.job("Unrelated", s.developer);
  const child = s.store.createJob(s.ctx, { requestId: randomUUID(), bindingId: s.bindingId, departmentId: s.departmentId,
    title: "Child", brief: "Work", acceptance: "Verified", parentJobId: root.id, assignedAgentId: s.developer, priority: "normal", dueAt: null });
  if (!child.ok) throw new Error(child.error.message);
  const repos = createRepositories(db);
  for (let n = 0; n < 405; n++) repos.activity.insert({ id: `act_history${String(n).padStart(8, "0")}`, jobId: root.id,
    actor: { kind: "system" }, kind: "comment", causationId: null, timestamp: "2099-01-01T00:00:00Z", references: [], comment: `Event ${n}` });
  const base = { actor: { kind: "system" as const }, causationId: null, timestamp: "2099-01-01T00:00:00Z", references: [] };
  repos.activity.insert({ ...base, id: "act_childlatest00", jobId: child.value.id, kind: "comment", comment: "Current child blocker" });
  repos.activity.insert({ ...base, id: "act_childsystem00", jobId: child.value.id, kind: "job_transitioned" });
  repos.activity.insert({ ...base, id: "act_unrelated0000", jobId: unrelated.id, kind: "comment", comment: "Other work" });
  const history = s.store.listActivityTree(root.id);
  expect(history).toHaveLength(400);
  expect(history[0].comment).toBe("Event 6");
  expect(history.at(-1)?.comment).toBe("Current child blocker");
  expect(history.some(a => a.id === "act_childsystem00" || a.id === "act_unrelated0000")).toBe(false);
  expect(s.store.listActivity(root.id).filter(a => a.comment?.startsWith("Event "))).toHaveLength(405);
  expect(repos.activity.listByJobTree(root.id, 2).map(a => a.comment)).toEqual(["Event 404", "Current child blocker"]);
  db.close();
});
