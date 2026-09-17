import { randomUUID } from "node:crypto";
import type { SqlDatabase } from "../db/sql";
import { saveKnowledge } from "./store";

/**
 * Repeated remarks become knowledge. When returns for rework and reviewers' defect
 * lists in one department say the same thing in several jobs, the Agency proposes a
 * department knowledge item. The owner decides: accepted, it goes into the
 * department's launches; archived, the same remark is not proposed again.
 */

export const REMARK_PATTERN_MIGRATION = `CREATE TABLE agency_remark_pattern (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  knowledge_id TEXT,
  job_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

/** Distinct jobs with the same remark before it is proposed. */
export const REMARK_REPEAT_JOBS = 3;
/** How far back remarks are compared. */
export const REMARK_WINDOW_DAYS = 30;
const SIMILARITY = 0.5;
const MIN_SHARED = 3;

export type Remark = { departmentId: string; jobId: string; jobKey: string; text: string; at: string };

const DEFECT_WORDS = /доработ|дефект|не пройден|не выполнен|ошибк|rework|defect|failed|not met|missing/i;

/** Remark lines: list items, or the sentences of a short text. */
export function remarkLines(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const bullets = lines.filter((line) => /^([-*•]|\d+[.)])\s+/.test(line)).map((line) => line.replace(/^([-*•]|\d+[.)])\s+/, ""));
  const pieces = bullets.length ? bullets : lines.flatMap((line) => line.split(/(?<=[.!?])\s+/));
  return pieces.map((piece) => piece.trim()).filter((piece) => piece.length >= 20 && piece.length <= 600);
}

/** Word stems of a remark: lower case, no keys, ids or numbers, first six letters of words of four and more. */
export function remarkStems(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/\b(ag-\d+|job_\w+|run_\w+|thr_\w+|agt_\w+|art_\w+)\b/g, " ")
    .split(/[^\p{L}]+/u)
    .filter((word) => word.length >= 4);
  return new Set(words.map((word) => word.slice(0, 6)));
}

export function remarkSimilarity(a: Set<string>, b: Set<string>): { score: number; shared: number } {
  let shared = 0;
  for (const stem of a) if (b.has(stem)) shared += 1;
  const union = a.size + b.size - shared;
  return { score: union ? shared / union : 0, shared };
}

function similar(a: Set<string>, b: Set<string>): boolean {
  const { score, shared } = remarkSimilarity(a, b);
  return score >= SIMILARITY && shared >= MIN_SHARED;
}

/** Returns for rework and reviewers' defect comments of the last days, per remark line. */
export function recentRemarks(db: SqlDatabase, since: string): Remark[] {
  const rows: { department_id: string; job_id: string; key: string; text: string; at: string }[] = [
    ...(db
      .prepare(
        `SELECT j.department_id, r.job_id, j.key, r.comment AS text, r.created_at AS at
         FROM agency_rework r JOIN agency_job j ON j.id = r.job_id WHERE r.created_at > ?`,
      )
      .all(since) as { department_id: string; job_id: string; key: string; text: string; at: string }[]),
    ...(
      db
        .prepare(
          `SELECT j.department_id, a.job_id, j.key, a.comment AS text, a.timestamp AS at, a.actor
           FROM agency_activity a JOIN agency_job j ON j.id = a.job_id
           JOIN agency_membership m ON m.department_id = j.department_id AND m.role = 'reviewer'
           WHERE a.kind = 'comment' AND a.comment IS NOT NULL AND a.timestamp > ?
             AND json_extract(a.actor, '$.kind') = 'agent' AND json_extract(a.actor, '$.agentId') = m.agent_id`,
        )
        .all(since) as { department_id: string; job_id: string; key: string; text: string; at: string }[]
    ).filter((row) => DEFECT_WORDS.test(row.text)),
  ];
  return rows.flatMap((row) =>
    remarkLines(row.text).map((line) => ({ departmentId: row.department_id, jobId: row.job_id, jobKey: row.key, text: line, at: row.at })),
  );
}

type Cluster = { departmentId: string; stems: Set<string>; representative: string; remarks: Remark[] };

/** Groups similar remarks of one department; each cluster keeps its first remark as the representative. */
export function clusterRemarks(remarks: readonly Remark[]): Cluster[] {
  const clusters: Cluster[] = [];
  for (const remark of [...remarks].sort((a, b) => a.at.localeCompare(b.at))) {
    const stems = remarkStems(remark.text);
    if (stems.size < MIN_SHARED) continue;
    const cluster = clusters.find((item) => item.departmentId === remark.departmentId && similar(item.stems, stems));
    if (cluster) cluster.remarks.push(remark);
    else clusters.push({ departmentId: remark.departmentId, stems, representative: remark.text, remarks: [remark] });
  }
  return clusters;
}

export function proposalText(cluster: Pick<Cluster, "representative" | "remarks">, en: boolean) {
  const seen = new Map<string, string>();
  for (const remark of cluster.remarks) if (!seen.has(remark.jobKey)) seen.set(remark.jobKey, remark.at.slice(0, 10));
  const where = [...seen].map(([key, day]) => `${key} (${day})`).join(", ");
  const short = cluster.representative.length > 80 ? `${cluster.representative.slice(0, 79)}…` : cluster.representative;
  return en
    ? {
        title: `Repeated remark: ${short}`,
        body: `Work in this department was returned several times with the same remark:\n\n> ${cluster.representative}\n\nSeen in: ${where}.\n\nIf this is a department rule, accept the item and it goes into the department's launches as knowledge. Rewording it as a rule («Always …») before accepting works better.`,
        source: `Agency: ${cluster.remarks.length} remarks in ${seen.size} jobs over ${REMARK_WINDOW_DAYS} days`,
      }
    : {
        title: `Повторяющееся замечание: ${short}`,
        body: `Работу отдела несколько раз возвращали с одним и тем же замечанием:\n\n> ${cluster.representative}\n\nВстречалось: ${where}.\n\nЕсли это правило отдела, примите материал: он попадёт в запуски отдела как знание. Лучше переформулировать его как правило («Всегда …») перед принятием.`,
        source: `Агентство: ${cluster.remarks.length} замечаний в ${seen.size} задачах за ${REMARK_WINDOW_DAYS} дней`,
      };
}

