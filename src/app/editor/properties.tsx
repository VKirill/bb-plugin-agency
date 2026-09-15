import {
  flattenFrontmatterRows,
  parseFrontmatterView,
} from "./frontmatter-view";

export function DocumentProperties({ content }: { content: string }) {
  const view = parseFrontmatterView(content);
  if (view.source === null) return null;
  let rows: Array<{ key: string; value: string }> = [];
  if (!view.error) {
    try {
      rows = flattenFrontmatterRows(view.value);
    } catch {
      rows = [];
    }
  }
  return (
    <details className="agy-markdown-frontmatter mb-5 shrink-0 rounded-lg border border-border bg-muted/20 text-xs leading-relaxed">
      <summary className="cursor-pointer rounded-lg px-3 py-2.5 text-sm font-medium hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
        Свойства документа
      </summary>
      <div className="px-3 pb-3 pt-1">
        {view.error ? (
          <p className="text-muted-foreground">
            Не удалось разобрать YAML. Исходные свойства сохранены в файле.
          </p>
        ) : (
          <dl className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,3fr)] gap-x-4 gap-y-1.5">
            {rows.map((row) => (
              <div className="contents" key={row.key}>
                <dt className="break-words text-muted-foreground">{row.key}</dt>
                <dd className="min-w-0 whitespace-pre-wrap break-words">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </details>
  );
}
