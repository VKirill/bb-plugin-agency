import type { Job } from "../../../shared/contracts/job.js";

/** Walk Agency parentJobId with visited. Cycles/repeats are skipped, not counted twice. */
export function collectJobSubtree(allJobs: readonly Job[], rootJobId: string | undefined): Job[] {
  const byId = new Map(allJobs.map((job) => [job.id, job]));
  if (rootJobId) {
    const root = byId.get(rootJobId);
    if (!root) return [];
    return walkFromRoots(allJobs, [root]);
  }
  const roots = allJobs.filter((job) => !job.parentJobId || !byId.has(job.parentJobId));
  const fromRoots = walkFromRoots(allJobs, roots);
  const leftover = allJobs.filter((job) => !fromRoots.some((seen) => seen.id === job.id));
  if (leftover.length === 0) return fromRoots;
  return [...fromRoots, ...walkFromRoots(allJobs, leftover)];
}

function walkFromRoots(allJobs: readonly Job[], roots: readonly Job[]): Job[] {
  const children = new Map<string, Job[]>();
  for (const job of allJobs) {
    if (!job.parentJobId) continue;
    const list = children.get(job.parentJobId) ?? [];
    list.push(job);
    children.set(job.parentJobId, list);
  }
  const visited = new Set<string>();
  const ordered: Job[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const job = queue.shift()!;
    if (visited.has(job.id)) continue;
    visited.add(job.id);
    ordered.push(job);
    for (const child of children.get(job.id) ?? []) {
      if (!visited.has(child.id)) queue.push(child);
    }
  }
  return ordered;
}

export function resolveRowRootJobId(jobs: readonly Job[], jobId: string, queryRootId: string | undefined): string {
  if (queryRootId) return queryRootId;
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const seen = new Set<string>();
  let current = byId.get(jobId);
  let last = jobId;
  while (current?.parentJobId && byId.has(current.parentJobId) && !seen.has(current.id)) {
    seen.add(current.id);
    last = current.parentJobId;
    current = byId.get(current.parentJobId);
  }
  return current?.id ?? last;
}
