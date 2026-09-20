import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../shared/rpc-contract";
import type { SessionPolicyMode, SessionPolicyView } from "../../shared/contracts/session-policy";
import { tr } from "../i18n";
import { effectiveModeLabel, SESSION_MODE_OPTIONS, userSessionChoice } from "../session-mode-copy";
import { Choice, HintHeading } from "./shared";

function newRequestId(): string {
  return crypto.randomUUID();
}

/** Chat mode for this BB project and, when the folder is the only connection, for this folder. */
export function SessionPolicyCard({
  bbProjectId,
  bindingId,
  archived,
  notice,
}: {
  bbProjectId?: string;
  bindingId: string;
  archived: boolean;
  notice: (text: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<SessionPolicyView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(() => {
    void rpc
      .call("getSessionPolicy", { bbProjectId, bindingId })
      .then((result) => {
        if (result.ok) {
          setView(result.value);
          setError("");
        } else setError(result.error.message);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [rpc, bbProjectId, bindingId]);
  useEffect(() => {
    load();
  }, [load]);
  useRealtime("domain-changed", load);
  const save = async (scope: "project" | "binding", scopeId: string, mode: SessionPolicyMode) => {
    setBusy(scope);
    try {
      const result = await rpc.call("saveSessionPolicy", { requestId: newRequestId(), scope, scopeId, mode });
      if (!result.ok) {
        notice(result.error.message);
        return;
      }
      notice(tr("Режим чатов сохранён. Новые ходы в уже открытом чате подхватят его после смены режима в поле ввода или в новом чате."));
      load();
    } catch (cause) {
      notice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  };
  if (!bbProjectId) {
    return (
      <section aria-label={tr("Чаты проекта")} className="space-y-2">
        <HintHeading title="Чаты проекта" hint={<p>{tr("Режим чатов хранится у BB-проекта. У этого подключения нет идентификатора проекта.")}</p>} />
        <p className="text-sm text-muted-foreground">{tr("У подключения нет BB-проекта: режим чатов задать нельзя.")}</p>
      </section>
    );
  }
  const uniqueFolder = Boolean(view?.bindingId && view.bindingId === bindingId);
  return (
    <section aria-label={tr("Чаты проекта")} className="space-y-3">
      <HintHeading
        title="Чаты проекта"
        hint={
          <>
            <p>{tr("Обычный чат в этом BB-проекте получает роль из этой настройки, а не только общую инструкцию Агентства.")}</p>
            <p>{tr("«Агентство» — чат ведёт себя как менеджер: сам не делает код и исследование, ставит задачу руководителю отдела.")}</p>
            <p>{tr("«По запросу» — спрашивает: сделать здесь или завести поручение. «Сам сделает» — инструкций Агентства нет, модель про отделы не знает.")}</p>
            <p>{tr("Один чат можно сменить списком в поле ввода, слева от MoA. Мелочи и вопросы менеджер по-прежнему отвечает здесь.")}</p>
          </>
        }
      />
      {error ? <p role="alert" className="text-sm text-muted-foreground">{error}</p> : null}
      {view ? (
        <p className="text-sm text-muted-foreground">
          {tr("Сейчас в чатах действует: {mode}.", { mode: tr(effectiveModeLabel(view.effective)) })}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{tr("Загружаем режим чатов…")}</p>
      )}
      <Choice
        label="Для всего BB-проекта"
        value={userSessionChoice(view?.layers.project ?? "inherit")}
        disabled={archived || busy !== "" || !view}
        onChange={(mode) => void save("project", bbProjectId, mode as SessionPolicyMode)}
        options={SESSION_MODE_OPTIONS}
      />
      {uniqueFolder ? (
        <Choice
          label="Только эта папка"
          value={userSessionChoice(view?.layers.binding ?? "inherit")}
          disabled={archived || busy !== "" || !view}
          onChange={(mode) => void save("binding", bindingId, mode as SessionPolicyMode)}
          options={SESSION_MODE_OPTIONS}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          {tr("Эта папка — одна из нескольких копий проекта. Режим папки задаётся, когда подключена только она. Для раздела заведите отдельное подключение.")}
        </p>
      )}
    </section>
  );
}
