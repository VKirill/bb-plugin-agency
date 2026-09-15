import type { ProtectedBlockRenderer } from "./protected-node";

export type ProtectedPreviewKind = "markdown" | "source";

export function protectedPreviewKind(raw: string): ProtectedPreviewKind {
  const start = raw.trimStart();
  if (start.startsWith("::")) return "source";
  return "markdown";
}

export interface ProtectedBlockView {
  dom: HTMLElement;
  setRaw(raw: string): void;
  setEditable(editable: boolean): void;
  destroy(): void;
}

export function mountProtectedBlockView(args: {
  raw: string;
  editable: boolean;
  renderProtected?: ProtectedBlockRenderer;
  onCommit: (raw: string) => void;
}): ProtectedBlockView {
  const dom = document.createElement("div");
  dom.setAttribute("data-agy-protected", "true");
  dom.setAttribute("contenteditable", "false");

  const toolbar = document.createElement("div");
  toolbar.className = "agy-protected-toolbar";
  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "agy-protected-edit";
  editButton.textContent = "Изменить блок";
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "agy-protected-save";
  saveButton.textContent = "Сохранить";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "agy-protected-cancel";
  cancelButton.textContent = "Отмена";
  toolbar.append(editButton, saveButton, cancelButton);

  const preview = document.createElement("div");
  preview.className = "agy-protected-preview";
  const draft = document.createElement("textarea");
  draft.className = "agy-protected-draft";
  draft.spellcheck = false;

  dom.append(toolbar, preview, draft);

  let raw = args.raw;
  let editable = args.editable;
  let editing = false;
  let disposePreview: void | (() => void);

  function paintPreview(): void {
    if (typeof disposePreview === "function") disposePreview();
    disposePreview = undefined;
    preview.replaceChildren();
    if (protectedPreviewKind(raw) === "source") {
      const source = document.createElement("pre");
      source.className = "agy-protected-source";
      source.textContent = raw;
      preview.append(source);
      return;
    }
    const cleanup = args.renderProtected?.(raw, preview);
    if (typeof cleanup === "function") disposePreview = cleanup;
  }

  function syncChrome(): void {
    editButton.hidden = !editable || editing;
    saveButton.hidden = !editing;
    cancelButton.hidden = !editing;
    draft.hidden = !editing;
    preview.hidden = editing;
    if (editing) draft.value = raw;
  }

  editButton.addEventListener("click", (event) => {
    event.preventDefault();
    editing = true;
    syncChrome();
    draft.focus();
  });
  saveButton.addEventListener("click", (event) => {
    event.preventDefault();
    raw = draft.value;
    editing = false;
    paintPreview();
    syncChrome();
    args.onCommit(raw);
  });
  cancelButton.addEventListener("click", (event) => {
    event.preventDefault();
    draft.value = raw;
    editing = false;
    syncChrome();
  });

  paintPreview();
  syncChrome();

  return {
    dom,
    setRaw(next) {
      raw = next;
      if (!editing) {
        paintPreview();
        syncChrome();
      }
    },
    setEditable(next) {
      editable = next;
      if (!editable && editing) {
        draft.value = raw;
        editing = false;
      }
      syncChrome();
    },
    destroy() {
      if (typeof disposePreview === "function") disposePreview();
    },
  };
}
