import { DEFAULT_BOARD_POLICY, type BoardPolicy } from "../../shared/contracts";
import type { Job } from "../prototype/data";

export { DEFAULT_BOARD_POLICY, type BoardPolicy };

/**
 * Board hygiene of the job list.
 *
 * A main job is one without a parent on this board; a subtask is a job whose
 * parent is visible here. Closed jobs leave the working board after the policy
 * delay and wait under «Скрытые». This is a view rule: nothing is archived or
 * rewritten in the database, and the card of a main job still lists every
 * subtask.
 */

const HOUR_MS = 60 * 60 * 1000;

export function isClosedJob(job: Pick<Job, "state">): boolean {
  return job.state === "done" || job.state === "canceled";
}

export function isMainJob(job: Pick<Job, "parentId">): boolean {
  return !job.parentId;
}

/** AG-12 → 12. Keys without a number sort after numbered ones. */
export function jobKeyNumber(key: string): number {
  const match = /^AG-(\d+)$/.exec(key);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function compareJobKeys(a: string, b: string): number {
  return jobKeyNumber(a) - jobKeyNumber(b) || a.localeCompare(b);
}

/** «AG-2203 Проверка» with key AG-2203 → «Проверка». The key is already its own column. */
export function displayJobTitle(job: Pick<Job, "id" | "title">): string {
  if (!job.title.startsWith(job.id)) return job.title;
  const rest = job.title.slice(job.id.length).replace(/^[\s:—–-]+/, "");
  return rest || job.title;
}

/** When the job closed: server closedAt, else the last change for older servers. */
export function jobClosedAt(job: Pick<Job, "closedAt" | "updatedAt">): number | null {
  const instant = job.closedAt ?? job.updatedAt;
  if (!instant) return null;
  const at = Date.parse(instant);
  return Number.isNaN(at) ? null : at;
}

export function hideAfterMs(job: Pick<Job, "parentId">, policy: BoardPolicy): number | null {
  const hours = isMainJob(job) ? policy.hideClosedMainTasksAfterHours : policy.hideClosedSubtasksAfterHours;
  return hours > 0 ? hours * HOUR_MS : null;
}

export function isHiddenFromBoard(
  job: Pick<Job, "state" | "parentId" | "closedAt" | "updatedAt">,
  policy: BoardPolicy,
  now: number,
): boolean {
  if (!isClosedJob(job)) return false;
  const delay = hideAfterMs(job, policy);
  if (delay === null) return false;
  const closedAt = jobClosedAt(job);
  return closedAt !== null && now - closedAt >= delay;
}

export type BoardPartition = { visible: Job[]; hidden: Job[] };

export function partitionBoard(jobs: readonly Job[], policy: BoardPolicy, now: number): BoardPartition {
  const visible: Job[] = [];
  const hidden: Job[] = [];
  for (const job of jobs) (isHiddenFromBoard(job, policy, now) ? hidden : visible).push(job);
  return { visible, hidden };
}

export type SubtaskProgress = { total: number; closed: number; done: number };

export function subtaskProgress(jobs: readonly Job[]): Map<string, SubtaskProgress> {
  const progress = new Map<string, SubtaskProgress>();
  for (const job of jobs) {
    if (!job.parentId) continue;
    const entry = progress.get(job.parentId) ?? { total: 0, closed: 0, done: 0 };
    entry.total += 1;
    if (isClosedJob(job)) entry.closed += 1;
    if (job.state === "done") entry.done += 1;
    progress.set(job.parentId, entry);
  }
  return progress;
}

/** Root key of each job, walking parents that are present in the set. */
function familyRoot(job: Job, byKey: Map<string, Job>): Job {
  let node = job;
  const seen = new Set<string>();
  while (node.parentId && byKey.has(node.parentId) && !seen.has(node.id)) {
    seen.add(node.id);
    node = byKey.get(node.parentId) as Job;
  }
  return node;
}

/**
 * Orders rows so a family stays together: main job first, then its subtasks by
 * key. Families follow each other by the main job key. Works inside one status
 * section too, where a subtask may appear without its parent.
 */
export function orderByFamily(jobs: readonly Job[], all: readonly Job[] = jobs): Job[] {
  const byKey = new Map(all.map((job) => [job.id, job]));
  const depth = (job: Job) => {
    let level = 0;
    let node = job;
    const seen = new Set<string>();
    while (node.parentId && byKey.has(node.parentId) && !seen.has(node.id)) {
      seen.add(node.id);
      node = byKey.get(node.parentId) as Job;
      level += 1;
    }
    return level;
  };
  return [...jobs].sort((a, b) => {
    const rootA = familyRoot(a, byKey).id;
    const rootB = familyRoot(b, byKey).id;
    return compareJobKeys(rootA, rootB) || depth(a) - depth(b) || compareJobKeys(a.id, b.id);
  });
}
