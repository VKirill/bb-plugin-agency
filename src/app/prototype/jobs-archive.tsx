import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import type { Job as JobRecord } from "../../shared/contracts";
import type { JobSearchHitView, SavedViewRecord } from "../../shared/rpc-contract";
import type { AgencyApi } from "../data/agency-api";
import { failureNotice } from "../data/persist";
import { asUiState } from "../data/view-models";
import { tr, uiLocale } from "../i18n";
import { Button, Choice, Status, TextField } from "./shared";

/** What the jobs board needs from the server beyond the snapshot. */
export type JobsArchiveApi = Pick<AgencyApi, "searchJobs" | "listArchivedJobs" | "listSavedViews" | "saveSavedView" | "deleteSavedView">;

export type BoardArchive = { api: JobsArchiveApi; count: number };

/** Board filters a saved view remembers. */
export type BoardFilters = { q: string; filter: string; priority: string; pr: string; sort: string; view: string };

const PAGE = 50;
const FIELD_LABEL: Record<JobSearchHitView["field"], string> = { key: "номер", title: "название", brief: "описание", comment: "комментарий" };

function closedDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleDateString(uiLocale()) : "—";
}

/**
 * Server search for the query typed on the board: finds jobs by description and
 * comments and reaches the archive. Rows already shown on the board are skipped.
 */
