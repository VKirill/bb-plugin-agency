import type { Job } from "../prototype/data";

export type JobTreeNode = {
  job: Job;
  current: boolean;
  children: JobTreeNode[];
};

export type JobDependencyEdge = {
  jobId: string;
  dependsOnJobId: string;
};

export type VisibleJobLink = {
  id: string;
  title: string;
  known: boolean;
};

function byKey(jobs: readonly Job[]): Map<string, Job> {
  return new Map(jobs.map((job) => [job.id, job]));
}

function byRecord(jobs: readonly Job[]): Map<string, Job> {
  const map = new Map<string, Job>();
  for (const job of jobs) {
    if (job.recordId) map.set(job.recordId, job);
  }
  return map;
}

export const MAIN_JOB_LABEL = "Главная задача";

export function jobHierarchyRoot(jobs: readonly Job[], current: Job): Job {
  const index = byKey(jobs);
  let node = current;
  const seen = new Set<string>();
  while (node.parentId) {
    if (seen.has(node.id)) break;
    seen.add(node.id);
    const parent = index.get(node.parentId);
    if (!parent) break;
    node = parent;
  }
  return node;
}

export function jobChildren(jobs: readonly Job[], parentId: string): Job[] {
  return jobs.filter((job) => job.parentId === parentId);
}

/** Counts only. Canceled is not a failed success and does not rewrite state. */
export function childProgressLabel(children: readonly { state: string }[]): string {
  if (children.length === 0) return "";
  const done = children.filter((job) => job.state === "done").length;
  const canceled = children.filter((job) => job.state === "canceled").length;
  const open = children.length - done - canceled;
  const parts: string[] = [];
  if (done > 0) parts.push(`${done} готово`);
  if (canceled === 1) parts.push("1 отменена");
  else if (canceled > 1) parts.push(`${canceled} отменены`);
  if (open > 0) parts.push(`${open} открыто`);
  return parts.join(" · ");
}

/** Ancestors from hierarchy root up to, but not including, the current job. */
export function jobParentBreadcrumb(jobs: readonly Job[], current: Job): Job[] {
  const root = jobHierarchyRoot(jobs, current);
  if (root.id === current.id) return [];
  const index = byKey(jobs);
  const chain: Job[] = [];
  let node = current;
  const seen = new Set<string>();
  while (node.parentId) {
    if (seen.has(node.id)) break;
    seen.add(node.id);
    const parent = index.get(node.parentId);
    if (!parent) break;
    chain.push(parent);
    if (parent.id === root.id) break;
    node = parent;
  }
  return chain.reverse();
}

export function jobTree(jobs: readonly Job[], current: Job): JobTreeNode {
  const root = jobHierarchyRoot(jobs, current);
  const walk = (job: Job): JobTreeNode => ({
    job,
    current: job.id === current.id,
    children: jobChildren(jobs, job.id).map(walk),
  });
  return walk(root);
}

function resolveLinkedJob(jobs: readonly Job[], id: string): VisibleJobLink {
  const byId = byKey(jobs).get(id) ?? byRecord(jobs).get(id);
  if (!byId) return { id, title: id, known: false };
  return { id: byId.id, title: byId.title, known: true };
}

/** Only edges from getJob/API. Missing workspace rows stay as unresolved ids. */
export function visibleJobDependencies(
  edges: readonly JobDependencyEdge[],
  jobs: readonly Job[],
  current: Pick<Job, "id" | "recordId">,
): { dependsOn: VisibleJobLink[]; blockersOf: VisibleJobLink[] } {
  const self = new Set([current.id, current.recordId].filter((item): item is string => Boolean(item)));
  const dependsOn: VisibleJobLink[] = [];
  const blockersOf: VisibleJobLink[] = [];
  const seenOn = new Set<string>();
  const seenOf = new Set<string>();
  for (const edge of edges) {
    if (self.has(edge.jobId) && !self.has(edge.dependsOnJobId)) {
      const link = resolveLinkedJob(jobs, edge.dependsOnJobId);
      if (seenOn.has(link.id)) continue;
      seenOn.add(link.id);
      dependsOn.push(link);
    } else if (self.has(edge.dependsOnJobId) && !self.has(edge.jobId)) {
      const link = resolveLinkedJob(jobs, edge.jobId);
      if (seenOf.has(link.id)) continue;
      seenOf.add(link.id);
      blockersOf.push(link);
    }
  }
  return { dependsOn, blockersOf };
}
