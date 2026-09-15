import { Markdown } from "@get-bb/plugin-sdk/app";
import {
  createElement,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { DocumentProperties } from "./properties";
import {
  createMarkdownSession,
  resolveEditorSource,
  type MarkdownSession,
} from "./session";
import { ensureEditorStyles } from "./styles";

export interface MarkdownEditorProps {
  value?: string;
  content?: string;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  onSave?: (next: string) => void;
}

function renderProtectedWithSdk(raw: string, element: HTMLElement): () => void {
  const root: Root = createRoot(element);
  root.render(createElement(Markdown, { content: raw }));
  return () => root.unmount();
}

export function MarkdownEditor(props: MarkdownEditorProps) {
  const source = resolveEditorSource(props);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<MarkdownSession | null>(null);
  const onChangeRef = useRef(props.onChange);
  const onSaveRef = useRef(props.onSave);
  const lastEmittedRef = useRef(source);
  const labelId = useId();
  onChangeRef.current = props.onChange;
  onSaveRef.current = props.onSave;

  useEffect(() => {
    ensureEditorStyles();
    const host = hostRef.current;
    if (host === null) return;
    const session = createMarkdownSession({
      element: host,
      readOnly: props.readOnly,
      renderProtected: renderProtectedWithSdk,
      onUpdate(next) {
        if (next === lastEmittedRef.current) return;
        lastEmittedRef.current = next;
        onChangeRef.current?.(next);
      },
    });
    session.setMarkdown(source);
    lastEmittedRef.current = session.getMarkdown();
    sessionRef.current = session;
    return () => {
      session.destroy();
      sessionRef.current = null;
    };
    // Mount once; later source/readOnly sync in the effects below.
  }, []);

  useEffect(() => {
    const session = sessionRef.current;
    if (session === null) return;
    if (source === lastEmittedRef.current) return;
    session.setMarkdown(source);
    lastEmittedRef.current = session.getMarkdown();
  }, [source]);

  useEffect(() => {
    sessionRef.current?.setReadOnly(props.readOnly === true);
  }, [props.readOnly]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (!(event.metaKey || event.ctrlKey) || event.key !== "s") return;
    event.preventDefault();
    const next = sessionRef.current?.getMarkdown() ?? source;
    onSaveRef.current?.(next);
  }

  return (
    <div
      className="agy-markdown-editor flex min-h-0 flex-1 flex-col"
      data-readonly={props.readOnly === true ? "true" : "false"}
      onKeyDown={handleKeyDown}
    >
      <DocumentProperties content={source} />
      <div
        ref={hostRef}
        aria-labelledby={labelId}
        className="agy-markdown-surface min-h-0 flex-1 overflow-y-auto px-3 py-3"
      />
      <span id={labelId} hidden>
        Документ Markdown
      </span>
    </div>
  );
}
