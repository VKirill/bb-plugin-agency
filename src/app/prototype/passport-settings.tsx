import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Switch } from "../../../components/ui/switch";
import type { PassportSettingsPageView, rpcContract } from "../../shared/rpc-contract";
import { tr } from "../i18n";
import { Button, Choice, Field, Panel, TextField } from "./shared";

/**
 * Писарь паспорта: дешёвая модель, которая сводит накопленное проектом в короткий паспорт. Она
 * работает в фоне и не занимает ни руководителя, ни запуск. Ключ здесь не хранится — только имя
 * переменной, как у оценщика; список имён владелец видит на той же странице.
 */

type Result<T> = { ok: true; value: T } | { ok: false; error?: { message?: string } };

type Draft = {
  enabled: boolean;
  model: string;
  keySource: PassportSettingsPageView["settings"]["keySource"];
  keyName: string;
  triggerEveryN: number;
  baseUrl: string;
};

const KEY_PROBLEM: Record<string, string> = {
  no_catalog: "Плагин Env Catalog не отвечает: выберите ключ из окружения машины или включите плагин.",
  not_found: "Переменной с таким именем нет: выберите другую или задайте ключ в настройках оценщика.",
  empty_name: "Укажите, в какой переменной лежит ключ.",
};

export function PassportSettingsPanel({ notice }: { notice: (text: string) => void }) {
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
  const [view, setView] = useState<PassportSettingsPageView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    const result = await call<PassportSettingsPageView>("getPassportSettings");
    if (!result.ok) return;
    setView(result.value);
    const { settings } = result.value;
    setDraft({
      enabled: settings.enabled,
      model: settings.model,
      keySource: settings.keySource,
      keyName: settings.keyName,
      triggerEveryN: settings.triggerEveryN,
      baseUrl: settings.baseUrl,
    });
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!view || !draft || pending) return;
    setPending(true);
    const result = await call<unknown>("savePassportSettings", { ...draft, expectedRevision: view.settings.revision });
    setPending(false);
    if (!result.ok) {
      notice(result.error?.message ?? tr("Не удалось сохранить настройки паспорта."));
      return;
    }
    notice(tr("Настройки паспорта сохранены."));
    void load();
  };

  if (!view || !draft) return null;

  return (
    <div className="space-y-4" data-testid="passport-settings">
      <Panel
        title="Писарь паспорта"
        info={
          <>
            <p>{tr("Паспорт проекта — сводка «что это за проект», которую сотрудник читает перед работой.")}</p>
            <p>{tr("Собирает её дешёвая модель из знаний проекта, профилей работ, целей и принятых результатов — в фоне, не занимая ни руководителя, ни запуск.")}</p>
            <p>{tr("Редакция применяется сразу; прежняя остаётся в истории паспорта, и её можно вернуть одной кнопкой на странице проекта.")}</p>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">{tr("Вести паспорта проектов")}</span>
            <Switch aria-label={tr("Вести паспорта проектов")} checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Модель паспорта"
              value={draft.model}
              onChange={(model) => setDraft({ ...draft, model })}
              placeholder="deepseek/deepseek-v4.1-flash"
              maxLength={120}
              hint="Обычная модель через OpenRouter: паспорт пишется словами, а не решениями."
            />
            <TextField
              label="Пересобирать через, задач"
              type="number"
              value={String(draft.triggerEveryN)}
              onChange={(value) => setDraft({ ...draft, triggerEveryN: Math.max(1, Math.min(200, Number(value) || 1)) })}
              hint="Сколько задач проекта должно быть принято, чтобы паспорт пересобрался сам."
            />
          </div>

          <TextField
            label="Адрес"
            value={draft.baseUrl}
            onChange={(baseUrl) => setDraft({ ...draft, baseUrl })}
            placeholder="https://openrouter.ai/api/v1"
            maxLength={300}
            hint="Пусто — OpenRouter. Свой шлюз или локальная модель с чат-совместимым адресом подойдут так же."
          />

          <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            {tr("Что уходит в модель: знания проекта, профили работ, цели, брифы принятых задач и правила проекта (.bb/AGENTS.md). Это внешний сервис — для закрытого проекта укажите свой адрес или не включайте писаря.")}
          </p>

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
            <TextField label="Переменная с ключом" value={draft.keyName} onChange={(keyName) => setDraft({ ...draft, keyName })} placeholder="OPENROUTER_API_KEY" maxLength={120} />
          </div>

          {draft.enabled && !view.gateEnabled && (
            <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              {tr("Привратник паспорта выключен: редакция применяется без проверки на секреты. Включите точку решения «Привратник паспорта» у оценщика выше.")}
            </p>
          )}
          {draft.enabled && view.keyProblem && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              {tr(KEY_PROBLEM[view.keyProblem] ?? "Ключ не найден.")}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={pending} onClick={() => void save()}>{tr("Сохранить настройки")}</Button>
            <span className="text-xs text-muted-foreground">{tr("Сам паспорт живёт на странице проекта, вкладка «Паспорт».")}</span>
          </div>
        </div>
      </Panel>
    </div>
  );
}
