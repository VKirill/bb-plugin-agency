import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { PassportBuildView, PassportPageView, ProjectPassportView, rpcContract } from "../../shared/rpc-contract";
import {
  PASSPORT_DELIVERY_TITLES,
  PASSPORT_SECTIONS,
  passportText,
  type PassportDelivery,
  type PassportSectionKey,
} from "../../shared/passport";
import { Button, HintHeading, InfoHint, TextField } from "./shared";
import { tr, uiLocale } from "../i18n";

/**
 * Паспорт проекта: сводка «что это за проект», которую сотрудник читает перед работой. Собирает
 * её фоновая модель из того, что проект накопил сам, и применяется она сразу — поэтому владельцу
 * здесь нужны три вещи: видеть, что уедет в запуск, поправить текст и вернуть прежнюю редакцию.
 */

type Result<T> = { ok: true; value: T } | { ok: false; error?: { message?: string } };

type Draft = { header: string; sections: Record<string, string>; revision: number };

function toDraft(passport: ProjectPassportView | null): Draft {
  return {
    header: passport?.header ?? "",
    sections: Object.fromEntries(PASSPORT_SECTIONS.map((section) => [section.key, passport?.sections.find((item) => item.key === section.key)?.text ?? ""])),
    revision: passport?.revision ?? 0,
  };
}

const BUILD_REASON: Record<string, string> = {
  disabled: "Писарь паспорта выключен: включите его в «Настройки → Оценщик».",
  no_key: "Ключ модели не найден: проверьте имя переменной в настройках.",
  no_material: "Собирать не из чего: у проекта пока нет ни знаний, ни принятых задач.",
  unchanged: "Материал проекта не менялся с прошлой сборки.",
  same_text: "Модель собрала ту же редакцию: менять нечего.",
  refused: "Привратник отклонил редакцию.",
  timeout: "Модель не ответила вовремя.",
  bad_answer: "Модель ответила не по схеме.",
  request_failed: "Запрос к модели не прошёл.",
};

function buildLine(result: PassportBuildView): string {
  if (result.ok) return tr("Паспорт собран за {ms} мс, редакция {revision}.", { ms: result.ms, revision: result.revision });
  const reason = BUILD_REASON[result.reason] ?? "Собрать не получилось.";
  return `${tr(reason)}${result.detail ? ` ${result.detail}` : ""}`;
}

