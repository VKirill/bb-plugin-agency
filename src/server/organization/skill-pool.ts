import { randomUUID } from "node:crypto";
import { fail, ok, type DomainResult } from "../../domain";
import type { SqlDatabase } from "../db/sql";

/**
 * Библиотека навыков отдела и журнал их выдачи.
 *
 * Навыки в профиле сотрудника — это то, с чем он приходит на любую работу. Библиотека отдела —
 * то, что отдел **вправе** поднять под конкретное задание: оценщик читает ТЗ и открывает из неё
 * только подходящее, на один запуск. Границу по-прежнему ставит человек — владелец или
 * руководитель отдела, — но один раз для отдела, а не на каждую задачу.
 *
 * Каждая выдача попадает в журнал: кому, что, по какой задаче, кто решил и насколько был уверен.
 * Без журнала «динамические права» превращаются в то, что никто не может объяснить.
 */

export const SKILL_POOL_MIGRATION = `CREATE TABLE agency_department_skill (
    department_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    added_by TEXT,
    added_at TEXT NOT NULL,
    PRIMARY KEY (department_id, skill_id)
  )`;

export const SKILL_GRANT_MIGRATION = `CREATE TABLE agency_skill_grant (
    id TEXT PRIMARY KEY,
    department_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    job_key TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    decided_by TEXT NOT NULL,
    confidence REAL,
    created_at TEXT NOT NULL
  )`;

/** Кто открыл навык под задачу. Оценщик — это модель; остальное — человек. */
export const GRANT_DECIDERS = ["decision-model", "lead", "owner"] as const;
export type GrantDecider = (typeof GRANT_DECIDERS)[number];

export type SkillGrant = {
  id: string;
  departmentId: string;
  agentId: string;
  jobId: string;
  jobKey: string;
  skillId: string;
  skillName: string;
  decidedBy: GrantDecider;
  confidence: number | null;
  createdAt: string;
};

function hasTable(db: SqlDatabase, name: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

/** Навыки, которые отдел вправе поднимать под задание. Пусто — библиотеки нет, работают профили. */
export function listSkillPool(db: SqlDatabase, departmentId: string): string[] {
  if (!hasTable(db, "agency_department_skill")) return [];
  return (db.prepare(`SELECT skill_id FROM agency_department_skill WHERE department_id = ? ORDER BY added_at, skill_id`).all(departmentId) as { skill_id: string }[])
    .map((row) => row.skill_id);
}

export function setSkillPool(
  db: SqlDatabase,
  input: { departmentId: string; skillIds: readonly string[] },
  actor: { agentId: string | null },
  now: string,
): DomainResult<{ skillIds: string[] }> {
  if (!hasTable(db, "agency_department_skill")) return fail("not_found", "Библиотека навыков ещё не создана.");
  const wanted = [...new Set(input.skillIds.map((id) => id.trim()).filter(Boolean))];
  if (wanted.length > 60) return fail("invalid_command", "В библиотеке отдела не больше 60 навыков: выберите то, чем отдел правда пользуется.");
  const apply = db.transaction(() => {
    db.prepare(`DELETE FROM agency_department_skill WHERE department_id = ?`).run(input.departmentId);
    for (const skillId of wanted) {
      db.prepare(`INSERT INTO agency_department_skill (department_id, skill_id, added_by, added_at) VALUES (?, ?, ?, ?)`).run(
        input.departmentId,
        skillId,
        actor.agentId,
        now,
      );
    }
  });
  apply();
  return ok({ skillIds: wanted });
}

export function logSkillGrants(
  db: SqlDatabase,
  rows: readonly Omit<SkillGrant, "id" | "createdAt">[],
  now: string,
): void {
  if (!rows.length || !hasTable(db, "agency_skill_grant")) return;
  const insert = db.prepare(
    `INSERT INTO agency_skill_grant (id, department_id, agent_id, job_id, job_key, skill_id, skill_name, decided_by, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const apply = db.transaction(() => {
    for (const row of rows) {
      insert.run(
        `grt_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        row.departmentId,
        row.agentId,
        row.jobId,
        row.jobKey,
        row.skillId,
        row.skillName,
        row.decidedBy,
        row.confidence,
        now,
      );
    }
  });
  apply();
}

/** Журнал выдач: свежие сверху. По нему видно, чего отделу систематически не хватает. */
export function listSkillGrants(db: SqlDatabase, filter: { departmentId?: string; agentId?: string; limit?: number } = {}): SkillGrant[] {
  if (!hasTable(db, "agency_skill_grant")) return [];
  const limit = Math.max(1, Math.min(500, filter.limit ?? 100));
  const rows = db
    .prepare(
      `SELECT * FROM agency_skill_grant
         WHERE (? IS NULL OR department_id = ?) AND (? IS NULL OR agent_id = ?)
         ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(filter.departmentId ?? null, filter.departmentId ?? null, filter.agentId ?? null, filter.agentId ?? null, limit) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    departmentId: String(row.department_id),
    agentId: String(row.agent_id),
    jobId: String(row.job_id),
    jobKey: String(row.job_key),
    skillId: String(row.skill_id),
    skillName: String(row.skill_name),
    decidedBy: (GRANT_DECIDERS as readonly string[]).includes(String(row.decided_by)) ? (row.decided_by as GrantDecider) : "owner",
    confidence: typeof row.confidence === "number" ? row.confidence : null,
    createdAt: String(row.created_at),
  }));
}
