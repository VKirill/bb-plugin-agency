import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { assertOwnershipFree, contractsOverlap, ownershipPrefix } from "../src/server/flow/ownership";
import type { JobContract } from "../src/shared/contracts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const contract = (mayChange: string[]): JobContract => ({ mayChange, mustNotTouch: [], checks: [] });

function database() {
  const dir = mkdtempSync(join(tmpdir(), "agy-owns-"));
  dirs.push(dir);
  const db = openMigratedDatabase(new Database(join(dir, "agency.sqlite")));
  // Only the ownership gate is under test: rows are inserted without their bindings and departments.
  db.pragma("foreign_keys = OFF");
  return db;
}

/** A job row with its contract and, optionally, an attempt in a live state. */
function insertJob(db: ReturnType<typeof database>, input: { id: string; key: string; owns: string[]; attemptState?: string; bindingId?: string }) {
  db.prepare(
    `INSERT INTO agency_job (id, key, binding_id, department_id, title, brief, acceptance, state, priority, revision, updated_at, reviewer_agent_ids, observer_agent_ids, contract_json)
     VALUES (?, ?, ?, 'dep_aaaaaaaa', 'Job', 'Brief', 'Acceptance', 'running', 'normal', 1, ?, '[]', '[]', ?)`,
  ).run(input.id, input.key, input.bindingId ?? "bnd_aaaaaaaa", new Date().toISOString(), JSON.stringify(contract(input.owns)));
  if (!input.attemptState) return;
  db.prepare(
    `INSERT INTO agency_run_attempt (id, job_id, attempt_no, snapshot_id, digest, thread_id, launch_id, state, revision, created_at, updated_at)
     VALUES (?, ?, 1, 'snp_aaaaaaaa', ?, 'thr_a', ?, ?, 1, ?, ?)`,
  ).run(`run_${input.id.slice(4)}`, input.id, "d".repeat(64), randomUUID(), input.attemptState, new Date().toISOString(), new Date().toISOString());
}

describe("two jobs that may change the same files", () => {
  it("compares path prefixes and leaves plain-text lines to exact matches", () => {
    expect(ownershipPrefix("src/cards/**").path).toBe("src/cards");
    expect(ownershipPrefix("публичный API").path).toBeNull();
    expect(contractsOverlap(contract(["src/cards/**"]), contract(["src/cards/card.tsx"]))).toBe("src/cards/**");
    expect(contractsOverlap(contract(["src/cards/card.tsx"]), contract(["src/cards/**"]))).toBe("src/cards/card.tsx");
    expect(contractsOverlap(contract(["src/cards/**"]), contract(["src/billing/**"]))).toBeNull();
    // A folder that only shares a name prefix is a different folder.
    expect(contractsOverlap(contract(["src/card/**"]), contract(["src/cards/**"]))).toBeNull();
    expect(contractsOverlap(contract(["Публичный API"]), contract(["публичный api"]))).toBe("Публичный API");
    expect(contractsOverlap(contract([]), contract(["src/cards/**"]))).toBeNull();
  });

  it("holds a launch while a running job in the same folder owns the files, and never across folders", () => {
    const db = database();
    try {
      insertJob(db, { id: "job_running001", key: "AG-1", owns: ["src/cards/**"], attemptState: "running" });
      insertJob(db, { id: "job_done00001", key: "AG-2", owns: ["src/billing/**"], attemptState: "succeeded" });
      insertJob(db, { id: "job_other0001", key: "AG-3", owns: ["src/cards/**"], attemptState: "running", bindingId: "bnd_other001" });
      const waiting = assertOwnershipFree(db, { id: "job_new000001", bindingId: "bnd_aaaaaaaa", contract: contract(["src/cards/card.tsx"]) }, true);
      expect(waiting).toMatchObject({ ok: false, error: { code: "owns_overlap" } });
      expect(!waiting.ok && waiting.error.message).toContain("AG-1");
      // Another folder is another checkout; a finished attempt holds nothing.
      expect(assertOwnershipFree(db, { id: "job_new000002", bindingId: "bnd_other002", contract: contract(["src/cards/**"]) }, true)).toEqual({ ok: true, value: true });
      expect(assertOwnershipFree(db, { id: "job_new000003", bindingId: "bnd_aaaaaaaa", contract: contract(["src/billing/**"]) }, true)).toEqual({ ok: true, value: true });
      // A job without a contract is not held back.
      expect(assertOwnershipFree(db, { id: "job_new000004", bindingId: "bnd_aaaaaaaa", contract: undefined }, true)).toEqual({ ok: true, value: true });
    } finally {
      db.close();
    }
  });
});
