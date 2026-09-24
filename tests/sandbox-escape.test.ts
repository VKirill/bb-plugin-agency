import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { outsideSandboxItemId, sandboxEscapeCounts, scanSandboxEscapes } from "../src/server/runtime/sandbox-escape/service";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const started = (seq: number, id: string, badge?: { glyph: string; label: string }) => ({
  seq: String(seq),
  type: "item/started",
  data: { item: { type: "commandExecution", id, presentation: { title: "bb agency status", ...(badge ? { badge } : {}) } } },
});
const outside = { glyph: "SquareUnlock02", label: "Outside of sandbox" };

describe("sandbox escapes", () => {
  it("recognises the badge BB puts on a command run outside the sandbox", () => {
    expect(outsideSandboxItemId(started(1, "i1", outside))).toBe("i1");
    expect(outsideSandboxItemId(started(2, "i2"))).toBeNull();
    expect(outsideSandboxItemId({ ...started(3, "i3", outside), type: "item/completed" })).toBeNull();
  });

  it("counts escaped commands per attempt and reads each thread only after its last event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-escape-"));
    dirs.push(dir);
    const db = openMigratedDatabase(new Database(join(dir, "agency.sqlite")));
    try {
      const events = [started(1, "i1"), started(2, "i2", outside), started(3, "i3", outside)];
      const asked: (string | undefined)[] = [];
      const port = {
        list: async ({ afterSeq, limit }: { threadId: string; afterSeq?: string; limit: number }) => {
          if (limit > 100) throw new Error("HTTP 400: Thread event limit cannot exceed 100");
          asked.push(afterSeq);
          return events.filter((event) => !afterSeq || Number(event.seq) > Number(afterSeq));
        },
      };
      const attempt = { attemptId: "run_aaaa0001", jobId: "job_aaaa0001", threadId: "thr_1" };
      const deps = { db, events: port, now: () => "2026-09-17T10:00:00.000Z" };
      expect(await scanSandboxEscapes(deps, [attempt])).toEqual(["run_aaaa0001"]);
      expect(sandboxEscapeCounts(db, ["run_aaaa0001"]).get("run_aaaa0001")).toBe(2);
      expect(await scanSandboxEscapes(deps, [attempt])).toEqual([]);
      events.push(started(4, "i4", outside));
      await scanSandboxEscapes(deps, [attempt]);
      expect(sandboxEscapeCounts(db, ["run_aaaa0001"]).get("run_aaaa0001")).toBe(3);
      expect(asked).toEqual([undefined, "3", "3"]);

      const failing = { list: async () => { throw new Error("offline"); } };
      expect(await scanSandboxEscapes({ ...deps, events: failing }, [{ ...attempt, attemptId: "run_bbbb0001" }])).toEqual([]);
      expect(sandboxEscapeCounts(db, ["run_bbbb0001"]).size).toBe(0);
    } finally {
      db.close();
    }
  });
});

it("does not write events returned after plugin disposal", async () => {
  const db = openMigratedDatabase(new Database(":memory:")); let active = true;
  await expect(scanSandboxEscapes({ db, isActive: () => active, now: () => "2026-09-24T00:00:00Z",
    events: { list: async () => { active = false; db.close(); return [started(1, "late", outside)]; } },
  }, [{ attemptId: "run_late", jobId: "job_late", threadId: "thr_late" }])).resolves.toEqual([]);
});
