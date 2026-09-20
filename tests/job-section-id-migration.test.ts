import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyAgencyMigrations, migrations } from "../src/server/db/migrations";
import { seed } from "./role-types.test";

const NOW = "2026-09-20T00:00:00.000Z";

describe("миграция Job.sectionId", () => {
  it("дописана в конец и оставляет старые поручения с null", () => {
    const alter = migrations.findIndex((sql) => sql === "ALTER TABLE agency_job ADD COLUMN section_id TEXT");
    expect(alter).toBeGreaterThan(0);
    expect(alter).toBeLessThan(migrations.length);

    const raw = new Database(":memory:");
    applyAgencyMigrations(raw, { throughId: alter - 1 });
    const columns = (raw.prepare(`PRAGMA table_info(agency_job)`).all() as { name: string }[]).map((row) => row.name);
    expect(columns).not.toContain("section_id");

    const s = seed(raw);
    const title = "Старое поручение";
    const brief = "Сохранить бриф.";
    raw.prepare(
      `INSERT INTO agency_job
        (id, key, binding_id, department_id, title, brief, acceptance, state, parent_job_id,
         assigned_agent_id, reviewer_agent_ids, observer_agent_ids, priority, due_at, revision, updated_at,
         closed_at, contract_json, work_profile_key, origin_thread_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'backlog', NULL, ?, '[]', '[]', 'normal', NULL, 1, ?, NULL, NULL, NULL, NULL)`,
    ).run("job_oldsection01", "AG-9001", s.ctx.allowedBindingIds[0], s.departmentId, title, brief, "Критерий.", s.developer, NOW);

    applyAgencyMigrations(raw);
    expect((raw.prepare(`PRAGMA table_info(agency_job)`).all() as { name: string }[]).map((row) => row.name)).toContain(
      "section_id",
    );
    const stored = raw.prepare(`SELECT title, brief, section_id FROM agency_job WHERE id = ?`).get("job_oldsection01") as {
      title: string;
      brief: string;
      section_id: string | null;
    };
    expect(stored).toEqual({ title, brief, section_id: null });
    expect(s.store.getJob("job_oldsection01")?.sectionId).toBeNull();
    expect(s.store.getJob("job_oldsection01")?.title).toBe(title);
    raw.close();
  });
});
