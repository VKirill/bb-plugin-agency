import { useEffect } from "react";
import { experimental_SourceCode as SourceCode } from "@get-bb/plugin-sdk/app";
import { MarkdownEditor } from "../editor";
import { Button, Icon } from "./shared";
import type { TaskFile } from "./data";

export function FileWorkspace({
  file,
  draft,
  onDraft,
  onSave,
  close,
  nativePanel = false,
  persisted = false,
  saving = false,
  error,
}: {
  file: TaskFile;
  draft: string;
  onDraft: (value: string) => void;
  onSave: (content?: string) => void;
  close: () => void;
  nativePanel?: boolean;
  persisted?: boolean;
  saving?: boolean;
  error?: string | null;
}) {
  const dirty = draft !== file.content;
  const markdown = /\.(md|markdown)$/i.test(file.name);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return (
    <section
      aria-label={`Документ ${file.name}`}
      className={`agency-file-workspace flex h-full min-h-0 flex-col rounded-lg border border-border bg-background ${nativePanel ? "agency-native-doc" : ""}`}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="FileText" className="size-4 shrink-0 text-muted-foreground" />
          <h2 className="truncate text-sm font-semibold" title={file.name}>
            {file.name}
          </h2>
          <span className="whitespace-nowrap text-xs text-muted-foreground">v{file.version || 1}</span>
        </div>
        <div className="flex items-center gap-2">
          {file.kind === "text" && (
            <>
              <span role="status" className="text-xs text-muted-foreground">
                {saving ? "Сохраняем…" : dirty ? "Есть изменения" : persisted ? "Сохранено" : "Сохранено в примере"}
              </span>
              <Button size="sm" disabled={!dirty || saving} onClick={() => onSave(draft)}>
                Сохранить файл
              </Button>
            </>
          )}
          {!nativePanel && (
            <Button size="sm" variant="ghost" onClick={close}>
              ← К задаче
            </Button>
          )}
        </div>
      </div>
      {error ? <p className="shrink-0 border-b border-border px-4 py-2 text-xs text-muted-foreground">{error}</p> : null}
      <div className="agency-file-body flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-4 sm:p-5">
        {file.kind === "image" ? (
          <img src={file.content} alt={file.name} className="mx-auto max-h-[65dvh] max-w-full object-contain" />
        ) : markdown ? (
          <MarkdownEditor value={draft} onChange={onDraft} readOnly={saving} onSave={onSave} />
        ) : (
          <SourceCode content={draft} path={file.name} overflow="scroll" />
        )}
      </div>
      <p className="shrink-0 border-t border-border px-4 py-2 text-xs text-muted-foreground">
        {persisted
          ? file.kind === "text"
            ? "Правки сохраняются как новая версия файла."
            : "Вложение открыто из сохранённого файла."
          : file.kind === "text"
            ? "Правки и предыдущие версии хранятся в примере до перезагрузки."
            : "Вложение хранится в примере до перезагрузки."}
      </p>
    </section>
  );
}
