import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyAgencyMigrations, migrations } from "../src/server/db/migrations";
import { seed } from "./role-types.test";

const NOW = "2026-09-20T00:00:00.000Z";

describe("миграция Job.workKind", () => {
  it("добавлена миграцией и оставляет старые поручения с null", () => {
    const alter = migrations.findIndex((sql) => sql === "ALTER TABLE agency_job ADD COLUMN work_kind TEXT");
    expect(alter).toBeGreaterThan(0);
    expect(alter).toBeLessThan(migrations.length);

    const raw = new Database(":memory:");
    applyAgencyMigrations(raw, { throughId: alter - 1 });
    const columns = (raw.prepare(`PRAGMA table_info(agency_job)`).all() as { name: string }[]).map((row) => row.name);
    expect(columns).not.toContain("work_kind");

    const s = seed(raw);
    const title = "Старое поручение";
    const brief = "Сохранить бриф.";
    raw.prepare(
      `INSERT INTO agency_job
        (id, key, binding_id, department_id, title, brief, acceptance, state, parent_job_id,
         assigned_agent_id, reviewer_agent_ids, observer_agent_ids, priority, due_at, revision, updated_at,
         closed_at, contract_json, work_profile_key, origin_thread_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'backlog', NULL, ?, '[]', '[]', 'normal', NULL, 1, ?, NULL, NULL, NULL, NULL)`,
    ).run("job_oldworkkind01", "AG-9002", s.ctx.allowedBindingIds[0], s.departmentId, title, brief, "Критерий.", s.developer, NOW);

    applyAgencyMigrations(raw);
    expect((raw.prepare(`PRAGMA table_info(agency_job)`).all() as { name: string }[]).map((row) => row.name)).toContain(
      "work_kind",
    );
    const stored = raw.prepare(`SELECT title, brief, work_kind FROM agency_job WHERE id = ?`).get("job_oldworkkind01") as {
      title: string;
      brief: string;
      work_kind: string | null;
    };
    expect(stored).toEqual({ title, brief, work_kind: null });
    expect(s.store.getJob("job_oldworkkind01")?.workKind).toBeNull();
    expect(s.store.getJob("job_oldworkkind01")?.title).toBe(title);
    raw.close();
  });
});
