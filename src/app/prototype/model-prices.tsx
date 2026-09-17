import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { ModelPriceRowView, ModelPricesView } from "../../shared/rpc-contract";
import type { rpcContract } from "../../shared/rpc-contract";
import {
  draftIssues,
  draftsFromRows,
  modelsToPrice,
  pricesDirty,
  rowsFromDrafts,
  sortDrafts,
  type PriceDraft,
} from "../data/model-prices";
import { normalizeModelId } from "../../shared/model-id";
import { Button, Panel } from "./shared";
import { tr } from "../i18n";

/**
 * Model prices, USD per million tokens. Everything the dashboard turns into money comes from
 * this table: built-in prices are the starting point, any model can be added, any price changed.
 */

const FIELDS = [
  { key: "input" as const, label: "Вход", hint: "Токены запроса без кэша" },
  { key: "cachedInput" as const, label: "Кэш", hint: "Чтение из кэша запроса" },
  { key: "output" as const, label: "Ответ", hint: "Токены ответа, включая рассуждения" },
];

function PriceInput({
  value,
  label,
  onChange,
}: {
  value: string;
  label: string;
  onChange: (next: string) => void;
}) {
  return (
    <input
      aria-label={label}
      inputMode="decimal"
      className="w-24 rounded-md border border-border bg-background px-2 py-1 text-right text-sm tabular-nums text-foreground"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function RowAction({
  draft,
  origin,
  onRemove,
  onReset,
}: {
  draft: PriceDraft;
  origin: ModelPriceRowView | undefined;
  onRemove: () => void;
  onReset: (row: ModelPriceRowView) => void;
}) {
  if (!origin || origin.custom) {
    return <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onRemove}>{tr("Убрать")}</Button>;
  }
  const changed = pricesDirty([draft], [origin]);
  if (!changed) return null;
  return <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onReset(origin)}>{tr("Вернуть цену")}</Button>;
}

