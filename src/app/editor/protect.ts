export type MarkdownChunk =
  | { kind: "prose"; text: string }
  | { kind: "protected"; raw: string };

export function chunkMarkdown(body: string): MarkdownChunk[] {
  const chunks: MarkdownChunk[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    const hit = nextProtectedRange(body, cursor);
    if (hit === null) {
      chunks.push({ kind: "prose", text: body.slice(cursor) });
      break;
    }
    if (hit.start > cursor) {
      chunks.push({ kind: "prose", text: body.slice(cursor, hit.start) });
    }
    chunks.push({
      kind: "protected",
      raw: body.slice(hit.start, hit.end),
    });
    cursor = hit.end;
  }
  return chunks;
}

export function protectedSlots(body: string): string[] {
  return chunkMarkdown(body)
    .filter((chunk) => chunk.kind === "protected")
    .map((chunk) => chunk.raw);
}

export function rewriteProseChunks(
  body: string,
  rewrite: (prose: string) => string,
): string {
  return chunkMarkdown(body)
    .map((chunk) => (chunk.kind === "prose" ? rewrite(chunk.text) : chunk.raw))
    .join("");
}

interface Range {
  start: number;
  end: number;
}

function nextProtectedRange(text: string, from: number): Range | null {
  let best: Range | null = null;
  const candidates = [
    findFence(text, from),
    findDisplayMath(text, from),
    findFootnoteDefinition(text, from),
    findCustomFence(text, from),
    findCustomLine(text, from),
  ];
  for (const range of candidates) {
    if (range === null) continue;
    if (best === null || range.start < best.start) best = range;
  }
  return best;
}

function findFence(text: string, from: number): Range | null {
  let index = from;
  while (index < text.length) {
    if (isLineStart(text, index)) {
      const marker = text.startsWith("```", index)
        ? "```"
        : text.startsWith("~~~", index)
          ? "~~~"
          : null;
      if (marker !== null) {
        const closer = findClosingFence(text, index + marker.length, marker);
        return { start: index, end: closer };
      }
    }
    index += 1;
  }
  return null;
}

function findClosingFence(
  text: string,
  afterOpener: number,
  marker: string,
): number {
  let lineStart = text.indexOf("\n", afterOpener);
  if (lineStart === -1) return text.length;
  lineStart += 1;
  while (lineStart < text.length) {
    if (text.startsWith(marker, lineStart) && isLineStart(text, lineStart)) {
      return lineEnd(text, lineStart);
    }
    const next = text.indexOf("\n", lineStart);
    if (next === -1) return text.length;
    lineStart = next + 1;
  }
  return text.length;
}

function findDisplayMath(text: string, from: number): Range | null {
  let index = from;
  while (index < text.length) {
    if (
      isLineStart(text, index) &&
      text.startsWith("$$", index) &&
      (text[index + 2] === "\n" || text[index + 2] === "\r")
    ) {
      const afterOpen = lineEnd(text, index);
      const closeAt = text.indexOf("\n$$", afterOpen);
      if (closeAt === -1) return { start: index, end: text.length };
      return { start: index, end: lineEnd(text, closeAt + 1) };
    }
    index += 1;
  }
  return null;
}

function findFootnoteDefinition(text: string, from: number): Range | null {
  let index = from;
  while (index < text.length) {
    if (isLineStart(text, index) && text.startsWith("[^", index)) {
      const colon = text.indexOf("]:", index);
      const lineBreak = text.indexOf("\n", index);
      if (colon !== -1 && (lineBreak === -1 || colon < lineBreak)) {
        return { start: index, end: extendIndented(text, lineEnd(text, index)) };
      }
    }
    index += 1;
  }
  return null;
}

function extendIndented(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length) {
    if (text[cursor] === " " || text[cursor] === "\t") {
      cursor = lineEnd(text, cursor);
      continue;
    }
    break;
  }
  return cursor;
}

function findCustomFence(text: string, from: number): Range | null {
  let index = from;
  while (index < text.length) {
    if (isLineStart(text, index) && text.startsWith(":::", index)) {
      let lineStart = lineEnd(text, index);
      while (lineStart < text.length) {
        if (isLineStart(text, lineStart) && text.startsWith(":::", lineStart)) {
          return { start: index, end: lineEnd(text, lineStart) };
        }
        const next = text.indexOf("\n", lineStart);
        if (next === -1) return { start: index, end: text.length };
        lineStart = next + 1;
      }
      return { start: index, end: text.length };
    }
    index += 1;
  }
  return null;
}

function findCustomLine(text: string, from: number): Range | null {
  let index = from;
  while (index < text.length) {
    if (
      isLineStart(text, index) &&
      text.startsWith("::", index) &&
      !text.startsWith(":::", index)
    ) {
      return { start: index, end: lineEnd(text, index) };
    }
    index += 1;
  }
  return null;
}

function isLineStart(text: string, index: number): boolean {
  return index === 0 || text[index - 1] === "\n";
}

function lineEnd(text: string, index: number): number {
  const newline = text.indexOf("\n", index);
  return newline === -1 ? text.length : newline + 1;
}
