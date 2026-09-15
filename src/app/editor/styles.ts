const STYLE_ID = "agy-markdown-editor-styles";

const CSS = `
.agy-markdown-editor .ProseMirror {
  color: var(--foreground);
  background: transparent;
  outline: none;
  min-height: 100%;
}
.agy-markdown-editor [hidden] { display: none !important; }
.agy-markdown-editor .ProseMirror > :first-child { margin-top: 0; }
.agy-markdown-editor .ProseMirror p { margin: 1.25em 0 0; }
.agy-markdown-editor .ProseMirror li > p { margin-top: 0; }
.agy-markdown-editor .ProseMirror h1,
.agy-markdown-editor .ProseMirror h2,
.agy-markdown-editor .ProseMirror h3,
.agy-markdown-editor .ProseMirror h4,
.agy-markdown-editor .ProseMirror h5,
.agy-markdown-editor .ProseMirror h6 {
  color: var(--foreground);
  font-weight: 600;
  margin-bottom: 0;
}
.agy-markdown-editor .ProseMirror h1 { font-size: 1.75em; line-height: 1.3; margin-top: 1.25em; }
.agy-markdown-editor .ProseMirror h2 { font-size: 1.25em; line-height: 1.4; margin-top: 1.75em; }
.agy-markdown-editor .ProseMirror h3 { font-size: 1.125em; line-height: 1.45; margin-top: 1.25em; }
.agy-markdown-editor .ProseMirror h4 { font-size: 1em; line-height: 1.5; margin-top: 1.25em; }
.agy-markdown-editor .ProseMirror h5,
.agy-markdown-editor .ProseMirror h6 {
  font-size: 0.875em;
  line-height: 1.5;
  font-weight: 500;
  color: var(--muted-foreground);
  margin-top: 1.4em;
}
.agy-markdown-editor .ProseMirror ul,
.agy-markdown-editor .ProseMirror ol {
  margin: 1.25em 0 0;
  padding-left: 1.5em;
}
.agy-markdown-editor .ProseMirror ul { list-style: disc; }
.agy-markdown-editor .ProseMirror ol { list-style: decimal; }
.agy-markdown-editor .ProseMirror li { margin-top: 0.5em; }
.agy-markdown-editor .ProseMirror ul:has(> li[data-checked]),
.agy-markdown-editor .ProseMirror ul[data-type="taskList"] {
  list-style: none;
  padding-left: 0;
}
.agy-markdown-editor .ProseMirror li[data-checked],
.agy-markdown-editor .ProseMirror li[data-type="taskItem"] {
  display: flex;
  align-items: flex-start;
  gap: 0.5em;
}
.agy-markdown-editor .ProseMirror li[data-checked] > label,
.agy-markdown-editor .ProseMirror li[data-type="taskItem"] > label {
  display: flex;
  margin-top: 0.2em;
}
.agy-markdown-editor .ProseMirror li[data-checked] > div,
.agy-markdown-editor .ProseMirror li[data-type="taskItem"] > div {
  flex: 1;
  min-width: 0;
}
.agy-markdown-editor .ProseMirror li[data-checked] p,
.agy-markdown-editor .ProseMirror li[data-type="taskItem"] p {
  margin-top: 0;
}
.agy-markdown-editor .ProseMirror blockquote {
  margin: 1.25em 0 0;
  padding-left: 1em;
  border-left: 2px solid var(--border);
  color: var(--muted-foreground);
}
.agy-markdown-editor .ProseMirror table {
  width: 100%;
  margin: 1.25em 0 0;
  border-collapse: collapse;
}
.agy-markdown-editor .ProseMirror th,
.agy-markdown-editor .ProseMirror td {
  border: 1px solid var(--border);
  padding: 0.4em 0.65em;
  vertical-align: top;
}
.agy-markdown-editor .ProseMirror th {
  background: color-mix(in oklab, var(--muted) 70%, transparent);
  font-weight: 600;
}
.agy-markdown-editor .ProseMirror code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
  background: color-mix(in oklab, var(--muted) 80%, transparent);
  padding: 0.1em 0.35em;
  border-radius: 0.25em;
}
.agy-markdown-editor .ProseMirror pre {
  margin: 1.25em 0 0;
  padding: 0.85em 1em;
  overflow-x: auto;
  background: color-mix(in oklab, var(--muted) 65%, transparent);
  border: 1px solid var(--border);
  border-radius: 0.5em;
}
.agy-markdown-editor .ProseMirror pre code {
  background: none;
  padding: 0;
}
.agy-markdown-editor [data-agy-protected] {
  margin: 1.25em 0 0;
  border: 1px solid var(--border);
  border-radius: 0.5em;
  padding: 0.5em 0.65em 0.75em;
}
.agy-markdown-editor .agy-protected-toolbar {
  display: flex;
  gap: 0.5em;
  margin-bottom: 0.5em;
}
.agy-markdown-editor .agy-protected-toolbar button {
  min-height: 1.75rem;
  padding: 0 0.65em;
  border: 1px solid var(--border);
  border-radius: 0.375em;
  background: color-mix(in oklab, var(--muted) 50%, transparent);
  color: var(--foreground);
  font-size: 0.75rem;
}
.agy-markdown-editor .agy-protected-draft {
  display: block;
  width: 100%;
  min-height: 8rem;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85em;
  color: var(--foreground);
  background: color-mix(in oklab, var(--muted) 55%, transparent);
  border: 1px solid var(--border);
  border-radius: 0.375em;
  padding: 0.6em 0.7em;
}
.agy-markdown-editor .agy-protected-source {
  margin: 0;
  white-space: pre-wrap;
  overflow-x: auto;
}
@media (prefers-color-scheme: dark) {
  .agy-markdown-editor .ProseMirror pre {
    background: color-mix(in oklab, var(--background) 70%, var(--foreground) 8%);
  }
}
`;

export function editorTypographyCss(): string {
  return CSS;
}

export function ensureEditorStyles(): void {
  if (typeof document === "undefined") return;
  const existing = document.getElementById(STYLE_ID);
  if (existing) {
    existing.textContent = CSS;
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}
