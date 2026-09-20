import { useCallback, useEffect, useMemo, useState } from "react";
import { experimental_FileLink as FileLink, experimental_NewThreadComposer as NewThreadComposer, Markdown, useBbContext, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { ideaThreadComposerPrompt } from "../../shared/idea-thread";
import type { IdeaItemView, rpcContract } from "../../shared/rpc-contract";
import { failureNotice } from "../data/persist";
import { createRpcAgencyApi, type RpcCaller } from "../data/rpc-agency-api";
import { tr, uiLocale } from "../i18n";
import { Button, Choice, Collection, Field, PageHead, SearchInput, TextField } from "./shared";

type IdeaDraft = {
  id?: string;
  revision: number;
  title: string;
  body: string;
  kind: IdeaItemView["kind"];
  status: IdeaItemView["status"];
  bindingId: string;
  sectionId: string;
  sectionLabel: string;
};

const KIND_LABEL: Record<IdeaItemView["kind"], string> = { idea: "Идея", todo: "Туду" };
const STATUS_LABEL: Record<IdeaItemView["status"], string> = {
  open: "Открыта",
  parked: "Отложена",
  done: "Сделана",
  archived: "В архиве",
};

/**
 * Owner warehouse of ideas and todos. Rows follow the catalog Collection; the
 * chosen row shows the markdown that also lives in the project folder.
 */
export function IdeasLivePage({
  projects,
  selectedId,
  openIdea,
  notice,
}: {
  projects: readonly { id: string; name: string; hostId?: string; root?: string }[];
  selectedId?: string;
  openIdea: (id?: string) => void;
  notice: (text: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const api = useMemo(() => createRpcAgencyApi(rpc as unknown as RpcCaller), [rpc]);
  const [items, setItems] = useState<IdeaItemView[] | null>(null);
  const [projectFilter, setProjectFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("open");
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState<IdeaDraft | null>(null);
  const [compose, setCompose] = useState<IdeaItemView | null>(null);
  const [closing, setClosing] = useState<IdeaItemView | null>(null);
  const [closeNote, setCloseNote] = useState("");
  const [pending, setPending] = useState(false);
  const bbContext = useBbContext();

  const load = useCallback(async () => {
    const result = await api.listIdeas(null);
    if (result.ok) setItems(result.value);
    else notice(failureNotice(result.failure));
  }, [api, notice]);

  useEffect(() => {
    void load();
  }, [load]);

  const projectName = useCallback(
    (bindingId: string) => projects.find((item) => item.id === bindingId)?.name ?? bindingId,
    [projects],
  );

  const visible = (items ?? []).filter((item) => {
    if (projectFilter !== "all" && item.bindingId !== projectFilter) return false;
    if (kindFilter !== "all" && item.kind !== kindFilter) return false;
    if (statusFilter === "open" && item.status !== "open" && item.status !== "parked") return false;
    if (statusFilter !== "open" && statusFilter !== "all" && item.status !== statusFilter) return false;
    const hay = `${item.title} ${item.sectionLabel} ${item.body}`.toLowerCase();
    return !q.trim() || hay.includes(q.trim().toLowerCase());
  });

  const current = items?.find((item) => item.id === selectedId) ?? null;

  const save = async () => {
    if (!draft || pending) return;
    setPending(true);
    const result = await api.saveIdea({
      ...(draft.id ? { id: draft.id } : {}),
      expectedRevision: draft.revision,
      title: draft.title,
      body: draft.body,
      kind: draft.kind,
      status: draft.status,
      bindingId: draft.bindingId,
      sectionId: draft.sectionId.trim() || null,
      sectionLabel: draft.sectionLabel,
    });
    setPending(false);
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    setDraft(null);
    openIdea(result.value.id);
    notice(result.value.fileWritten ? tr("Идея сохранена, файл записан в проект.") : tr("Идея сохранена в Агентстве. Файл в проекте не записался — повторите сохранение, когда машина проекта на связи."));
    void load();
  };

  const setStatus = async (
    item: IdeaItemView,
    status: IdeaItemView["status"],
    extras?: { resolution?: string; closedThreadId?: string | null },
  ) => {
    const result = await api.setIdeaStatus({
      id: item.id,
      expectedRevision: item.revision,
      status,
      resolution: extras?.resolution,
      closedThreadId: extras?.closedThreadId,
    });
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    notice(status === "done" ? tr("Идея отмечена сделанной, итог записан.") : tr("Статус идеи обновлён."));
    void load();
  };

  const confirmDone = async () => {
    if (!closing || pending) return;
    const resolution = closeNote.trim();
    if (!resolution) {
      notice(tr("Напишите, что сделали, прежде чем отметить идею сделанной."));
      return;
    }
    setPending(true);
    await setStatus(closing, "done", { resolution, closedThreadId: bbContext.threadId });
    setPending(false);
    setClosing(null);
    setCloseNote("");
  };

  const startThread = async (request: Record<string, unknown>) => {
    if (!compose || pending) return;
    setPending(true);
    const result = await api.spawnIdeaThread({ id: compose.id, request });
    setPending(false);
    if (!result.ok) {
      notice(failureNotice(result.failure));
      throw new Error(failureNotice(result.failure));
    }
    setCompose(null);
    navigate.toThread(result.value.threadId);
  };

  const openFile = (item: IdeaItemView) => {
    if (!item.hostId || !item.projectPath) {
      notice(tr("Файл идеи ещё не записан на машину проекта."));
      return;
    }
    if (!navigate.experimental_openFilePreview({ target: { kind: "host", hostId: item.hostId, path: item.projectPath }, location: null })) {
      notice(tr("Не удалось открыть документ в панели BB."));
    }
  };

  const origin = (item: IdeaItemView) => {
    const project = projectName(item.bindingId);
    return item.sectionLabel ? `${project} / ${item.sectionLabel}` : project;
  };

  return (
    <div className="space-y-5">
      <PageHead title="Идеи" description="Склад обсуждённых идей и туду. Карточка открывает оформленный markdown; тот же текст лежит файлом в папке проекта.">
        <Button
          data-testid="idea-add"
          disabled={projects.length === 0}
          onClick={() =>
            setDraft({
              revision: 0,
              title: "",
              body: "## Суть\n\n## Зачем\n\n## Контекст\n\n## Следующий шаг\n",
              kind: "idea",
              status: "open",
              bindingId: projectFilter !== "all" ? projectFilter : projects[0]?.id ?? "",
              sectionId: "",
              sectionLabel: "",
            })
          }
        >
          {tr("Новая идея")}
        </Button>
      </PageHead>
      <div className="flex flex-wrap gap-2">
        <SearchInput className="basis-48 grow" aria-label={tr("Поиск идей")} placeholder={tr("Найти идею…")} value={q} onChange={(event) => setQ(event.target.value)} />
        <div className="w-52">
          <Choice label="Проект" value={projectFilter} onChange={setProjectFilter} options={[{ value: "all", label: "Все проекты" }, ...projects.map((item) => ({ value: item.id, label: item.name }))]} />
        </div>
        <div className="w-40">
          <Choice label="Вид записи" value={kindFilter} onChange={setKindFilter} options={[{ value: "all", label: "Идеи и туду" }, { value: "idea", label: "Идеи" }, { value: "todo", label: "Туду" }]} />
        </div>
        <div className="w-44">
          <Choice label="Статус идеи" value={statusFilter} onChange={setStatusFilter} options={[{ value: "open", label: "Открытые" }, { value: "done", label: "Сделанные" }, { value: "archived", label: "Архив" }, { value: "all", label: "Все" }]} />
        </div>
      </div>
      {items === null ? (
        <p className="text-sm text-muted-foreground">{tr("Загружаем идеи…")}</p>
      ) : (
        <Collection
          columns={["Идея", "Вид", "Откуда", "Обновлена"]}
          rows={visible.map((item) => ({
            id: item.id,
            name: <span className="font-medium">{item.title}</span>,
            cells: [tr(KIND_LABEL[item.kind]), origin(item), new Date(item.updatedAt).toLocaleDateString(uiLocale())],
            open: () => openIdea(item.id),
          }))}
        />
      )}
      {current && (
        <section className="max-w-3xl rounded-lg border border-border bg-muted/20 p-5">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold">{current.title}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{`${tr(KIND_LABEL[current.kind])} · ${origin(current)} · ${tr(STATUS_LABEL[current.status])} · ${new Date(current.updatedAt).toLocaleDateString(uiLocale())}`}</p>
              {current.hostId && current.projectPath ? (
                <p className="text-xs text-muted-foreground">
                  <FileLink target={{ kind: "host", hostId: current.hostId, path: current.projectPath }}>{current.projectPath}</FileLink>
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">{current.relativePath}</p>
              )}
            </div>
            <Button size="sm" variant="ghost" aria-label={tr("Закрыть идею")} onClick={() => openIdea()}>{tr("Закрыть")}</Button>
          </div>
          <Markdown content={current.body} />
          {current.resolution ? (
            <div className="mt-4 border-t border-border pt-4">
              <h3 className="text-sm font-medium">{tr("Итог")}</h3>
              <Markdown content={current.resolution} />
              <p className="mt-2 text-xs text-muted-foreground">
                {tr("Закрыто")}
                {": "}
                {current.closedAt ? new Date(current.closedAt).toLocaleString(uiLocale()) : "—"}
                {current.closedThreadId ? ` · ${current.closedThreadId}` : ""}
              </p>
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button data-testid="idea-thread" onClick={() => setCompose(current)}>{tr("Создать тред")}</Button>
            <Button variant="outline" data-testid="idea-edit" onClick={() => setDraft({ id: current.id, revision: current.revision, title: current.title, body: current.body, kind: current.kind, status: current.status, bindingId: current.bindingId, sectionId: current.sectionId ?? "", sectionLabel: current.sectionLabel })}>{tr("Редактировать")}</Button>
            <Button variant="outline" onClick={() => openFile(current)}>{tr("Открыть файл")}</Button>
            {current.status !== "done" && (
              <Button
                variant="outline"
                onClick={() => {
                  setClosing(current);
                  setCloseNote(current.resolution);
                }}
              >
                {tr("Отметить сделанной")}
              </Button>
            )}
            {current.status !== "archived" && <Button variant="ghost" onClick={() => void setStatus(current, "archived")}>{tr("В архив")}</Button>}
          </div>
        </section>
      )}
      <Dialog open={Boolean(draft)} onOpenChange={(open) => { if (!open && !pending) setDraft(null); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" data-testid="idea-dialog">
          <DialogHeader>
            <DialogTitle>{draft?.id ? tr("Изменить идею") : tr("Новая идея")}</DialogTitle>
            <DialogDescription>{tr("Название, проект и текст по регламенту: суть, зачем, контекст, следующий шаг. Файл появится в .bb/agency/ideas/ выбранного проекта.")}</DialogDescription>
          </DialogHeader>
          {draft && (
            <>
              <TextField label="Название идеи" value={draft.title} maxLength={200} required onChange={(title) => setDraft({ ...draft, title })} />
              <Field label="Проект" required>
                <Choice label="Проект" value={draft.bindingId} onChange={(bindingId) => setDraft({ ...draft, bindingId })} options={projects.map((item) => ({ value: item.id, label: item.name }))} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Вид">
                  <Choice label="Вид записи" value={draft.kind} onChange={(kind) => setDraft({ ...draft, kind: kind as IdeaItemView["kind"] })} options={[{ value: "idea", label: "Идея" }, { value: "todo", label: "Туду" }]} />
                </Field>
                <Field label="Статус">
                  <Choice label="Статус идеи" value={draft.status} onChange={(status) => setDraft({ ...draft, status: status as IdeaItemView["status"] })} options={Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))} />
                </Field>
              </div>
              <TextField label="Раздел — как его видит владелец" value={draft.sectionLabel} maxLength={200} onChange={(sectionLabel) => setDraft({ ...draft, sectionLabel })} />
              <TextField label="Содержание" multiline rows={12} maxLength={20_000} required value={draft.body} onChange={(body) => setDraft({ ...draft, body })} />
            </>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setDraft(null)}>{tr("Отмена")}</Button>
            <Button data-testid="idea-save" disabled={pending || !draft?.title.trim() || !draft.body.trim() || !draft.bindingId} onClick={() => void save()}>{pending ? tr("Сохраняем…") : tr("Сохранить идею")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(closing)} onOpenChange={(open) => { if (!open && !pending) setClosing(null); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" data-testid="idea-done-dialog">
          <DialogHeader>
            <DialogTitle>{tr("Отметить сделанной")}</DialogTitle>
            <DialogDescription>{tr("Кратко напишите, что сделали. Дата и тред закроются вместе со статусом.")}</DialogDescription>
          </DialogHeader>
          <TextField
            label="Что сделали"
            multiline
            rows={5}
            maxLength={4000}
            required
            value={closeNote}
            onChange={setCloseNote}
          />
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setClosing(null)}>{tr("Отмена")}</Button>
            <Button data-testid="idea-done-save" disabled={pending || !closeNote.trim()} onClick={() => void confirmDone()}>
              {pending ? tr("Сохраняем…") : tr("Записать итог")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(compose)} onOpenChange={(open) => { if (!open && !pending) setCompose(null); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl" data-testid="idea-thread-dialog">
          <DialogHeader>
            <DialogTitle>{tr("Создать тред")}</DialogTitle>
            <DialogDescription>{tr("Штатный композер BB: текст идеи уже подставлен. Отправка откроет обычный чат, не скрытый запуск сотрудника.")}</DialogDescription>
          </DialogHeader>
          {compose && (
            <NewThreadComposer
              key={compose.id}
              defaultProjectId={compose.bbProjectId ?? undefined}
              defaultEnvironment={compose.hostId ? { type: "host", hostId: compose.hostId, workspace: { type: "unmanaged", path: null } } : undefined}
              initialPrompt={ideaThreadComposerPrompt(compose)}
              draftKey={`agency-idea-thread:${compose.id}`}
              layout="document"
              onSubmit={(request) => startThread(request as unknown as Record<string, unknown>)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
