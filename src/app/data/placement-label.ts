export function uniquePlacementParts(...parts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    for (const piece of part.split("·").map((item) => item.trim()).filter(Boolean)) {
      if (seen.has(piece)) continue;
      seen.add(piece);
      out.push(piece);
    }
  }
  return out.join(" · ");
}

export function environmentPlacementLabel(item: { label: string; hostName: string; path: string }): string {
  const folder = item.path.split("/").filter(Boolean).at(-1) || item.path;
  return uniquePlacementParts(item.label, folder, item.hostName);
}

export function bindingPlacementLabel(item: {
  bbProjectName?: string | null;
  bbProjectId: string;
  canonicalRoot: string;
  hostName?: string | null;
}): string {
  const project = item.bbProjectName?.trim() || item.bbProjectId;
  const folder = item.canonicalRoot.split("/").filter(Boolean).at(-1) || item.canonicalRoot;
  return item.hostName?.trim() ? `${project} · ${folder} · ${item.hostName.trim()}` : `${project} · ${folder}`;
}
