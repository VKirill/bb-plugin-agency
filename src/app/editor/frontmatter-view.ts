import { parseDocument } from "yaml";
import { splitMarkdownDocument } from "./frontmatter";

export const FRONTMATTER_MAX_DEPTH = 8;
export const FRONTMATTER_MAX_ROWS = 64;

export interface FrontmatterView {
  source: string | null;
  value: unknown;
  error: boolean;
}

export interface FrontmatterRow {
  key: string;
  value: string;
}

export function parseFrontmatterView(content: string): FrontmatterView {
  const split = splitMarkdownDocument(content);
  if (split.frontmatter.length === 0) {
    return { source: null, value: null, error: false };
  }
  const source = innerFrontmatter(split.frontmatter);
  try {
    if (source.length > 65536) throw new Error("frontmatter too large");
    const parsed = parseDocument(source, { stringKeys: true, uniqueKeys: true });
    if (parsed.errors.length || parsed.warnings.length) {
      throw new Error("invalid frontmatter");
    }
    let value: unknown;
    try {
      value = parsed.toJS({ maxAliasCount: 8 });
    } catch {
      return { source, value: null, error: true };
    }
    return { source, value, error: false };
  } catch {
    return { source, value: null, error: true };
  }
}

export function flattenFrontmatterRows(value: unknown): FrontmatterRow[] {
  const rows: FrontmatterRow[] = [];
  const seen = new WeakSet<object>();
  walkFrontmatter(value, "", 0, seen, rows);
  return rows;
}

function walkFrontmatter(
  value: unknown,
  prefix: string,
  depth: number,
  seen: WeakSet<object>,
  rows: FrontmatterRow[],
): void {
  if (rows.length >= FRONTMATTER_MAX_ROWS) return;
  if (depth > FRONTMATTER_MAX_DEPTH) {
    if (prefix) rows.push({ key: prefix, value: "…" });
    return;
  }
  if (value === undefined) {
    if (prefix) rows.push({ key: prefix, value: "" });
    return;
  }
  if (value === null) {
    rows.push({ key: prefix || "—", value: "null" });
    return;
  }
  if (typeof value !== "object") {
    rows.push({ key: prefix, value: String(value) });
    return;
  }
  if (seen.has(value)) {
    rows.push({ key: prefix || "—", value: "↻" });
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      rows.push({ key: prefix || "—", value: "[]" });
      return;
    }
    const scalars = value.every(
      (item) => item === null || typeof item !== "object",
    );
    if (scalars) {
      rows.push({
        key: prefix,
        value: value.map((item) => (item === null ? "null" : String(item))).join(", "),
      });
      return;
    }
    value.forEach((item, index) => {
      walkFrontmatter(item, joinKey(prefix, String(index)), depth + 1, seen, rows);
    });
    return;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    rows.push({ key: prefix || "—", value: "{}" });
    return;
  }
  for (const [key, item] of entries) {
    if (rows.length >= FRONTMATTER_MAX_ROWS) return;
    walkFrontmatter(item, joinKey(prefix, key), depth + 1, seen, rows);
  }
}

function joinKey(prefix: string, key: string): string {
  return prefix ? `${prefix} → ${key}` : key;
}

function innerFrontmatter(frontmatter: string): string {
  const text = frontmatter.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return text;
  const close = lines.findIndex(
    (line, index) => index > 0 && (line.trim() === "---" || line.trim() === "..."),
  );
  if (close === -1) return text;
  return lines.slice(1, close).join("\n");
}
