import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Switch } from "../../../components/ui/switch";
import type { DecisionTestView, DecisionView, rpcContract } from "../../shared/rpc-contract";
import { tr } from "../i18n";
import { Button, Choice, Field, HintHeading, InfoHint, Input, Panel, TextField } from "./shared";

/**
 * Оценщик: быстрая модель, которая отвечает решением, а не текстом. Владелец включает её,
 * выбирает ключ и видит, где именно Агентство будет спрашивать. Ключ здесь не хранится: в списке
 * — имена переменных Env Catalog, а вставленный ключ уходит в каталог и шифруется там.
 */

type Draft = {
  enabled: boolean;
  endpointKind: DecisionView["settings"]["endpointKind"];
  baseUrl: string;
  model: string;
  keySource: DecisionView["settings"]["keySource"];
  keyName: string;
  timeoutMs: number;
  points: string[];
};

const KEY_PROBLEM: Record<string, string> = {
  no_catalog: "Плагин Env Catalog не отвечает: выберите ключ из окружения машины или включите плагин.",
  not_found: "Переменной с таким именем нет: выберите другую или вставьте ключ ниже.",
  empty_name: "Укажите, в какой переменной лежит ключ.",
};

function testLine(result: DecisionTestView): string {
  if (result.ok) {
    const answers = result.answers.map((answer) => `${answer.id}=${String(answer.value)} (${Math.round(answer.confidence * 100)}%)`).join(", ");
    return tr("Ответила за {ms} мс: {answers}", { ms: result.ms, answers });
  }
  const reason =
    result.reason === "no_key"
      ? tr("ключ не найден")
      : result.reason === "timeout"
        ? tr("не ответила вовремя")
        : result.reason === "bad_answer"
          ? tr("ответ не по схеме")
          : tr("запрос не прошёл");
  return tr("Не получилось за {ms} мс: {reason}{detail}", { ms: result.ms, reason, detail: result.detail ? ` — ${result.detail}` : "" });
}

type Result<T> = { ok: true; value: T } | { ok: false; error?: { message?: string } };

