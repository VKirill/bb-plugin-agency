import { Tr } from "../i18n/tr";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Markdown, useRpc } from "@get-bb/plugin-sdk/app";
import type { AgencyRulesView, TemplateView, rpcContract } from "../../shared/rpc-contract";
import type { TemplateKey } from "../../shared/templates";
import { failureNotice } from "../data/persist";
import { tr, uiLocale } from "../i18n";
import { createRpcAgencyApi, type RpcCaller } from "../data/rpc-agency-api";
import { Button, InfoHint, Panel, TextField } from "./shared";
import { useReloadTemplates } from "./use-templates";

const TEMPLATE_META: Record<TemplateKey, { title: string; hint: ReactNode }> = {
  charter: {
    title: "Регламент отдела",
    hint: <><p><Tr text={"Подставляется в форму «Создать отдел» и кнопку «Вставить шаблон регламента»."}/></p><p><Tr text={"Раздел «## Принимаем» обязателен: по нему агенты в чатах выбирают отдел."}/></p></>,
  },
  jobDescriptionLead: {
    title: "Должностная инструкция руководителя",
    hint: <p><Tr text={"Стартовый текст инструкции для сотрудника с типом роли «Руководитель»."}/></p>,
  },
  jobDescriptionExecutor: {
    title: "Должностная инструкция исполнителя",
    hint: <p><Tr text={"Стартовый текст для «Исполнителя»: пул работ, что не входит в него, входы, результат, самопроверка."}/></p>,
  },
  jobDescriptionReviewer: {
    title: "Должностная инструкция проверяющего",
    hint: <p><Tr text={"Стартовый текст для «Проверяющего»: как проверять и чего не делать."}/></p>,
  },
  brief: {
    title: "Бриф задачи",
    hint: <p><Tr text={"Подсказка и кнопка «Вставить шаблон» в поле «Что нужно сделать» у новой задачи и подзадачи."}/></p>,
  },
  acceptance: {
    title: "Критерии приёмки",
    hint: <p><Tr text={"Подсказка и кнопка «Вставить шаблон» в поле «Критерии приёмки»."}/></p>,
  },
};

function useApi() {
  const rpc = useRpc<typeof rpcContract>();
  return useMemo(() => createRpcAgencyApi(rpc as unknown as RpcCaller), [rpc]);
}

/**
 * Starting texts of the forms. Saving changes only what new records start
 * with; departments and employees that already exist keep their texts.
 */
export function TemplatesPanel({ notice }: { notice: (text: string) => void }) {
  const api = useApi();
  const reloadTemplates = useReloadTemplates();
  const [rows, setRows] = useState<TemplateView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api.listTemplates().then((result) => {
      if (!live) return;
      if (result.ok) setRows(result.value);
      else setError(failureNotice(result.failure));
    });
    return () => {
      live = false;
    };
  }, [api]);
  if (error) return <p className="text-sm text-muted-foreground">{error}</p>;
  if (!rows) return <p className="text-sm text-muted-foreground">{tr("Загружаем шаблоны…")}</p>;
  const replace = (next: TemplateView) => {
    setRows((current) => current?.map((row) => (row.key === next.key ? next : row)) ?? null);
    reloadTemplates();
  };
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{tr("С чего начинаются формы. Изменение шаблона не трогает уже созданные отделы, сотрудников и задачи.")}</p>
      {rows.map((row) => (
        <TemplateEditor key={row.key} row={row} notice={notice} onSaved={replace} save={(input) => api.saveTemplate(input)} />
      ))}
    </div>
  );
}

