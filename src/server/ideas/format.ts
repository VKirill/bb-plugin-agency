import type { IdeaRecord } from "./store";

function yamlScalar(value: string): string {
  return /[:#\n"'\\]/.test(value) ? JSON.stringify(value) : value;
}

/** Markdown file the owner can reopen later. Front matter stays machine-readable. */
export function formatIdeaMarkdown(item: IdeaRecord): string {
  const lines = [
    "---",
    `id: ${item.id}`,
    `kind: ${item.kind}`,
    `status: ${item.status}`,
    `title: ${yamlScalar(item.title)}`,
    `projectBinding: ${item.bindingId}`,
  ];
  if (item.sectionId) lines.push(`sectionId: ${item.sectionId}`);
  if (item.sectionLabel) lines.push(`section: ${yamlScalar(item.sectionLabel)}`);
  if (item.sourceThreadId) lines.push(`thread: ${item.sourceThreadId}`);
  if (item.resolution) lines.push(`resolution: ${yamlScalar(item.resolution)}`);
  if (item.closedAt) lines.push(`closed: ${item.closedAt}`);
  if (item.closedThreadId) lines.push(`closedThread: ${item.closedThreadId}`);
  lines.push(`updated: ${item.updatedAt}`, "---", "", `# ${item.title}`, "", item.body.trim(), "");
  if (item.resolution) {
    lines.push("## Итог", "", item.resolution.trim(), "");
    const closedBits = [item.closedAt, item.closedThreadId ? `@thread:${item.closedThreadId}` : ""].filter(Boolean);
    if (closedBits.length) lines.push(`Закрыто: ${closedBits.join(" · ")}`, "");
  }
  return lines.join("\n");
}