export function ServerSearchHits({ api, query, shown, open, notice }: { api: JobsArchiveApi; query: string; shown: Set<string>; open: (id: string) => void; notice?: (text: string) => void }) {
  const [hits, setHits] = useState<JobSearchHitView[] | null>(null);
  const noticeRef = useRef(notice);
  noticeRef.current = notice;
  const text = query.trim();
  useEffect(() => {
    if (text.length < 2) {
      setHits(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void api.searchJobs({ query: text, limit: 50 }).then((result) => {
        if (!live) return;
        if (result.ok) setHits(result.value);
        else noticeRef.current?.(failureNotice(result.failure));
      });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, text]);
  const rest = (hits ?? []).filter((hit) => !shown.has(hit.key));
  if (text.length < 2 || !rest.length) return null;
  return (
    <section aria-label={tr("Ещё найдено")} className="-mx-3 md:-mx-4">
      <div className="flex h-9 items-center gap-2 border-b border-border bg-muted/30 px-4 text-sm font-medium">
        {tr("Ещё найдено: описания, комментарии, архив")}
        <span className="text-xs font-normal text-muted-foreground">{rest.length}</span>
      </div>
      {rest.map((hit) => (
        <button key={hit.jobId} type="button" onClick={() => open(hit.key)} className="flex min-h-9 w-full flex-col gap-0.5 border-b border-border px-4 py-2 text-left text-sm hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
          <span className="flex min-w-0 items-center gap-2">
            <span className="w-[3.75rem] shrink-0 truncate font-mono text-xs text-muted-foreground">{hit.key}</span>
            <span className="min-w-0 flex-1 truncate">{hit.title}</span>
            {hit.archived && <span className="shrink-0 rounded border border-border px-1 text-[10px] leading-4 text-muted-foreground">{tr("архив")}</span>}
            <Status state={asUiState(hit.state as Parameters<typeof asUiState>[0])} iconOnly />
          </span>
          {hit.field !== "key" && hit.field !== "title" && (
            <span className="truncate pl-[4.25rem] text-xs text-muted-foreground">
              {tr(FIELD_LABEL[hit.field])}: {hit.snippet}
            </span>
          )}
        </button>
      ))}
    </section>
  );
}

/** Closed job trees moved off the board after the archive period. Read-only list. */
export function ArchivedJobsList({ api, open, departmentName, notice }: { api: JobsArchiveApi; open: (id: string) => void; departmentName: (id: string) => string; notice?: (text: string) => void }) {
  const [rows, setRows] = useState<JobRecord[]>([]);
  const noticeRef = useRef(notice);
  noticeRef.current = notice;
  const [total, setTotal] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const load = useCallback(
    async (offset: number) => {
      setPending(true);
      const result = await api.listArchivedJobs({ limit: PAGE, offset });
      setPending(false);
      if (!result.ok) {
        noticeRef.current?.(failureNotice(result.failure));
        return;
      }
      setTotal(result.value.total);
      setRows((current) => (offset === 0 ? result.value.jobs : [...current, ...result.value.jobs]));
    },
    [api],
  );
  useEffect(() => {
    void load(0);
  }, [load]);
  if (total === null) return <p className="py-6 text-center text-sm text-muted-foreground">{tr("Загружаем архив…")}</p>;
  if (!total) return <p className="py-6 text-center text-sm text-muted-foreground">{tr("В архиве пока пусто. Сюда уходят полностью закрытые задачи со всеми подзадачами после срока из настроек плагина.")}</p>;
  return (
    <div aria-label={tr("Архив задач")} className="-mx-3 md:-mx-4">
      {rows.map((job) => (
        <button key={job.id} type="button" onClick={() => open(job.key)} className="flex min-h-9 w-full items-center gap-2 border-b border-border px-4 py-2 text-left text-sm hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
          <span className="w-[3.75rem] shrink-0 truncate font-mono text-xs text-muted-foreground">{job.key}</span>
          <span className={`min-w-0 flex-1 truncate ${job.parentJobId ? "text-muted-foreground" : ""}`}>{job.title}</span>
          <span className="hidden w-40 shrink-0 truncate text-xs text-muted-foreground sm:block">{departmentName(job.departmentId)}</span>
          <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{closedDate(job.closedAt)}</span>
          <Status state={asUiState(job.state)} iconOnly />
        </button>
      ))}
      {rows.length < total && (
        <div className="flex justify-center py-3">
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => void load(rows.length)}>
            {tr("Показать ещё · осталось {count}", { count: total - rows.length })}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Named sets of board filters, shared by everyone who opens the board. */
export function SavedViewsControl({ api, current, apply, notice }: { api: JobsArchiveApi; current: BoardFilters; apply: (filters: BoardFilters) => void; notice?: (text: string) => void }) {
  const [views, setViews] = useState<SavedViewRecord[]>([]);
  const [selected, setSelected] = useState("");
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const load = useCallback(async () => {
    const result = await api.listSavedViews();
    if (result.ok) setViews(result.value);
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);
  const choose = (id: string) => {
    setSelected(id);
    const view = views.find((item) => item.id === id);
    if (!view) return;
    apply({ q: "", filter: "all", priority: "all", pr: "all", sort: "id", view: "Список", ...view.filters });
  };
  const save = async () => {
    const title = name.trim();
    if (!title || pending) return;
    setPending(true);
    const existing = views.find((item) => item.name === title);
    const result = await api.saveSavedView({ ...(existing ? { id: existing.id } : {}), name: title, filters: current });
    setPending(false);
    if (!result.ok) {
      notice?.(failureNotice(result.failure));
      return;
    }
    setNaming(false);
    setName("");
    setSelected(result.value.id);
    await load();
  };
  const remove = async () => {
    if (!selected || pending) return;
    setPending(true);
    const result = await api.deleteSavedView({ id: selected });
    setPending(false);
    if (!result.ok) {
      notice?.(failureNotice(result.failure));
      return;
    }
    setSelected("");
    await load();
  };
  return (
    <>
      {views.length > 0 && (
        <div className="w-36">
          <Choice label="Сохранённый вид" value={selected || "none"} onChange={(value) => (value === "none" ? setSelected("") : choose(value))} options={[{ value: "none", label: "Виды" }, ...views.map((view) => ({ value: view.id, label: view.name }))]} />
        </div>
      )}
      {selected && (
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={pending} onClick={() => void remove()}>
          {tr("Удалить вид")}
        </Button>
      )}
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => { setName(views.find((item) => item.id === selected)?.name ?? ""); setNaming(true); }}>
        {tr("Сохранить вид")}
      </Button>
      <Dialog open={naming} onOpenChange={(value) => { if (!pending) setNaming(value); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tr("Сохранить вид")}</DialogTitle>
            <DialogDescription>{tr("Вид запоминает фильтры, поиск, сортировку и режим доски. Вид с тем же названием будет перезаписан.")}</DialogDescription>
          </DialogHeader>
          <TextField label="Название вида" value={name} onChange={setName} maxLength={80} required />
          <DialogFooter>
            <Button variant="ghost" disabled={pending} onClick={() => setNaming(false)}>{tr("Отмена")}</Button>
            <Button disabled={pending || !name.trim()} onClick={() => void save()}>{tr("Сохранить")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
