import type { Job } from "../prototype/data";

/** Fields that updateJob / transitionJob can persist. Drafts and files stay local. */
export function jobNeedsServerPatch(current: Job, next: Job): boolean {
  return (
    current.title !== next.title ||
    current.description !== next.description ||
    current.state !== next.state ||
    current.agent !== next.agent ||
    current.assignedAgentId !== next.assignedAgentId ||
    current.priority !== next.priority ||
    current.due !== next.due ||
    current.bindingId !== next.bindingId ||
    current.departmentId !== next.departmentId ||
    current.project !== next.project ||
    current.department !== next.department ||
    !sameOptionalIdList(current.reviewerAgentIds, next.reviewerAgentIds) ||
    !sameOptionalIdList(current.observerAgentIds, next.observerAgentIds)
  );
}

function sameOptionalIdList(left?: readonly string[], right?: readonly string[]): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function clearFileDraft(drafts: Record<string, string>, fileId: string): Record<string, string> {
  if (!(fileId in drafts)) return drafts;
  const next = { ...drafts };
  delete next[fileId];
  return next;
}