function TemplateEditor({
  row,
  notice,
  onSaved,
  save,
}: {
  row: TemplateView;
  notice: (text: string) => void;
  onSaved: (next: TemplateView) => void;
  save: (input: { key: TemplateKey; expectedRevision: number; text: string | null }) => ReturnType<ReturnType<typeof createRpcAgencyApi>["saveTemplate"]>;
}) {
  const [draft, setDraft] = useState(row.text);
  const [pending, setPending] = useState(false);
  useEffect(() => setDraft(row.text), [row.text, row.revision]);
  const meta = TEMPLATE_META[row.key];
  const dirty = draft.trim() !== row.text.trim();
  const run = async (text: string | null) => {
    setPending(true);
    const result = await save({ key: row.key, expectedRevision: row.revision, text });
    setPending(false);
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    onSaved(result.value);
    setDraft(result.value.text);
    notice(text === null ? tr("Шаблон «{title}» возвращён к стандартному.", { title: tr(meta.title) }) : tr("Шаблон «{title}» сохранён.", { title: tr(meta.title) }));
  };
  return (
    <details className="rounded-lg border border-border px-3 py-2">
      <summary className="flex cursor-pointer items-center justify-between gap-3 text-sm">
        <span className="flex items-center gap-1 font-medium">
          {tr(meta.title)}
          <InfoHint title={meta.title}>{meta.hint}</InfoHint>
        </span>
        <span className="text-xs text-muted-foreground">{row.custom ? tr("свой текст") : tr("стандартный")}</span>
      </summary>
      <div className="mt-3 space-y-2">
        <TextField label={meta.title} multiline rows={12} value={draft} onChange={setDraft} maxLength={40_000} />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!dirty || pending || !draft.trim()} onClick={() => void run(draft)}>
            {pending ? tr("Сохраняем…") : tr("Сохранить шаблон")}
          </Button>
          {row.custom && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => void run(null)}>
              {tr("Вернуть стандартный")}
            </Button>
          )}
          {dirty && <span className="text-xs text-amber-700 dark:text-amber-400">{tr("Есть несохранённые изменения.")}</span>}
        </div>
      </div>
    </details>
  );
}

/**
 * Agency-wide rules: the top prompt layer of every launch. Each save is a new
 * version; a launch works by the version it was prepared with.
 */
export function AgencyRulesPanel({ notice }: { notice: (text: string) => void }) {
  const api = useApi();
  const [view, setView] = useState<AgencyRulesView | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api.getAgencyRules().then((result) => {
      if (!live) return;
      if (!result.ok) {
        setError(failureNotice(result.failure));
        return;
      }
      setView(result.value);
      setDraft(result.value.current?.text ?? "");
    });
    return () => {
      live = false;
    };
  }, [api]);
  if (error) return <p className="text-sm text-muted-foreground">{error}</p>;
  if (!view) return <p className="text-sm text-muted-foreground">{tr("Загружаем общие правила…")}</p>;
  const dirty = draft.trim() !== (view.current?.text ?? "");
  const save = async () => {
    setPending(true);
    const result = await api.saveAgencyRules({ expectedVersion: view.latestVersion, text: draft });
    setPending(false);
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    setView(result.value);
    setDraft(result.value.current?.text ?? "");
    notice(result.value.current ? tr("Общие правила сохранены: версия {version}.", { version: result.value.current.version }) : tr("Общие правила выключены."));
  };
  return (
    <div className="space-y-4">
      <Panel
        title="Общие правила Агентства"
        info={
          <>
            <p>{tr("Верхний слой промпта каждого запуска: действует для всех отделов и сотрудников, регламенты и инструкции его не отменяют.")}</p>
            <p>{tr("Каждое сохранение — новая версия. Подготовленный, но ещё не начатый запуск по старой версии сервер отклонит — подготовьте его заново.")}</p>
          </>
        }
      >
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {view.current ? tr("Действует версия {version} от {date}.", { version: view.current.version, date: new Date(view.current.createdAt).toLocaleString(uiLocale()) }) : tr("Общих правил нет: сотрудники работают по регламенту отдела и своей инструкции.")}
          </p>
          <TextField
            label="Текст правил"
            multiline
            rows={10}
            value={draft}
            onChange={setDraft}
            maxLength={12_000}
            placeholder={"Например:\n- Отчёты и комментарии — по-русски, без воды.\n- Секреты и токены не печатать в комментариях и отчётах.\n- Внешние сервисы менять только по прямому разрешению владельца."}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={!dirty || pending} onClick={() => void save()}>
              {pending ? tr("Сохраняем…") : draft.trim() ? tr("Сохранить новую версию") : tr("Выключить общие правила")}
            </Button>
            {dirty && <span className="text-xs text-amber-700 dark:text-amber-400">{tr("Есть несохранённые изменения.")}</span>}
          </div>
        </div>
      </Panel>
      {view.versions.length > 0 && (
        <Panel title="История версий">
          <ul className="divide-y divide-border rounded-lg border border-border">
            {view.versions.map((version) => (
              <li key={version.id} className="px-3 py-2">
                <details>
                  <summary className="flex cursor-pointer items-center justify-between gap-3 text-sm">
                    <span>{version.id === view.current?.id ? tr("Версия {version} · действует", { version: version.version }) : tr("Версия {version}", { version: version.version })}</span>
                    <span className="text-xs text-muted-foreground">{new Date(version.createdAt).toLocaleString(uiLocale())}</span>
                  </summary>
                  <div className="mt-2 text-sm">{version.text ? <Markdown content={version.text} /> : <p className="text-muted-foreground">{tr("Пустая версия: правила выключены.")}</p>}</div>
                </details>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
