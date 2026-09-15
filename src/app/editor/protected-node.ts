import { Node } from "@tiptap/core";
import { mountProtectedBlockView } from "./protected-view";

export type ProtectedBlockRenderer = (
  raw: string,
  element: HTMLElement,
) => void | (() => void);

export const ProtectedMarkdownBlock = Node.create<{
  renderProtected?: ProtectedBlockRenderer;
}>({
  name: "agyProtected",
  group: "block",
  atom: true,
  selectable: true,
  addOptions() {
    return { renderProtected: undefined };
  },
  addAttributes() {
    return {
      raw: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-agy-protected]" }];
  },
  renderHTML() {
    return ["div", { "data-agy-protected": "true" }];
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const view = mountProtectedBlockView({
        raw: String(node.attrs.raw ?? ""),
        editable: editor.isEditable,
        renderProtected: this.options.renderProtected,
        onCommit(next) {
          const pos = typeof getPos === "function" ? getPos() : null;
          if (typeof pos !== "number") return;
          editor
            .chain()
            .command(({ tr }) => {
              tr.setNodeMarkup(pos, undefined, { raw: next });
              return true;
            })
            .run();
        },
      });
      return {
        dom: view.dom,
        ignoreMutation: () => true,
        update(updated) {
          if (updated.type.name !== "agyProtected") return false;
          view.setRaw(String(updated.attrs.raw ?? ""));
          view.setEditable(editor.isEditable);
          return true;
        },
        selectNode() {
          view.dom.dataset.selected = "true";
        },
        deselectNode() {
          delete view.dom.dataset.selected;
        },
        destroy() {
          view.destroy();
        },
      };
    };
  },
  renderMarkdown(node: { attrs?: { raw?: string } }) {
    return String(node.attrs?.raw ?? "");
  },
});
