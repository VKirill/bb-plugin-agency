import { randomUUID } from "node:crypto";
import type { SqlDatabase } from "../db/sql";

/**
 * Журнал оценщика. Каждое обращение к точке решения — строка: какая точка, какая задача,
 * чем кончилось, ответы с уверенностью и сколько миллисекунд заняло. Брифа и ключей здесь нет:
 * иначе журнал нельзя было бы смотреть в UI и в CLI.
 *
 * Без журнала новые точки (оценка на входе, привратник сдачи) не видны, пока не случится
 * побочный эффект в истории задачи. Молчание и отказ тоже пишем: иначе «оценщик молчит»
 * неотличимо от «оценщика не звали».
 */

export const DECISION_LOG_MIGRATION = `CREATE TABLE agency_decision_log (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    point TEXT NOT NULL,
    job_key TEXT,
    outcome TEXT NOT NULL,
    detail TEXT NOT NULL,
    answers TEXT NOT NULL,
    ms INTEGER NOT NULL
  )`;

const KEEP = 1_000;

export type DecisionLogRecord = {
  id: string;
  createdAt: string;
  point: string;
  jobKey: string | null;
  outcome: string;
  detail: string;
  answers: string;
  ms: number;
};

export type DecisionLogInput = {
  point: string;
  jobKey?: string | null;
  outcome: string;
  detail: string;
  answers?: string;
  ms?: number;
};

function hasTable(db: SqlDatabase): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agency_decision_log'`).get());
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

export function formatDecisionAnswers(
  answers: readonly { id: string; value: string | number | boolean; confidence: number }[],
): string {
  return clip(
    answers.map((row) => `${row.id}=${String(row.value)}@${Math.round(row.confidence * 100)}`).join(","),
    500,
  );
}

export function appendDecisionLog(db: SqlDatabase, input: DecisionLogInput, now: string): DecisionLogRecord | null {
  if (!hasTable(db)) return null;
  const record: DecisionLogRecord = {
    id: randomUUID(),
    createdAt: now,
    point: clip(input.point, 40),
    jobKey: input.jobKey?.trim() ? clip(input.jobKey.trim(), 40) : null,
    outcome: clip(input.outcome, 40),
    detail: clip(input.detail, 200),
    answers: clip(input.answers ?? "", 500),
    ms: Math.max(0, Math.round(input.ms ?? 0)),
  };
  db.prepare(
    `INSERT INTO agency_decision_log (id, created_at, point, job_key, outcome, detail, answers, ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(record.id, record.createdAt, record.point, record.jobKey, record.outcome, record.detail, record.answers, record.ms);
  const extra = db
    .prepare(
      `SELECT id FROM agency_decision_log ORDER BY rowid DESC LIMIT -1 OFFSET ?`,
    )
    .all(KEEP) as Array<{ id: string }>;
  if (extra.length) {
    const del = db.prepare(`DELETE FROM agency_decision_log WHERE id = ?`);
    for (const row of extra) del.run(row.id);
  }
  return record;
}

export function listDecisionLog(db: SqlDatabase, limit = 50): DecisionLogRecord[] {
  if (!hasTable(db)) return [];
  const take = Math.max(1, Math.min(200, Math.round(limit)));
  const rows = db
    .prepare(
      `SELECT id, created_at, point, job_key, outcome, detail, answers, ms
       FROM agency_decision_log ORDER BY rowid DESC LIMIT ?`,
    )
    .all(take) as Array<{
    id: string;
    created_at: string;
    point: string;
    job_key: string | null;
    outcome: string;
    detail: string;
    answers: string;
    ms: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    point: row.point,
    jobKey: row.job_key,
    outcome: row.outcome,
    detail: row.detail,
    answers: row.answers,
    ms: row.ms,
  }));
}

export function decisionLogLine(record: DecisionLogRecord): string {
  const job = record.jobKey ?? "—";
  const answers = record.answers ? ` ${record.answers}` : "";
  return `Decision ${record.point} ${job} ${record.outcome} ${record.detail} ${record.ms}ms${answers}`;
}