export function PassportPanel({ bbProjectId, notice }: { bbProjectId: string; notice: (text: string) => void }) {
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
  const [view, setView] = useState<PassportPageView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    const result = await call<PassportPageView>("getProjectPassport", { bbProjectId });
    if (result.ok) setView(result.value);
  }, [call, bbProjectId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Ровно тот текст, который уедет в запуск: правишь форму — видишь промпт. */
  const preview = useMemo(() => {
    if (!draft) return null;
    const sections = PASSPORT_SECTIONS.map((section) => ({ key: section.key as PassportSectionKey, text: draft.sections[section.key] ?? "" })).filter((section) => section.text.trim());
    return passportText({ header: draft.header, sections, bbProjectId }, "full");
  }, [draft, bbProjectId]);

  const build = async () => {
    setPending(true);
    try {
      const result = await call<PassportBuildView>("buildProjectPassport", { bbProjectId });
      if (!result.ok) {
        notice(tr("Не удалось собрать паспорт."));
        return;
      }
      notice(buildLine(result.value));
      await load();
    } finally {
      setPending(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setPending(true);
    try {
      const result = await call<ProjectPassportView>("savePassport", {
        bbProjectId,
        expectedRevision: draft.revision,
        header: draft.header,
        sections: PASSPORT_SECTIONS.map((section) => ({ key: section.key, text: draft.sections[section.key] ?? "" })).filter((section) => section.text.trim()),
      });
      if (!result.ok) {
        notice(tr("Не удалось сохранить паспорт: он изменился с тех пор, как вы его открыли."));
        return;
      }
      setDraft(null);
      await load();
      notice(tr("Паспорт сохранён. Он придёт в следующий запуск задач этого проекта."));
    } finally {
      setPending(false);
    }
  };

  const rollback = async (revision: number) => {
    setPending(true);
    try {
      const result = await call<ProjectPassportView>("rollbackPassport", { bbProjectId, revision });
      if (!result.ok) {
        notice(tr("Не удалось вернуть редакцию."));
        return;
      }
      await load();
      notice(tr("Вернули редакцию {revision}.", { revision }));
    } finally {
      setPending(false);
    }
  };

  if (!view) return <p className="text-sm text-muted-foreground">{tr("Загружаем паспорт проекта…")}</p>;

  const { passport, settings } = view;
  const nextBuild = passport ? passport.acceptedJobs + settings.triggerEveryN : settings.triggerEveryN;

  return (
    <div className="space-y-4" data-testid="project-passport">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <HintHeading
          title="Паспорт проекта"
          hint={<>
            <p>{tr("Сводка «что это за проект»: её сотрудник читает первой и только потом спускается к отдельным записям знаний.")}</p>
            <p>{tr("Собирает её фоновая модель из знаний проекта, профилей работ, целей и принятых результатов. Правила проекта и профили работ она не повторяет.")}</p>
            <p>{tr("Сколько паспорта достанется сотруднику, решает правило работы «Паспорт проекта» — по умолчанию руководитель и проверяющий читают его целиком, исполнитель шапку, помощник — по команде.")}</p>
          </>}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={pending || !settings.enabled} onClick={() => void build()}>{tr("Собрать заново")}</Button>
          {!draft && <Button size="sm" onClick={() => setDraft(toDraft(passport))}>{passport ? tr("Править") : tr("Написать руками")}</Button>}
        </div>
      </div>

      {!settings.enabled && (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {tr("Писарь паспорта выключен. Включите его в «Настройки → Оценщик», и паспорт будет пересобираться сам; до тех пор его можно написать руками.")}
        </p>
      )}
      {settings.enabled && !view.gateEnabled && (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {tr("Привратник паспорта выключен: новая редакция применяется без проверки на секреты и состояние дня. Включается точкой решения «Привратник паспорта» в «Настройки → Оценщик».")}
        </p>
      )}
      {settings.enabled && !view.keyReady && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {tr("Ключ модели не найден: проверьте имя переменной в «Настройки → Оценщик».")}
        </p>
      )}

      {!passport && !draft ? (
        <p className="max-w-prose text-sm text-muted-foreground">
          {tr("Паспорта пока нет. Он появится сам, когда в проекте наберётся материал: знания, профили работ, цели и принятые задачи.")}
        </p>
      ) : null}

      {passport && !draft && (
        <section className="max-w-3xl space-y-3 rounded-lg border border-border bg-muted/20 p-5" aria-label={tr("Паспорт проекта")}>
          <p className="text-sm">{passport.header}</p>
          {passport.sections.map((section) => (
            <div key={section.key}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {tr(PASSPORT_SECTIONS.find((item) => item.key === section.key)?.title ?? section.key)}
              </h3>
              <p className="mt-1 whitespace-pre-wrap text-sm">{section.text}</p>
            </div>
          ))}
          <p className="pt-1 text-xs text-muted-foreground">
            {passport.builtBy === "model"
              ? tr("Редакция {revision}, собрана {date} моделью {model}.", { revision: passport.revision, date: new Date(passport.builtAt).toLocaleString(uiLocale()), model: passport.model ?? "—" })
              : tr("Редакция {revision}, правка владельца {date}.", { revision: passport.revision, date: new Date(passport.builtAt).toLocaleString(uiLocale()) })}
            {settings.enabled ? ` ${tr("Принято задач: {done}; пересборка после {next}.", { done: view.acceptedJobs, next: nextBuild })}` : ""}
          </p>
        </section>
      )}

      {draft && (
        <section className="max-w-3xl space-y-4 rounded-lg border border-border bg-muted/20 p-5" aria-label={tr("Правка паспорта")}>
          <TextField
            label="Шапка"
            value={draft.header}
            onChange={(header) => setDraft({ ...draft, header })}
            multiline
            rows={3}
            hint="Что это и для кого, две-три строки. Эта часть доходит даже до механической работы."
            required
          />
          {PASSPORT_SECTIONS.map((section) => (
            <TextField
              key={section.key}
              label={section.title}
              value={draft.sections[section.key] ?? ""}
              onChange={(text) => setDraft({ ...draft, sections: { ...draft.sections, [section.key]: text } })}
              multiline
              rows={3}
              hint={section.hint}
            />
          ))}
          {preview && (
            <details className="rounded-md border border-border bg-background p-3 text-sm">
              <summary className="cursor-pointer text-sm font-medium">{tr("Что увидит сотрудник")}</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-xs text-muted-foreground">{preview}</pre>
            </details>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={pending || !draft.header.trim()} onClick={() => void save()}>{tr("Сохранить паспорт")}</Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>{tr("Отмена")}</Button>
          </div>
        </section>
      )}

      {view.previews.length > 0 && !draft && (
        <details className="max-w-3xl rounded-md border border-border bg-background p-3 text-sm">
          <summary className="cursor-pointer text-sm font-medium">{tr("Что уедет в запуск")}</summary>
          <div className="mt-2 space-y-3">
            {view.previews.map((row) => (
              <div key={row.mode}>
                <p className="text-xs font-semibold">
                  {tr(PASSPORT_DELIVERY_TITLES[row.mode as PassportDelivery]?.title ?? row.mode)}
                  <span className="ml-2 font-normal text-muted-foreground">{tr(PASSPORT_DELIVERY_TITLES[row.mode as PassportDelivery]?.hint ?? "")}</span>
                </p>
                <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-xs text-muted-foreground">{row.text}</pre>
              </div>
            ))}
          </div>
        </details>
      )}

      {view.versions.length > 1 && (
        <details className="max-w-3xl rounded-md border border-border bg-background p-3 text-sm">
          <summary className="cursor-pointer text-sm font-medium">{tr("История редакций")}</summary>
          <ul className="mt-2 space-y-2">
            {view.versions.map((version) => (
              <li key={version.id} className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {tr("Редакция {revision}", { revision: version.revision })} · {new Date(version.builtAt).toLocaleString(uiLocale())} · {version.note}
                </span>
                {passport && version.revision !== passport.revision && (
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={pending} onClick={() => void rollback(version.revision)}>{tr("Вернуть")}</Button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        {tr("Паспорт живёт у BB-проекта: у проекта на двух машинах он один.")}
        <InfoHint title="Чем паспорт отличается от знаний и правил">
          <p>{tr("Правила проекта (.bb/AGENTS.md) говорят, как обращаться с папкой; профиль работы — как делают такой вид результата.")}</p>
          <p>{tr("Знания — то, что мы выяснили по отдельным поводам. Факты отдельного раздела пишутся в знания раздела. Паспорт — сводка о самом проекте, и он не повторяет ни то, ни другое.")}</p>
        </InfoHint>
      </p>
    </div>
  );
}
