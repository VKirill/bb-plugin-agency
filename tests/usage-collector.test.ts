import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { foldThreadUsage } from "../src/server/runtime/dashboard-usage/epochs";
import type { TokenUsageEventPort } from "../src/server/runtime/dashboard-usage/service";
import { parseTokenUsageEvent } from "../src/server/runtime/dashboard-usage/units";
import {
  USAGE_COLLECTOR_MIGRATION,
  asBoundThreadPort,
  captureBoundThreads,
  createUnionUsageEventPort,
  createUsageCollector,
  createUsageEventStore,
  typedUsageEvent,
} from "../src/server/runtime/usage-collector";

const dirs: string[] = [];
const handles: Database.Database[] = [];

afterEach(() => {
  for (const db of handles.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const here = dirname(fileURLToPath(import.meta.url));
const FABLE_THREAD = "thr_uu5jukubj5";
const fableEvents = JSON.parse(
  readFileSync(join(here, "fixtures/dashboard-usage/fable-usage-observed.json"), "utf8"),
) as unknown[];

function openDb() {
  const dir = mkdtempSync(join(tmpdir(), "agy-usage-"));
  dirs.push(dir);
  const db = new Database(join(dir, "agency.sqlite"));
  handles.push(db);
  db.exec(USAGE_COLLECTOR_MIGRATION);
  return db;
}

function liveOf(events: readonly unknown[]): TokenUsageEventPort {
  return {
    async listUpdated(threadId: string) {
      return events.filter((row) => (row as { threadId?: string }).threadId === threadId);
    },
  };
}

describe("usage collector", () => {
  it("accepts a Set as the bound-thread port", () => {
    const port = asBoundThreadPort(new Set([FABLE_THREAD]));
    expect(port.isBound(FABLE_THREAD)).toBe(true);
    expect(port.isBound("thr_other")).toBe(false);
  });

  it("persists typed Fable rows and replays as duplicate without a second row", async () => {
    const collector = createUsageCollector({ db: openDb(), bound: [FABLE_THREAD], live: liveOf(fableEvents) });
    const first = await collector.capture([FABLE_THREAD]);
    expect(first).toMatchObject({ inserted: 6, duplicate: 0, conflict: 0, malformed: 0, unbound: 0 });
    const second = await collector.capture([FABLE_THREAD]);
    expect(second).toMatchObject({ inserted: 0, duplicate: 6, conflict: 0 });
    expect(collector.store.count(FABLE_THREAD)).toBe(6);
    const seq610 = collector.store.listCaptured(FABLE_THREAD).find((row) => row.seq === 610);
    expect(seq610?.eventId).toBe("evt_zdpnwdvxsr");
    expect(seq610?.total).toEqual({
      inputTokens: 132,
      cachedInputTokens: 966855,
      outputTokens: 1871,
      reasoningOutputTokens: 0,
      totalTokens: 968858,
    });
    expect(seq610?.last.totalTokens).toBe(325643);
    expect(seq610?.providerThreadId).toBe("029b680c-0024-4307-b6ab-5c330a2bdb90");
    expect(seq610?.turnId).toBe("da8efcdff2-t2");
    const reset = collector.store.listCaptured(FABLE_THREAD).find((row) => row.seq === 595);
    expect(reset?.last).toEqual(reset?.total);
  });

  it("round-trips envelopes through ips parse and keeps visible epoch peaks as a lower bound", async () => {
    const collector = createUsageCollector({ db: openDb(), bound: [FABLE_THREAD], live: liveOf(fableEvents) });
    await collector.capture([FABLE_THREAD]);
    const envelopes = collector.store.listEnvelopes(FABLE_THREAD);
    expect(envelopes.map((row) => parseTokenUsageEvent(row)?.id)).toEqual([
      "evt_gx9r2xj5nb",
      "evt_5ii6ju5pcu",
      "evt_iijg386j9c",
      "evt_dbk2pf94wm",
      "evt_s4d993mv97",
      "evt_zdpnwdvxsr",
    ]);
    const fold = foldThreadUsage(envelopes);
    expect(fold.unknown).toBe(false);
    if (fold.unknown) return;
    expect(fold.peaks.totalTokens).toBe(6_697_149);
    expect(fold.sessionLatestTotal.totalTokens).toBe(968_858);
    expect(fold.epochCount).toBe(2);
  });

  it("conflicts on a different payload or seq owner and does not rewrite", async () => {
    const collector = createUsageCollector({ db: openDb(), bound: [FABLE_THREAD], live: liveOf(fableEvents) });
    await collector.capture([FABLE_THREAD]);
    const before = collector.store.listCaptured(FABLE_THREAD).find((row) => row.eventId === "evt_zdpnwdvxsr");
    const mutated = structuredClone(fableEvents.find((row) => (row as { id: string }).id === "evt_zdpnwdvxsr"));
    (mutated as { data: { tokenUsage: { total: { totalTokens: number } } } }).data.tokenUsage.total.totalTokens = 1;
    const typed = typedUsageEvent(FABLE_THREAD, mutated);
    expect(typed).not.toBeNull();
    const conflict = collector.store.ingest(typed!);
    expect(conflict).toMatchObject({ ok: false, error: { code: "request_conflict" } });
    expect(collector.store.listCaptured(FABLE_THREAD).find((row) => row.eventId === "evt_zdpnwdvxsr")?.total).toEqual(
      before?.total,
    );

    const seqTaken = typedUsageEvent(FABLE_THREAD, { ...(fableEvents[0] as object), id: "evt_other_seq", seq: 610 });
    expect(seqTaken).not.toBeNull();
    const seqConflict = collector.store.ingest(seqTaken!);
    expect(seqConflict).toMatchObject({ ok: false, error: { code: "request_conflict" } });
    if (!seqConflict.ok) expect(seqConflict.error.message).toContain("seq 610");
    expect(collector.store.count(FABLE_THREAD)).toBe(6);
  });

  it("does not write unbound or malformed events", async () => {
    const collector = createUsageCollector({ db: openDb(), bound: [FABLE_THREAD], live: liveOf(fableEvents) });
    const unbound = await collector.capture(["thr_other"]);
    expect(unbound).toMatchObject({ unbound: 1, inserted: 0, liveUnavailable: 0 });
    expect(collector.store.count()).toBe(0);
    expect(
      typedUsageEvent(FABLE_THREAD, {
        id: "evt_no_last",
        threadId: FABLE_THREAD,
        seq: 1,
        createdAt: 1789395422171,
        scope: { kind: "turn", turnId: "t1" },
        type: "thread/tokenUsage/updated",
        data: {
          tokenUsage: {
            total: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1 },
          },
        },
      }),
    ).toBeNull();
    expect(typedUsageEvent(FABLE_THREAD, { ...(fableEvents[0] as object), threadId: "thr_other" })).toBeNull();
  });

  it("keeps durable rows when live is unavailable and unions durable over a mutated live copy", async () => {
    const db = openDb();
    const store = createUsageEventStore(db);
    const typed = typedUsageEvent(FABLE_THREAD, fableEvents[5]);
    expect(typed).not.toBeNull();
    expect(store.ingest(typed!).ok).toBe(true);

    const failed = await captureBoundThreads({
      store,
      bound: [FABLE_THREAD],
      live: {
        async listUpdated() {
          return "unavailable";
        },
      },
      threadIds: [FABLE_THREAD],
    });
    expect(failed.liveUnavailable).toBe(1);
    expect(store.count(FABLE_THREAD)).toBe(1);
    expect(store.listCaptured(FABLE_THREAD)[0]?.total.totalTokens).toBe(968858);

    const emptyUnion = createUnionUsageEventPort({
      live: {
        async listUpdated() {
          throw new Error("private-provider-detail");
        },
      },
      store: createUsageEventStore(openDb()),
      bound: [FABLE_THREAD],
    });
    expect(await emptyUnion.listUpdated(FABLE_THREAD)).toBe("unavailable");

    const durableUnion = createUnionUsageEventPort({
      live: {
        async listUpdated() {
          throw new Error("private-provider-detail");
        },
      },
      store,
      bound: [FABLE_THREAD],
    });
    const durableListed = await durableUnion.listUpdated(FABLE_THREAD);
    expect(durableListed).not.toBe("unavailable");
    expect(durableListed).toHaveLength(1);

    const mutated = structuredClone(fableEvents) as Array<{ id: string; data: { tokenUsage: { total: { totalTokens: number } } } }>;
    const last = mutated.find((row) => row.id === "evt_zdpnwdvxsr")!;
    last.data.tokenUsage.total.totalTokens = 1;
    const merged = createUnionUsageEventPort({ live: liveOf(mutated), store, bound: [FABLE_THREAD] });
    const listed = await merged.listUpdated(FABLE_THREAD);
    expect(listed).not.toBe("unavailable");
    const kept = (listed as unknown[]).find((row) => (row as { id: string }).id === "evt_zdpnwdvxsr");
    expect(parseTokenUsageEvent(kept)?.total.totalTokens).toBe(968858);
    expect(await merged.listUpdated(FABLE_THREAD)).toEqual(listed);
  });

  it("stops after await and between threads when shouldContinue is false", async () => {
    const db = openDb();
    const store = createUsageEventStore(db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let continueCapture = true;
    const first = captureBoundThreads({
      store,
      bound: [FABLE_THREAD, "thr_second"],
      live: {
        async listUpdated(threadId) {
          if (threadId === FABLE_THREAD) await gate;
          return liveOf(fableEvents).listUpdated(threadId);
        },
      },
      threadIds: [FABLE_THREAD, "thr_second"],
      shouldContinue: () => continueCapture,
    });
    await Promise.resolve();
    continueCapture = false;
    release();
    expect(await first).toMatchObject({ inserted: 0, liveUnavailable: 0 });
    expect(store.count()).toBe(0);

    const secondDb = openDb();
    const secondStore = createUsageEventStore(secondDb);
    let seen: string[] = [];
    await captureBoundThreads({
      store: secondStore,
      bound: [FABLE_THREAD, "thr_second"],
      live: {
        async listUpdated(threadId) {
          seen.push(threadId);
          return threadId === FABLE_THREAD ? fableEvents : [];
        },
      },
      threadIds: [FABLE_THREAD, "thr_second"],
      shouldContinue: () => seen.length < 1,
    });
    expect(seen).toEqual([FABLE_THREAD]);
    expect(secondStore.count()).toBe(0);
  });

  it("reopens the same Agency table as duplicate", () => {
    const db = openDb();
    const first = createUsageEventStore(db);
    const typed = typedUsageEvent(FABLE_THREAD, fableEvents[5]);
    expect(typed).not.toBeNull();
    const inserted = first.ingest(typed!);
    expect(inserted.ok && inserted.value).toBe("inserted");
    const reopened = createUsageEventStore(db);
    const duplicate = reopened.ingest(typed!);
    expect(duplicate.ok && duplicate.value).toBe("duplicate");
    expect(reopened.count(FABLE_THREAD)).toBe(1);
  });
});
