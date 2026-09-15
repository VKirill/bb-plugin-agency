/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { splitMarkdownDocument } from "../src/app/editor/frontmatter";
import { DocumentProperties } from "../src/app/editor/properties";
import { protectedSlots } from "../src/app/editor/protect";
import { ProtectedMarkdownBlock } from "../src/app/editor/protected-node";
import { mountProtectedBlockView } from "../src/app/editor/protected-view";
import {
  createMarkdownSession,
  type MarkdownSession,
} from "../src/app/editor/session";

const showcase = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../docs/examples/markdown-showcase.md",
  ),
  "utf8",
);

const customUnknown = `---
title: custom
---
# Intro

Literal marker @@AGY20_0@@ stays prose.

::html{src="embed.html" height="360"}

:::note
keep me
:::

Ordinary paragraph.
`;

const sessions: MarkdownSession[] = [];

function session(
  renderProtected?: (raw: string, element: HTMLElement) => void,
): MarkdownSession {
  const host = document.createElement("div");
  document.body.append(host);
  const created = createMarkdownSession({
    element: host,
    renderProtected,
  });
  sessions.push(created);
  return created;
}

afterEach(() => {
  while (sessions.length > 0) sessions.pop()?.destroy();
  document.body.replaceChildren();
});

describe("markdown session roundtrip", () => {
  it("keeps showcase YAML and mermaid after a ProseMirror prose edit", () => {
    const rendered: string[] = [];
    const created = session((raw, element) => {
      rendered.push(raw);
      element.dataset.rendered = raw.includes("flowchart TD")
        ? "mermaid"
        : "protected";
    });
    created.setMarkdown(showcase);
    expect(rendered.some((raw) => raw.includes("flowchart TD"))).toBe(true);
    expect(
      created.replaceProseText("удобно читать", "удобно править"),
    ).toBe(true);
    const out = created.getMarkdown();
    expect(splitMarkdownDocument(out).frontmatter).toBe(
      splitMarkdownDocument(showcase).frontmatter,
    );
    expect(out).toContain("удобно править");
    expect(out).toContain("```mermaid\nflowchart TD");
    expectProtectedMermaidAndCode(showcase, out);
  });

  it("saves and cancels a protected block through the local control", () => {
    const committed: string[] = [];
    const previewed: string[] = [];
    const view = mountProtectedBlockView({
      raw: "```mermaid\nflowchart TD\n```\n",
      editable: true,
      renderProtected(raw, element) {
        previewed.push(raw);
        element.dataset.kind = "mermaid";
      },
      onCommit(next) {
        committed.push(next);
      },
    });
    document.body.append(view.dom);
    expect(previewed[0]).toContain("flowchart TD");
    expect(view.dom.querySelector("[data-kind='mermaid']")).not.toBeNull();
    view.dom.querySelector<HTMLButtonElement>(".agy-protected-edit")?.click();
    const draft = view.dom.querySelector("textarea");
    expect(draft?.hidden).toBe(false);
    if (draft) draft.value = "```mermaid\nflowchart LR\n```\n";
    view.dom.querySelector<HTMLButtonElement>(".agy-protected-cancel")?.click();
    expect(committed).toEqual([]);
    expect(draft?.hidden).toBe(true);
    view.dom.querySelector<HTMLButtonElement>(".agy-protected-edit")?.click();
    if (draft) draft.value = "```mermaid\nflowchart LR\n```\n";
    view.dom.querySelector<HTMLButtonElement>(".agy-protected-save")?.click();
    expect(committed).toEqual(["```mermaid\nflowchart LR\n```\n"]);
    view.destroy();
  });

  it("shows unknown markup as source and keeps bytes after a block transaction", () => {
    const created = session((raw, element) => {
      element.dataset.rendered = raw;
    });
    created.setMarkdown(customUnknown);
    const unknown = document.querySelector(".agy-protected-source");
    expect(unknown?.textContent).toContain('::html{src="embed.html" height="360"}');
    expect(
      created.replaceProtectedRaw(
        '::html{src="embed.html" height="360"}',
        '::html{src="kept.html" height="360"}\n',
      ),
    ).toBe(true);
    const out = created.getMarkdown();
    expect(out).toContain('::html{src="kept.html" height="360"}');
    expect(out).toContain(":::note\nkeep me\n:::");
    expect(out.replace(/\\_/g, "_")).toContain(
      "Literal marker @@AGY20_0@@ stays prose.",
    );
  });

  it("renders YAML as a key/value table and keeps protected bytes off renderHTML", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() => {
      root.render(createElement(DocumentProperties, { content: showcase }));
    });
    const keys = Array.from(host.querySelectorAll("dt")).map(
      (node) => node.textContent,
    );
    expect(keys).toContain("title");
    expect(keys).toContain("review → owner");
    expect(host.querySelector("pre")).toBeNull();
    root.unmount();
    const renderHTML = ProtectedMarkdownBlock.config.renderHTML as
      | ((
          this: unknown,
          props: { HTMLAttributes: Record<string, unknown>; node: { attrs: { raw: string } } },
        ) => unknown)
      | null
      | undefined;
    expect(typeof renderHTML).toBe("function");
    const html = renderHTML?.call(
      {
        name: "agyProtected",
        options: {},
        storage: {},
        parent: undefined,
      },
      {
        HTMLAttributes: {},
        node: {
          attrs: { raw: "```mermaid\nflowchart TD\n```" },
        },
      },
    );
    expect(Array.isArray(html) && html[0]).toBe("div");
    expect(JSON.stringify(html)).not.toContain("flowchart");
  });

  it("does not treat a literal @@AGY20_0@@ as a slot", () => {
    const created = session();
    created.setMarkdown(customUnknown);
    expect(
      created.replaceProseText("Ordinary paragraph.", "Changed paragraph."),
    ).toBe(true);
    const out = created.getMarkdown();
    expect(out.replace(/\\_/g, "_")).toContain(
      "Literal marker @@AGY20_0@@ stays prose.",
    );
    expect(out).toContain("Changed paragraph.");
    expect(out).toContain(":::note\nkeep me\n:::");
  });
});

function expectProtectedMermaidAndCode(input: string, output: string): void {
  const before = protectedSlots(splitMarkdownDocument(input).body);
  const after = protectedSlots(splitMarkdownDocument(output).body);
  expect(after.filter((slot) => slot.includes("```mermaid"))).toEqual(
    before.filter((slot) => slot.includes("```mermaid")),
  );
  expect(after.filter((slot) => slot.includes("```typescript"))).toEqual(
    before.filter((slot) => slot.includes("```typescript")),
  );
  expect(after.filter((slot) => slot.includes("```text"))).toEqual(
    before.filter((slot) => slot.includes("```text")),
  );
}
