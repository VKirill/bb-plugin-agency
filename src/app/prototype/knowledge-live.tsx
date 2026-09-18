import { useCallback, useEffect, useMemo, useState } from "react";
import { Markdown, useRpc } from "@get-bb/plugin-sdk/app";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import type { KnowledgeItemView, rpcContract } from "../../shared/rpc-contract";
import { failureNotice } from "../data/persist";
import { createRpcAgencyApi, type RpcCaller } from "../data/rpc-agency-api";
import { tr, uiLocale } from "../i18n";
import { Button, Choice, Collection, Field, InfoHint, PageHead, SearchInput, TextField } from "./shared";

type ScopeOption = { value: string; label: string };
type Draft = { id?: string; revision: number; title: string; body: string; source: string; scope: string };

const STATUS_LABEL: Record<KnowledgeItemView["status"], string> = { accepted: "Принят", proposal: "Предложение", archived: "В архиве" };

function scopeKey(item: Pick<KnowledgeItemView, "scopeKind" | "scopeId">): string {
  return item.scopeKind === "agency" ? "agency" : `${item.scopeKind}:${item.scopeId}`;
}

/**
 * Knowledge on data: materials by scope. Accepted materials reach every launch
 * of their scope; proposals from employees wait for the owner's decision.
 */
export function KnowledgeLivePage({
  departments,
  projects,
  notice,
}: {
  departments: readonly { id: string; name: string }[];
  projects: readonly { id: string; name: string }[];
  notice: (text: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const api = useMemo(() => createRpcAgencyApi(rpc as unknown as RpcCaller), [rpc]);
  const [items, setItems] = useState<KnowledgeItemView[] | null>(null);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState("all");
  const [status, setStatus] = useState("active");
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);

  const scopes: ScopeOption[] = useMemo(
    () => [
      { value: "agency", label: tr("Всё Агентство") },
      ...departments.map((item) => ({ value: `department:${item.id}`, label: tr("Отдел «{name}»", { name: item.name }) })),
      ...projects.map((item) => ({ value: `project:${item.id}`, label: tr("Проект «{name}»", { name: item.name }) })),
    ],
    [departments, projects],
  );
  const scopeLabel = (key: string) => scopes.find((item) => item.value === key)?.label ?? key;

  const load = useCallback(async () => {
    const result = await api.listKnowledge();
    if (result.ok) setItems(result.value);
    else notice(failureNotice(result.failure));
  }, [api, notice]);
  useEffect(() => {
    void load();
  }, [load]);

  const visible = (items ?? []).filter(
    (item) =>
      (scope === "all" || scopeKey(item) === scope) &&
      (status === "all" ? true : status === "active" ? item.status !== "archived" : item.status === status) &&
      `${item.title} ${item.body} ${item.source}`.toLowerCase().includes(q.toLowerCase()),
  );
  const current = (items ?? []).find((item) => item.id === selected) ?? null;
  const proposals = (items ?? []).filter((item) => item.status === "proposal").length;

  const save = async () => {
    if (!draft || pending) return;
    const [kind, id] = draft.scope === "agency" ? ["agency", null] : (draft.scope.split(":", 2) as [string, string]);
    setPending(true);
    const result = await api.saveKnowledge({
      ...(draft.id ? { id: draft.id } : {}),
      expectedRevision: draft.revision,
      title: draft.title,
      body: draft.body,
      source: draft.source,
      scopeKind: kind as KnowledgeItemView["scopeKind"],
      scopeId: id,
    });
    setPending(false);
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    setDraft(null);
    setSelected(result.value.id);
    notice(tr("Материал сохранён и принят: он придёт в запуски своей области."));
    void load();
  };

  const setItemStatus = async (item: KnowledgeItemView, next: KnowledgeItemView["status"]) => {
    const result = await api.setKnowledgeStatus({ id: item.id, expectedRevision: item.revision, status: next });
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    notice(next === "accepted" ? tr("Материал принят: он придёт в запуски своей области.") : next === "archived" ? tr("Материал убран в архив и больше не приходит в запуски.") : tr("Материал возвращён в предложения."));
    void load();
  };

  return (
    <div className="space-y-5">
      <PageHead title="Знания" description="Принятые материалы приходят в каждый запуск своей области: всего Агентства, отдела или проекта.">
        <Button data-testid="knowledge-add" onClick={() => setDraft({ revision: 0, title: "", body: "", source: "", scope: scope === "all" ? "agency" : scope })}>{tr("Добавить материал")}</Button>
      </PageHead>
      {proposals > 0 && <p role="status" className="text-sm">{tr("Предложений от сотрудников: {count}. Примите нужные — только принятые материалы доходят до запусков.", { count: proposals })}</p>}
      <div className="flex flex-wrap gap-2">
        <SearchInput className="basis-48 grow" aria-label={tr("Поиск знаний")} placeholder={tr("Найти материал или источник…")} value={q} onChange={(event) => setQ(event.target.value)} />
        <div className="w-52">
          <Choice label="Область знаний" value={scope} onChange={setScope} options={[{ value: "all", label: "Все области" }, ...scopes]} />
        </div>
        <div className="w-60">
          <Choice label="Статус материала" value={status} onChange={setStatus} options={[{ value: "active", label: "Действующие и предложения" }, { value: "accepted", label: "Принятые" }, { value: "proposal", label: "Предложения" }, { value: "archived", label: "Архив" }, { value: "all", label: "Все материалы" }]} />
        </div>
      </div>
      {items === null ? (
        <p className="text-sm text-muted-foreground">{tr("Загружаем знания…")}</p>
      ) : (
        <Collection
          columns={["Материал", "Состояние", "Область", "Источник"]}
          rows={visible.map((item) => ({
            id: item.id,
            name: <span className="font-medium">{item.title}</span>,
            cells: [tr(STATUS_LABEL[item.status]), scopeLabel(scopeKey(item)), item.source],
            open: () => setSelected(item.id),
          }))}
        />
      )}
      {current && (
        <section className="max-w-3xl rounded-lg border border-border bg-muted/20 p-5">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold">{current.title}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{`${scopeLabel(scopeKey(current))} · ${current.source} · ${tr(STATUS_LABEL[current.status])} · ${new Date(current.updatedAt).toLocaleDateString(uiLocale())}`}</p>
              {current.proposedBy && <p className="text-xs text-muted-foreground">{tr(current.proposedBy === "agency:remarks" ? "Предложило Агентство: замечание повторилось в нескольких задачах" : current.proposedBy === "agency:lesson" ? "Предложило Агентство: черновик урока после приёмки задачи" : "Предложил сотрудник")}</p>}
            </div>
            <Button size="sm" variant="ghost" aria-label={tr("Закрыть материал")} onClick={() => setSelected(null)}>{tr("Закрыть")}</Button>
          </div>
          <Markdown content={current.body} />
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="outline" data-testid="knowledge-edit" onClick={() => setDraft({ id: current.id, revision: current.revision, title: current.title, body: current.body, source: current.source, scope: scopeKey(current) })}>{tr("Редактировать")}</Button>
            {current.status !== "accepted" && <Button data-testid="knowledge-accept" onClick={() => void setItemStatus(current, "accepted")}>{tr("Принять материал")}</Button>}
            {current.status !== "archived" && <Button variant="ghost" onClick={() => void setItemStatus(current, "archived")}>{tr("В архив")}</Button>}
            <InfoHint title="Как материал доходит до запуска">
              <p>{tr("Принятый материал попадает в промпт каждого запуска своей области строкой индекса: вид, название и сводка. Полный текст сотрудник берёт сам через bb agency knowledge get; целиком сразу приходят только закреплённые и важные записи.")}</p>
              <p>{tr("Это справка, не приказ: при противоречии с регламентом или поручением сотрудник задаёт вопрос.")}</p>
            </InfoHint>
          </div>
        </section>
      )}
      <Dialog open={Boolean(draft)} onOpenChange={(open) => { if (!open && !pending) setDraft(null); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" data-testid="knowledge-dialog">
          <DialogHeader>
            <DialogTitle>{draft?.id ? tr("Изменить материал") : tr("Новый материал")}</DialogTitle>
            <DialogDescription>{tr("Укажите область и источник. Материал, сохранённый владельцем, принят сразу; правка из треда сотрудника становится предложением.")}</DialogDescription>
          </DialogHeader>
          {draft && (
            <>
              <TextField label="Название материала" value={draft.title} maxLength={200} required onChange={(title) => setDraft({ ...draft, title })} />
              <Field label="Область" required>
                <Choice label="Область материала" value={draft.scope} onChange={(next) => setDraft({ ...draft, scope: next })} options={scopes} />
              </Field>
              <TextField label="Источник — ссылка или документ" value={draft.source} maxLength={500} required onChange={(source) => setDraft({ ...draft, source })} />
              <TextField label="Содержание материала" multiline rows={10} maxLength={20_000} required value={draft.body} onChange={(body) => setDraft({ ...draft, body })} />
            </>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setDraft(null)}>{tr("Отмена")}</Button>
            <Button data-testid="knowledge-save" disabled={pending || !draft?.title.trim() || !draft.body.trim() || !draft.source.trim()} onClick={() => void save()}>{pending ? tr("Сохраняем…") : tr("Сохранить материал")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