export function ModelPricesPanel({ notice }: { notice: (text: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<ModelPricesView | null>(null);
  const [drafts, setDrafts] = useState<PriceDraft[]>([]);
  const [newModel, setNewModel] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = (value: ModelPricesView) => {
    setView(value);
    setDrafts(sortDrafts(draftsFromRows(value.rows), value.usedModels));
  };

  useEffect(() => {
    let live = true;
    void Promise.resolve(rpc.call("modelPrices", null)).then(
      (value) => { if (live) load(value as ModelPricesView); },
      () => { if (live) setFailed(true); },
    );
    return () => { live = false; };
  }, [rpc]);

  const used = useMemo(() => new Set((view?.usedModels ?? []).map((model) => normalizeModelId(model))), [view]);
  /** What was loaded, by model: it tells a built-in row from the owner's and undoes a change. */
  const loaded = useMemo(() => new Map((view?.rows ?? []).map((row) => [normalizeModelId(row.model), row])), [view]);
  const missing = useMemo(() => modelsToPrice(view, drafts), [view, drafts]);
  const issues = useMemo(() => draftIssues(drafts), [drafts]);
  const dirty = view ? pricesDirty(drafts, view.rows) : false;

  const setField = (index: number, field: keyof PriceDraft, next: string) => {
    setDrafts((current) => current.map((draft, at) => (at === index ? { ...draft, [field]: next } : draft)));
  };
  const addRow = (model: string) => {
    const id = normalizeModelId(model);
    if (!id || drafts.some((draft) => normalizeModelId(draft.model) === id)) return;
    setDrafts((current) => [...current, { model: id, input: "0", cachedInput: "0", output: "0", custom: true }]);
    setNewModel("");
  };
  const save = async () => {
    const rows = rowsFromDrafts(drafts);
    if (!rows || pending) return;
    setPending(true);
    try {
      const saved = (await rpc.call("setModelPrices", { rows })) as ModelPricesView;
      load(saved);
      notice(tr("Цены сохранены. Дашборд пересчитает стоимость при следующем обновлении."));
    } catch {
      notice(tr("Не удалось сохранить цены. Попробуйте ещё раз."));
    } finally {
      setPending(false);
    }
  };

  if (failed) return <Panel title="Цены моделей"><p className="text-sm text-muted-foreground">{tr("Не удалось загрузить цены.")}</p></Panel>;
  if (!view) return <Panel title="Цены моделей"><p className="text-sm text-muted-foreground">{tr("Загружаем цены…")}</p></Panel>;

  return (
    <Panel title="Цены моделей">
      <div className="space-y-3" data-testid="model-prices">
        <p className="text-sm text-muted-foreground">
          {tr("USD за миллион токенов. По этой таблице дашборд переводит токены в деньги: это оценка по ценам API, а не счёт подписки.")}
        </p>
        {view.error && (
          <p role="alert" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
            {tr("Прежнее значение настройки прочитать не удалось, работают встроенные цены: {error}", { error: view.error })}
          </p>
        )}

        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{tr("Модель")}</th>
                {FIELDS.map((field) => (
                  <th key={field.key} className="px-3 py-2 text-right font-medium" title={tr(field.hint)}>{tr(field.label)}</th>
                ))}
                <th className="px-3 py-2 text-right font-medium"><span className="sr-only">{tr("Строка")}</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {drafts.map((draft, index) => (
                <tr key={`${draft.model}-${index}`} className="hover:bg-muted/20">
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        aria-label={tr("Модель")}
                        className="w-56 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
                        value={draft.model}
                        onChange={(event) => setField(index, "model", event.target.value)}
                      />
                      {used.has(normalizeModelId(draft.model)) && (
                        <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">{tr("в работе")}</span>
                      )}
                    </div>
                  </td>
                  {FIELDS.map((field) => (
                    <td key={field.key} className="px-3 py-2 text-right">
                      <PriceInput
                        value={draft[field.key]}
                        label={`${tr(field.label)} · ${draft.model}`}
                        onChange={(next) => setField(index, field.key, next)}
                      />
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right">
                    <RowAction
                      draft={draft}
                      origin={loaded.get(normalizeModelId(draft.model))}
                      onRemove={() => setDrafts((current) => current.filter((_, at) => at !== index))}
                      onReset={(row) => setDrafts((current) => current.map((item, at) => (at === index ? draftsFromRows([row])[0]! : item)))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted-foreground">
            {tr("Добавить модель")}
            <input
              aria-label={tr("Добавить модель")}
              list="agency-price-models"
              placeholder="gpt-5.6-sol"
              className="ml-2 w-56 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
              value={newModel}
              onChange={(event) => setNewModel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                addRow(newModel);
              }}
            />
          </label>
          <datalist id="agency-price-models">
            {missing.map((model) => <option key={model} value={model} />)}
          </datalist>
          <Button size="sm" variant="outline" className="h-8" onClick={() => addRow(newModel)} disabled={!normalizeModelId(newModel)}>
            {tr("Добавить")}
          </Button>
        </div>

        {missing.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{tr("Сотрудники работают на этих моделях, а цены у них нет:")}</span>
            {missing.map((model) => (
              <Button key={model} size="sm" variant="outline" className="h-7 px-2 font-mono text-[11px]" onClick={() => addRow(model)}>
                + {model}
              </Button>
            ))}
          </div>
        )}

        {issues.length > 0 && (
          <ul role="alert" className="space-y-1 text-xs text-muted-foreground">
            {issues.map((issue, index) => <li key={`${issue.model}-${index}`}>{issue.model ? `${issue.model}: ` : ""}{issue.text}</li>)}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void save()} disabled={!dirty || pending || issues.length > 0}>{tr("Сохранить цены")}</Button>
          {dirty && <Button size="sm" variant="ghost" onClick={() => load(view)}>{tr("Вернуть как было")}</Button>}
          <p className="text-xs text-muted-foreground">
            {tr("Встроенные цены проверены {date}. Источник: {source}", { date: view.checkedAt, source: view.source })}
          </p>
        </div>
      </div>
    </Panel>
  );
}