export function DecisionsPanel({ notice }: { notice: (text: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const call = useMemo(
    () => async <T,>(method: string, input?: unknown): Promise<Result<T>> => {
      try {
        return (await rpc.call(method as never, input as never)) as Result<T>;
      } catch (error) {
        return { ok: false, error: { message: error instanceof Error ? error.message : undefined } };
      }
    },
    [rpc],
  );
  const [view, setView] = useState<DecisionView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);
  const [test, setTest] = useState<string | null>(null);
  const [newKey, setNewKey] = useState("");

  const load = useCallback(async () => {
    const result = await call<DecisionView>("getDecisionSettings");
    if (!result.ok) {
      notice(tr("Не удалось прочитать настройки оценщика."));
      return;
    }
    setView(result.value);
    const { settings } = result.value;
    setDraft({
      enabled: settings.enabled,
      endpointKind: settings.endpointKind,
      baseUrl: settings.baseUrl,
      model: settings.model,
      keySource: settings.keySource,
      keyName: settings.keyName,
      timeoutMs: settings.timeoutMs,
      points: [...settings.points],
    });
  }, [call, notice]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!view || !draft || pending) return;
    setPending(true);
    const result = await call<unknown>("saveDecisionSettings", { ...draft, expectedRevision: view.settings.revision });
    setPending(false);
    if (!result.ok) {
      notice(result.error?.message ?? tr("Не удалось сохранить настройки оценщика."));
      return;
    }
    notice(tr("Настройки оценщика сохранены."));
    void load();
  };

  const saveKey = async () => {
    if (!draft || !newKey.trim() || pending) return;
    setPending(true);
    const result = await call<unknown>("saveDecisionKey", { name: draft.keyName, value: newKey.trim() });
    setPending(false);
    if (!result.ok) {
      notice(result.error?.message ?? tr("Не удалось сохранить ключ."));
      return;
    }
    setNewKey("");
    notice(tr("Ключ сохранён в Env Catalog под именем {name}. Агентство запомнило только имя.", { name: draft.keyName }));
    void load();
  };

  const runTest = async () => {
    if (pending) return;
    setPending(true);
    setTest(tr("Спрашиваем…"));
    const result = await call<DecisionTestView>("testDecisionModel");
    setPending(false);
    setTest(result.ok ? testLine(result.value) : tr("Проверка не прошла: метод недоступен."));
  };

  if (!view || !draft) return <p className="text-sm text-muted-foreground">{tr("Загружаем настройки оценщика…")}</p>;

  const keyOptions = view.keyOptions.map((option) => ({
    value: option.name,
    label: option.service ? `${option.name} · ${option.service}` : option.name,
  }));

  return (
    <div className="space-y-4" data-testid="decisions-panel">
      <Panel
        title="Оценщик"
        info={
          <>
            <p>{tr("Быстрая модель, которая отвечает не текстом, а решением: выбор из списка, оценка по шкале или да/нет — и своей уверенностью.")}</p>
            <p>{tr("Она не заменяет сотрудника. Её спрашивают там, где Агентство и так решает по правилу, но правило грубое: например, стоит ли запоминать запись.")}</p>
            <p>{tr("Ответ ниже порога уверенности не применяется, а молчание и ошибка равны «не знаю»: Агентство продолжает работать по своим правилам.")}</p>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">{tr("Спрашивать оценщика")}</span>
            <Switch aria-label={tr("Спрашивать оценщика")} checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Куда обращаться">
              <Choice
                label="Куда обращаться"
                value={draft.endpointKind}
                onChange={(value) => setDraft({ ...draft, endpointKind: value as Draft["endpointKind"] })}
                options={[
                  { value: "openrouter", label: "OpenRouter" },
                  { value: "typesafe", label: "TypeSafe System One" },
                  { value: "custom", label: "Свой адрес" },
                ]}
              />
            </Field>
            <TextField label="Модель" value={draft.model} onChange={(model) => setDraft({ ...draft, model })} placeholder="typesafe/jev-1.13" maxLength={120} />
          </div>

          {draft.endpointKind === "custom" && (
            <TextField label="Адрес" value={draft.baseUrl} onChange={(baseUrl) => setDraft({ ...draft, baseUrl })} placeholder="https://gateway.example.com/v1" maxLength={300} hint="Совместимый с чат-форматом шлюз, например Cloudflare AI Gateway." />
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Где лежит ключ">
              <Choice
                label="Где лежит ключ"
                value={draft.keySource}
                onChange={(value) => setDraft({ ...draft, keySource: value as Draft["keySource"] })}
                options={[
                  { value: "env-catalog", label: "В плагине Env Catalog" },
                  { value: "machine-env", label: "В окружении машины" },
                ]}
              />
            </Field>
            {draft.keySource === "env-catalog" && view.catalogAvailable && keyOptions.length > 0 ? (
              <Field label="Переменная с ключом">
                <Choice label="Переменная с ключом" value={draft.keyName} onChange={(keyName) => setDraft({ ...draft, keyName })} options={keyOptions} />
              </Field>
            ) : (
              <TextField label="Переменная с ключом" value={draft.keyName} onChange={(keyName) => setDraft({ ...draft, keyName })} placeholder="OPENROUTER_API_KEY" maxLength={120} />
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            {view.keyReady ? tr("Ключ на месте: {name}.", { name: view.settings.keyName }) : tr(KEY_PROBLEM[view.keyProblem ?? "empty_name"] ?? KEY_PROBLEM.empty_name!)}
          </p>

          {draft.keySource === "env-catalog" && view.catalogAvailable && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-56 flex-1">
                <Field label="Вставить ключ" hint="Ключ уйдёт в Env Catalog под выбранным именем и зашифруется там. Агентство хранит только имя.">
                  <Input type="password" aria-label={tr("Вставить ключ")} value={newKey} placeholder="sk-or-…" onChange={(event) => setNewKey(event.target.value)} />
                </Field>
              </div>
              <Button size="sm" variant="outline" disabled={pending || !newKey.trim() || !draft.keyName.trim()} onClick={() => void saveKey()}>{tr("Сохранить ключ")}</Button>
            </div>
          )}

          <div className="space-y-2">
            <HintHeading level={3} title="Где спрашивать" hint={<p>{tr("Каждая точка включается отдельно. Выключенная точка работает по правилам Агентства, как будто оценщика нет.")}</p>} />
            {view.points.map((point) => (
              <label key={point.key} className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
                <Switch
                  aria-label={tr(point.title)}
                  checked={draft.points.includes(point.key)}
                  onCheckedChange={(on) => setDraft({ ...draft, points: on ? [...draft.points, point.key] : draft.points.filter((item) => item !== point.key) })}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{tr(point.title)}</span>
                  <span className="block text-xs text-muted-foreground">{tr(point.hint)}</span>
                  <span className="block text-xs text-muted-foreground">{tr("Применяем с уверенностью от {percent}%.", { percent: Math.round(point.threshold * 100) })}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={pending} onClick={() => void save()}>{pending ? tr("Сохраняем…") : tr("Сохранить настройки")}</Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => void runTest()}>{tr("Проверить связь")}</Button>
            <InfoHint title="Что делает проверка">
              <p>{tr("Агентство задаёт модели один вопрос о тестовой записи и показывает ответ, уверенность и время. Расход — доли цента.")}</p>
              <p>{tr("Проверка идёт по сохранённым настройкам, поэтому сначала сохраните изменения.")}</p>
            </InfoHint>
          </div>
          {test && <p role="status" className="text-xs text-muted-foreground">{test}</p>}
        </div>
      </Panel>
    </div>
  );
}
