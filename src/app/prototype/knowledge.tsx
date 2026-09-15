import { useState } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { STAGE1_UNAVAILABLE } from "../data/runtime-unavailable";
import { Button, TextField, Field, Choice, PageHead, SearchInput, Collection } from "./shared";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../../../components/ui/dialog";

export interface Material {
  id: string;
  title: string;
  scope: string;
  source: string;
  body: string;
  status: "accepted" | "proposal";
}

export const seedMaterials: Material[] = [];

export function KnowledgePage({
  items,
  setItems,
  scopes,
  live = true,
  notice,
}: {
  items: Material[];
  setItems: (items: Material[]) => void;
  scopes: string[];
  live?: boolean;
  notice?: (text: string) => void;
}) {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState("all");
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Material | null>(null);
  const current = items.find((item) => item.id === selected);
  const visible = items.filter((item) =>
    (scope === "all" || item.scope === scope) &&
    (status === "all" || item.status === status) &&
    `${item.title} ${item.body} ${item.source}`.toLowerCase().includes(q.toLowerCase())
  );
  const scopeOptions = [...new Set([...scopes, ...items.map((item) => item.scope)])];

  const refuseLive = () => {
    notice?.(STAGE1_UNAVAILABLE.knowledge);
  };

  const add = () => {
    if (live) {
      refuseLive();
      return;
    }
    setDraft({
      id: crypto.randomUUID(),
      title: "",
      scope: scope === "all" ? scopeOptions[0] || "Агентство" : scope,
      source: "",
      body: "",
      status: "proposal",
    });
  };

  const edit = (material: Material) => {
    if (live) {
      refuseLive();
      return;
    }
    setDraft({ ...material });
  };

  const accept = (id: string) => {
    if (live) {
      refuseLive();
      return;
    }
    setItems(items.map((item) => item.id === id ? { ...item, status: "accepted" } : item));
  };

  const save = () => {
    if (live) {
      refuseLive();
      setDraft(null);
      return;
    }
    if (!draft?.title.trim() || !draft.body.trim() || !draft.source.trim()) return;
    const saved = { ...draft, status: "proposal" as const };
    setItems(items.some((item) => item.id === saved.id) ? items.map((item) => item.id === saved.id ? saved : item) : [...items, saved]);
    setSelected(saved.id);
    setDraft(null);
  };

  return (
    <div className="space-y-5">
      <PageHead title="Знания" description="Материалы и принятые правила. Предложения ждут проверки перед использованием.">
        <Button data-testid="knowledge-add" onClick={add}>Добавить материал</Button>
      </PageHead>
      {live && (
        <p role="status" data-testid="knowledge-unavailable" className="text-sm text-muted-foreground">
          {STAGE1_UNAVAILABLE.knowledge}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <SearchInput aria-label="Поиск знаний" placeholder="Найти материал или источник…" value={q} onChange={(event) => setQ(event.target.value)} />
        <div className="w-44">
          <Choice label="Область знаний" value={scope} onChange={setScope} options={[{ value: "all", label: "Все проекты и отделы" }, ...scopeOptions]} />
        </div>
        <div className="w-44">
          <Choice label="Статус материала" value={status} onChange={setStatus} options={[{ value: "all", label: "Все материалы" }, { value: "accepted", label: "Принятые" }, { value: "proposal", label: "Предложения" }]} />
        </div>
      </div>
      <Collection
        columns={["Материал", "Состояние", "Область", "Источник"]}
        rows={visible.map((item) => ({
          id: item.id,
          name: <span className="font-medium">{item.title}</span>,
          cells: [item.status === "accepted" ? "Принят" : "На проверке", item.scope, item.source],
          open: () => setSelected(item.id),
        }))}
      />
      {current && (
        <section className="max-w-3xl rounded-lg border border-border bg-muted/20 p-5">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold">{current.title}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{current.scope} · {current.source}</p>
            </div>
            <Button size="sm" variant="ghost" aria-label="Закрыть материал" onClick={() => setSelected(null)}>Закрыть</Button>
          </div>
          <Markdown content={current.body} />
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" data-testid="knowledge-edit" onClick={() => edit(current)}>Редактировать</Button>
            {current.status === "proposal" ? (
              <Button data-testid="knowledge-accept" onClick={() => accept(current.id)}>Принять материал</Button>
            ) : (
              <span className="self-center text-xs text-muted-foreground">Принят в текущем примере</span>
            )}
          </div>
        </section>
      )}
      {!live && (
        <Dialog open={Boolean(draft)} onOpenChange={(open) => { if (!open) setDraft(null); }}>
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" data-testid="knowledge-dialog">
            <DialogHeader>
              <DialogTitle>{items.some((item) => item.id === draft?.id) ? "Изменить материал" : "Новый материал"}</DialogTitle>
              <DialogDescription>Укажите, где применяются сведения и откуда они получены. Новый материал сначала попадёт в предложения.</DialogDescription>
            </DialogHeader>
            {draft && (
              <>
                <TextField label="Название материала" value={draft.title} onChange={(title) => setDraft({ ...draft, title })} />
                <Field label="Проект или отдел">
                  <Choice label="Область материала" value={draft.scope} onChange={(next) => setDraft({ ...draft, scope: next })} options={scopeOptions} />
                </Field>
                <TextField label="Источник — ссылка или документ" value={draft.source} onChange={(source) => setDraft({ ...draft, source })} />
                <TextField label="Содержание материала" multiline value={draft.body} onChange={(body) => setDraft({ ...draft, body })} />
              </>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setDraft(null)}>Отмена</Button>
              <Button data-testid="knowledge-save" disabled={!draft?.title.trim() || !draft.body.trim() || !draft.source.trim()} onClick={save}>Сохранить материал</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
