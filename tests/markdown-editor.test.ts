/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { splitMarkdownDocument } from "../src/app/editor/frontmatter";
import {
  flattenFrontmatterRows,
  parseFrontmatterView,
} from "../src/app/editor/frontmatter-view";
import {
  chunkMarkdown,
  rewriteProseChunks,
} from "../src/app/editor/protect";
import { resolveEditorSource } from "../src/app/editor/session";
import { editorTypographyCss, ensureEditorStyles } from "../src/app/editor/styles";

const showcase = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../docs/examples/markdown-showcase.md",
  ),
  "utf8",
);

describe("markdown editor contract", () => {
  it("prefers value over content", () => {
    expect(resolveEditorSource({ value: "a", content: "b" })).toBe("a");
    expect(resolveEditorSource({ content: "b" })).toBe("b");
    expect(resolveEditorSource({})).toBe("");
  });

  it("exposes YAML as structured key/value rows, not a raw dump", () => {
    const view = parseFrontmatterView(showcase);
    expect(view.error).toBe(false);
    const rows = Object.fromEntries(
      flattenFrontmatterRows(view.value).map((row) => [row.key, row.value]),
    );
    expect(rows.title).toBe("Возможности Markdown");
    expect(rows.status).toBe("demonstration");
    expect(rows["review → owner"]).toBe("Кирилл");
    expect(rows.tags).toBe("интерфейс, документы");
  });

  it("keeps null and empty collections and bounds cyclic YAML", () => {
    const empty = parseFrontmatterView(
      "---\ntitle: t\ntags: []\nowner: {}\nnote: null\n---\n# x\n",
    );
    expect(empty.error).toBe(false);
    const emptyRows = Object.fromEntries(
      flattenFrontmatterRows(empty.value).map((row) => [row.key, row.value]),
    );
    expect(emptyRows.tags).toBe("[]");
    expect(emptyRows.owner).toBe("{}");
    expect(emptyRows.note).toBe("null");

    const cyclic = {
      self: null as unknown,
    };
    cyclic.self = cyclic;
    expect(() => flattenFrontmatterRows(cyclic)).not.toThrow();
    const cyclicRows = flattenFrontmatterRows(cyclic);
    expect(cyclicRows.some((row) => row.value === "↻")).toBe(true);
    expect(cyclicRows.length).toBeLessThan(8);

    const yamlCycle = parseFrontmatterView("---\na: &a\n  self: *a\n---\n# x\n");
    expect(() => flattenFrontmatterRows(yamlCycle.value)).not.toThrow();
    if (!yamlCycle.error) {
      const rows = flattenFrontmatterRows(yamlCycle.value);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(32);
    }
  });

  it("keeps mermaid/code/tree as protected slots and inline math in prose", () => {
    const split = splitMarkdownDocument(showcase);
    const chunks = chunkMarkdown(`${split.body}\n::html{src="x.html"}\n`);
    const slots = chunks
      .filter((chunk) => chunk.kind === "protected")
      .map((chunk) => chunk.raw);
    expect(slots.some((slot) => slot.includes("flowchart TD"))).toBe(true);
    expect(slots.some((slot) => slot.includes("agency/"))).toBe(true);
    expect(slots.some((slot) => slot.includes("interface Task"))).toBe(true);
    expect(slots.some((slot) => slot.includes("::html"))).toBe(true);
    expect(slots.some((slot) => slot.includes("$$E = mc^2$$"))).toBe(false);
    const prose = chunks
      .filter((chunk) => chunk.kind === "prose")
      .map((chunk) => chunk.text)
      .join("");
    expect(prose).toContain("$$E = mc^2$$");
    const rewritten = rewriteProseChunks(
      `${split.body}\n::html{src="x.html"}\n`,
      (text) => text.replace("удобно читать", "удобно править"),
    );
    expect(rewritten).toContain("удобно править");
    expect(rewritten).toContain("```mermaid\nflowchart TD");
    expect(rewritten).toContain('::html{src="x.html"}');
    expect(rewritten).toContain("$$E = mc^2$$");
  });

  it("ships ProseMirror typography for headings, tables, lists and code", () => {
    const css = editorTypographyCss();
    expect(css).toContain(".agy-markdown-editor .ProseMirror h1");
    expect(css).toContain(".agy-markdown-editor .ProseMirror table");
    expect(css).toContain(".agy-markdown-editor .ProseMirror ul");
    expect(css).toContain(".agy-markdown-editor .ProseMirror pre");
    expect(css).toContain("prefers-color-scheme: dark");
    expect(css).toContain(".agy-markdown-editor [hidden] { display: none !important; }");
    expect(css).toContain("ul:has(> li[data-checked])");
    expect(css).toContain("li[data-checked]");
    expect(css).toContain("li[data-checked] p");
    expect(css).toContain(".agy-markdown-editor .ProseMirror li > p { margin-top: 0; }");
  });

  it("refreshes existing editor style node after plugin reload", () => {
    const stale = document.createElement("style");
    stale.id = "agy-markdown-editor-styles";
    stale.textContent = "/* stale */";
    document.head.append(stale);
    ensureEditorStyles();
    expect(document.getElementById("agy-markdown-editor-styles")).toBe(stale);
    expect(stale.textContent).toContain(".agy-markdown-editor .ProseMirror");
    expect(stale.textContent).not.toContain("stale");
    ensureEditorStyles();
    expect(document.querySelectorAll("#agy-markdown-editor-styles")).toHaveLength(1);
  });
});