/**
 * Proposes knowledge for remarks repeated in enough jobs. A pattern already proposed
 * (accepted, pending or archived) is not proposed again. Returns the new knowledge ids.
 */
export function sweepRemarkPatterns(db: SqlDatabase, now: Date, en: boolean): string[] {
  const since = new Date(now.getTime() - REMARK_WINDOW_DAYS * 86_400_000).toISOString();
  const known = (
    db.prepare(`SELECT department_id, signature FROM agency_remark_pattern`).all() as { department_id: string; signature: string }[]
  ).map((row) => ({ departmentId: row.department_id, stems: new Set(row.signature.split(" ")) }));
  const created: string[] = [];
  for (const cluster of clusterRemarks(recentRemarks(db, since))) {
    const jobs = [...new Set(cluster.remarks.map((remark) => remark.jobId))];
    if (jobs.length < REMARK_REPEAT_JOBS) continue;
    if (known.some((item) => item.departmentId === cluster.departmentId && similar(item.stems, cluster.stems))) continue;
    const text = proposalText(cluster, en);
    const saved = saveKnowledge(
      db,
      { expectedRevision: 0, title: text.title.slice(0, 200), body: text.body, source: text.source, scopeKind: "department", scopeId: cluster.departmentId },
      { proposedBy: "agency:remarks" },
      now.toISOString(),
    );
    const knowledgeId = saved.ok ? saved.value.id : null;
    db.prepare(
      `INSERT INTO agency_remark_pattern (id, department_id, signature, knowledge_id, job_ids_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(`rmk_${randomUUID().replace(/-/g, "").slice(0, 24)}`, cluster.departmentId, [...cluster.stems].sort().join(" "), knowledgeId, JSON.stringify(jobs), now.toISOString(), now.toISOString());
    known.push({ departmentId: cluster.departmentId, stems: cluster.stems });
    if (knowledgeId) created.push(knowledgeId);
  }
  return created;
}
