import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import {
  deleteWorkProfile,
  getWorkProfile,
  listWorkProfiles,
  normalizeProfileKey,
  saveWorkProfile,
  workProfileBlock,
  workProfileIndex,
  WORK_PROFILE_LIMIT,
} from "../src/server/projects/work-profiles";

const NOW = "2026-09-18T09:00:00.000Z";

function seedProfile(db: ReturnType<typeof openMigratedDatabase>, key = "tg-post", revision = 0) {
  return saveWorkProfile(
    db,
    {
      bbProjectId: "proj_vech",
      key,
      expectedRevision: revision,
      title: "Пост в Telegram",
      triggers: ["пост в телеграм", "тг"],
      body: "Голос Кирилла: коротко, от первого лица, без канцелярита.",
      samples: [{ label: "AG-14", ref: "job:AG-14", note: "40 000 просмотров" }],
      acceptance: "Написано голосом канала, без обещаний вне продукта.",
    },
    NOW,
  );
}

describe("work profiles of a project", () => {
  it("saves, reads and versions a profile", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const first = seedProfile(db);
    expect(first.ok && first.value.revision).toBe(1);
    const stored = getWorkProfile(db, "proj_vech", "tg-post")!;
    expect(stored.title).toBe("Пост в Telegram");
    expect(stored.samples[0]?.ref).toBe("job:AG-14");
    // A stale revision never overwrites someone else's edit.
    expect(seedProfile(db, "tg-post", 0)).toMatchObject({ ok: false, error: { code: "revision_conflict" } });
    const second = seedProfile(db, "tg-post", 1);
    expect(second.ok && second.value.revision).toBe(2);
  });

  it("keeps the key short and machine-readable", () => {
    // Cyrillic drops out of the key: the name stays in the title, the key stays machine-readable.
    expect(normalizeProfileKey("  Пост в Telegram ")).toBe("telegram");
    expect(normalizeProfileKey("Пост")).toBe("");
    expect(normalizeProfileKey("YT Thumbnail")).toBe("yt-thumbnail");
    const db = openMigratedDatabase(new Database(":memory:"));
    expect(saveWorkProfile(db, { bbProjectId: "p", key: "!!!", expectedRevision: 0, title: "t", triggers: [], body: "b", samples: [], acceptance: "" }, NOW)).toMatchObject({
      ok: false,
      error: { code: "invalid_command" },
    });
  });

  it("lists profiles of one project and removes them", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    seedProfile(db);
    saveWorkProfile(db, { bbProjectId: "proj_other", key: "zen-post", expectedRevision: 0, title: "Дзен", triggers: [], body: "Тянучка.", samples: [], acceptance: "" }, NOW);
    expect(listWorkProfiles(db, "proj_vech").map((row) => row.key)).toEqual(["tg-post"]);
    expect(listWorkProfiles(db).length).toBe(2);
    expect(deleteWorkProfile(db, "proj_vech", "tg-post")).toMatchObject({ ok: true, value: { removed: true } });
    expect(deleteWorkProfile(db, "proj_vech", "tg-post")).toMatchObject({ ok: true, value: { removed: false } });
  });

  it("writes an index the lead picks from and a body the executor follows", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    seedProfile(db);
    const profiles = listWorkProfiles(db, "proj_vech");
    const index = workProfileIndex(profiles)!;
    expect(index).toContain("tg-post — Пост в Telegram");
    expect(index).toContain("признаки: пост в телеграм, тг");
    const body = workProfileBlock(profiles[0]!);
    expect(body).toContain("Голос Кирилла");
    expect(body).toContain("Эталоны");
    expect(body).toContain("40 000 просмотров");
    expect(body).toContain("Дополнительно к критерию приёмки");
    expect(workProfileIndex([])).toBeNull();
  });

  it("caps a huge profile so one layer cannot eat the prompt", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    saveWorkProfile(db, { bbProjectId: "p", key: "big", expectedRevision: 0, title: "Большой", triggers: [], body: "я".repeat(WORK_PROFILE_LIMIT * 2), samples: [], acceptance: "" }, NOW);
    expect(workProfileBlock(getWorkProfile(db, "p", "big")!).length).toBe(WORK_PROFILE_LIMIT);
  });
});
