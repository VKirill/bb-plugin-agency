import { fail, ok, type DomainResult } from "../../domain";
import { jobContractSchema, type Job, type JobContract } from "../../shared/contracts";
import type { SqlDatabase } from "../db/sql";

/**
 * Two jobs that may change the same files do not run at once: the later one waits
 * in the launch queue. Ownership comes from the execution contract («Можно менять»),
 * so a lead who gives each subtask its own files gets parallel work for free.
 */

/** Attempt states with a thread that may still be writing files. */
const LIVE_ATTEMPT_STATES = ["prepared", "launching", "running", "waiting_input", "unknown"];

const GLOB = /[*?[\]{}]/;

/**
 * The fixed part of a contract line: `src/cards/**` → `src/cards/`. A line that is not
 * a path (\"публичный API\") has no fixed part and is compared as plain text instead.
 */
export function ownershipPrefix(line: string): { path: string | null; text: string } {
  const text = line.trim().toLowerCase();
  const head = GLOB.test(text) ? text.slice(0, text.search(GLOB)) : text;
  const looksLikePath = head.includes("/") || /\.[a-z0-9]{1,8}$/.test(head);
  if (!looksLikePath) return { path: null, text };
  const path = head.replace(/\/+$/, "");
  return { path: path ? path : null, text };
}

function linesOverlap(left: string, right: string): boolean {
  const a = ownershipPrefix(left);
  const b = ownershipPrefix(right);
  if (a.path && b.path) return a.path === b.path || a.path.startsWith(`${b.path}/`) || b.path.startsWith(`${a.path}/`);
  return a.text === b.text;
}

export function contractsOverlap(left: JobContract | null | undefined, right: JobContract | null | undefined): string | null {
  for (const line of left?.mayChange ?? []) {
    for (const other of right?.mayChange ?? []) {
      if (linesOverlap(line, other)) return line;
    }
  }
  return null;
}

function contractOf(json: string | null): JobContract | null {
  if (!json) return null;
  const parsed = jobContractSchema.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : null;
}

/**
 * The job's own family: its parents up to the main job and everything under it. A lead
 * waits for its subtasks and hands them the same files on purpose, so a subtask must never
 * wait for its own parent — that would be a deadlock.
 */
function familyIds(db: SqlDatabase, jobId: string): Set<string> {
  const family = new Set<string>([jobId]);
  let cursor: string | null = jobId;
  while (cursor) {
    const row = db.prepare(`SELECT parent_job_id FROM agency_job WHERE id = ?`).get(cursor) as { parent_job_id: string | null } | undefined;
    cursor = row?.parent_job_id ?? null;
    if (cursor && !family.has(cursor)) family.add(cursor);
    else cursor = null;
  }
  const queue = [...family];
  while (queue.length) {
    const parent = queue.shift()!;
    const children = db.prepare(`SELECT id FROM agency_job WHERE parent_job_id = ?`).all(parent) as { id: string }[];
    for (const child of children) {
      if (family.has(child.id)) continue;
      family.add(child.id);
      queue.push(child.id);
    }
  }
  return family;
}

/**
 * Jobs of the same project folder with a live attempt, outside this job's own family.
 * Another folder is another checkout, so its files cannot collide with this one.
 */
function runningJobs(db: SqlDatabase, job: Pick<Job, "id" | "bindingId">): { key: string; contract: JobContract | null }[] {
  const placeholders = LIVE_ATTEMPT_STATES.map(() => "?").join(", ");
  const family = familyIds(db, job.id);
  const rows = db
    .prepare(
      `SELECT j.id, j.key, j.contract_json FROM agency_job j
       WHERE j.binding_id = ? AND EXISTS (
         SELECT 1 FROM agency_run_attempt a WHERE a.job_id = j.id AND a.state IN (${placeholders})
       )
       ORDER BY j.rowid`,
    )
    .all(job.bindingId, ...LIVE_ATTEMPT_STATES) as { id: string; key: string; contract_json: string | null }[];
  return rows.filter((row) => !family.has(row.id)).map((row) => ({ key: row.key, contract: contractOf(row.contract_json) }));
}

/** Launch gate: waits while another running job owns one of this job's files. */
export function assertOwnershipFree(db: SqlDatabase, job: Pick<Job, "id" | "bindingId" | "contract">, en: boolean): DomainResult<true> {
  if (!job.contract?.mayChange?.length) return ok(true);
  for (const running of runningJobs(db, job)) {
    const line = contractsOverlap(job.contract, running.contract);
    if (!line) continue;
    return fail(
      "owns_overlap",
      en
        ? `${running.key} is already running and may change the same files (${line}). Put this job in the launch queue: it starts by itself when ${running.key} is done, or give the two jobs different files.`
        : `${running.key} уже работает и может менять те же файлы (${line}). Поставьте задачу в очередь запуска: она стартует сама, когда ${running.key} закончит, — или разведите задачи по разным файлам.`,
    );
  }
  return ok(true);
}
