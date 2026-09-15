/** Live cards hide the rail by opaque record id; demo keeps the display key. */
export function documentVisibilityId(job: { id: string; recordId?: string }, live: boolean): string {
  if (!live) return job.id;
  return job.recordId || job.id;
}

const claims = new Map<string, string>();
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function subscribeDocumentVisibility(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function claimDocumentPanel(path: string, jobId: string): void {
  if (!path || !jobId) return;
  if (claims.get(path) === jobId) return;
  claims.set(path, jobId);
  emit();
}

export function releaseDocumentPanel(path: string): void {
  if (!claims.delete(path)) return;
  emit();
}

export function isDocumentPanelVisible(jobId: string): boolean {
  for (const claimed of claims.values()) {
    if (claimed === jobId) return true;
  }
  return false;
}

export function resetDocumentVisibility(): void {
  if (claims.size === 0) return;
  claims.clear();
  emit();
}
