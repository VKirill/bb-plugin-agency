export interface SplitMarkdownDocument {
  frontmatter: string;
  body: string;
}

export function splitMarkdownDocument(content: string): SplitMarkdownDocument {
  const bom = content.startsWith("\uFEFF") ? 1 : 0;
  const start = bom;
  if (!atLine(content, start, "---")) {
    return { frontmatter: "", body: content };
  }
  let cursor = nextLineStart(content, start);
  while (cursor < content.length) {
    if (atLine(content, cursor, "---") || atLine(content, cursor, "...")) {
      const closerEnd = lineEnd(content, cursor);
      return {
        frontmatter: content.slice(0, closerEnd),
        body: content.slice(closerEnd),
      };
    }
    const next = nextLineStart(content, cursor);
    if (next === cursor) break;
    cursor = next;
  }
  return { frontmatter: "", body: content };
}

export function joinMarkdownDocument(
  frontmatter: string,
  body: string,
): string {
  if (frontmatter.length === 0) return body;
  return `${frontmatter}${body}`;
}

function atLine(content: string, index: number, marker: string): boolean {
  if (index > 0 && content[index - 1] !== "\n") return false;
  if (!content.startsWith(marker, index)) return false;
  const after = index + marker.length;
  const ch = content[after];
  return ch === undefined || ch === "\n" || ch === "\r";
}

function lineEnd(content: string, index: number): number {
  const newline = content.indexOf("\n", index);
  return newline === -1 ? content.length : newline + 1;
}

function nextLineStart(content: string, index: number): number {
  return lineEnd(content, index);
}
