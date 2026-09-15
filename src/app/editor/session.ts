import { Editor, type JSONContent } from "@tiptap/core";
import "@tiptap/markdown";
import { createAgencyMarkdownExtensions } from "./extensions";
import { joinMarkdownDocument, splitMarkdownDocument } from "./frontmatter";
import { chunkMarkdown } from "./protect";
import type { ProtectedBlockRenderer } from "./protected-node";

export function resolveEditorSource(input: {
  value?: string;
  content?: string;
}): string {
  return input.value ?? input.content ?? "";
}

export interface MarkdownSession {
  setMarkdown(source: string): void;
  getMarkdown(): string;
  replaceProseText(from: string, to: string): boolean;
  replaceProtectedRaw(match: string, next: string): boolean;
  setReadOnly(readOnly: boolean): void;
  destroy(): void;
}

export function createMarkdownSession(args?: {
  element?: Element;
  readOnly?: boolean;
  onUpdate?: (next: string) => void;
  renderProtected?: ProtectedBlockRenderer;
}): MarkdownSession {
  let frontmatter = "";
  let applying = false;
  const extensions = createAgencyMarkdownExtensions({
    renderProtected: args?.renderProtected,
  });
  const editor = new Editor({
    element: args?.element ?? null,
    extensions,
    content: "",
    editable: args?.readOnly !== true,
    onUpdate() {
      if (applying) return;
      args?.onUpdate?.(getMarkdown());
    },
  });

  function setMarkdown(source: string): void {
    applying = true;
    const split = splitMarkdownDocument(source);
    frontmatter = split.frontmatter;
    editor.commands.setContent(documentFromChunks(split.body));
    applying = false;
  }

  function getMarkdown(): string {
    const raw = String(editor.getMarkdown() ?? "");
    return joinMarkdownDocument(frontmatter, raw);
  }

  function replaceProseText(from: string, to: string): boolean {
    let fromPos = -1;
    let toPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (fromPos >= 0) return false;
      if (node.type.name === "agyProtected") return true;
      if (!node.isText || node.text === undefined) return true;
      const index = node.text.indexOf(from);
      if (index === -1) return true;
      fromPos = pos + index;
      toPos = fromPos + from.length;
      return false;
    });
    if (fromPos < 0) return false;
    applying = true;
    editor
      .chain()
      .command(({ tr }) => {
        tr.insertText(to, fromPos, toPos);
        return true;
      })
      .run();
    applying = false;
    args?.onUpdate?.(getMarkdown());
    return true;
  }

  function replaceProtectedRaw(match: string, next: string): boolean {
    let nodePos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (nodePos >= 0) return false;
      if (node.type.name !== "agyProtected") return true;
      if (!String(node.attrs.raw).includes(match)) return true;
      nodePos = pos;
      return false;
    });
    if (nodePos < 0) return false;
    applying = true;
    editor
      .chain()
      .command(({ tr }) => {
        tr.setNodeMarkup(nodePos, undefined, { raw: next });
        return true;
      })
      .run();
    applying = false;
    args?.onUpdate?.(getMarkdown());
    return true;
  }

  return {
    setMarkdown,
    getMarkdown,
    replaceProseText,
    replaceProtectedRaw,
    setReadOnly(readOnly: boolean) {
      editor.setEditable(!readOnly);
    },
    destroy() {
      editor.destroy();
    },
  };
}

function documentFromChunks(body: string): JSONContent {
  const content: JSONContent[] = [];
  for (const chunk of chunkMarkdown(body)) {
    if (chunk.kind === "protected") {
      content.push({ type: "agyProtected", attrs: { raw: chunk.raw } });
      continue;
    }
    if (chunk.text.length === 0) continue;
    const nodes = parseMarkdownChunk(chunk.text);
    if (nodes.length > 0) content.push(...nodes);
  }
  return { type: "doc", content };
}

function parseMarkdownChunk(markdown: string): JSONContent[] {
  const chunk = new Editor({
    extensions: createAgencyMarkdownExtensions(),
    content: markdown,
    contentType: "markdown",
  });
  const nodes = chunk.getJSON().content ?? [];
  chunk.destroy();
  return nodes;
}
