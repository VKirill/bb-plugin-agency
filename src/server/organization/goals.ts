import { randomUUID } from "node:crypto";
import { fail, ok, type DomainResult } from "../../domain";
import type { SqlDatabase } from "../db/sql";

/** Goals above main jobs: what a set of jobs is for, and how far it has got. */

export const GOALS_MIGRATION = `CREATE TABLE agency_goal (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'done', 'dropped')),
    due_at TEXT,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
CREATE TABLE agency_job_goal (
    job_id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

export type GoalStatus = "active" | "done" | "dropped";

export type GoalView = {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  dueAt: string | null;
  revision: number;
  jobIds: string[];
  progress: { total: number; done: number; open: number };
};

type GoalRow = { id: string; title: string; description: string; status: GoalStatus; due_at: string | null; revision: number };

export function listGoals(db: SqlDatabase): GoalView[] {
  const goals = db.prepare(`SELECT id, title, description, status, due_at, revision FROM agency_goal ORDER BY status, created_at`).all() as GoalRow[];
  const links = db
    .prepare(`SELECT g.goal_id, j.id, j.state FROM agency_job_goal g JOIN agency_job j ON j.id = g.job_id`)
    .all() as { goal_id: string; id: string; state: string }[];
  return goals.map((goal) => {
    const jobs = links.filter((link) => link.goal_id === goal.id);
    const done = jobs.filter((job) => job.state === "done").length;
    const open = jobs.filter((job) => job.state !== "done" && job.state !== "canceled").length;
    return {
      id: goal.id,
      title: goal.title,
      description: goal.description,
      status: goal.status,
      dueAt: goal.due_at,
      revision: goal.revision,
      jobIds: jobs.map((job) => job.id),
      progress: { total: jobs.length, done, open },
    };
  });
}

export function saveGoal(
  db: SqlDatabase,
  input: { id?: string; expectedRevision: number; title: string; description: string; status: GoalStatus; dueAt: string | null },
  now: string,
): DomainResult<GoalView> {
  const title = input.title.trim();
  if (!title) return fail("invalid_command", "У цели должно быть название.");
  if (!input.id) {
    const id = `gol_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    db.prepare(`INSERT INTO agency_goal (id, title, description, status, due_at, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).run(
      id, title, input.description.trim(), input.status, input.dueAt, now, now,
    );
    return ok(listGoals(db).find((goal) => goal.id === id)!);
  }
  const changed = db
    .prepare(`UPDATE agency_goal SET title = ?, description = ?, status = ?, due_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`)
    .run(title, input.description.trim(), input.status, input.dueAt, now, input.id, input.expectedRevision);
  if (changed.changes !== 1) return fail("revision_conflict", "Цель изменилась или не найдена: перечитайте и повторите.");
  return ok(listGoals(db).find((goal) => goal.id === input.id)!);
}

/** Only a main job serves a goal: subtasks inherit it through their parent. */
export function setJobGoal(db: SqlDatabase, input: { jobId: string; goalId: string | null }, now: string): DomainResult<{ jobId: string; goalId: string | null }> {
  const job = db.prepare(`SELECT id, parent_job_id FROM agency_job WHERE id = ?`).get(input.jobId) as { id: string; parent_job_id: string | null } | undefined;
  if (!job) return fail("not_found", `job ${input.jobId} not found`);
  if (job.parent_job_id) return fail("invalid_command", "Цель задаётся главной задаче; подзадачи относятся к цели через неё.");
  if (input.goalId === null) {
    db.prepare(`DELETE FROM agency_job_goal WHERE job_id = ?`).run(input.jobId);
    return ok({ jobId: input.jobId, goalId: null });
  }
  if (!db.prepare(`SELECT 1 FROM agency_goal WHERE id = ?`).get(input.goalId)) return fail("not_found", `goal ${input.goalId} not found`);
  db.prepare(
    `INSERT INTO agency_job_goal (job_id, goal_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET goal_id = excluded.goal_id, updated_at = excluded.updated_at`,
  ).run(input.jobId, input.goalId, now);
  return ok({ jobId: input.jobId, goalId: input.goalId });
}

export function jobGoals(db: SqlDatabase): Record<string, string> {
  return Object.fromEntries((db.prepare(`SELECT job_id, goal_id FROM agency_job_goal`).all() as { job_id: string; goal_id: string }[]).map((row) => [row.job_id, row.goal_id]));
}
