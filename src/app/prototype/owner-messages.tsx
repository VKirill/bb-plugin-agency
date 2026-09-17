import { useCallback, useEffect, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import type { OwnerMessageView } from "../../shared/rpc-contract";
import type { AgencyApi } from "../data/agency-api";
import { failureNotice } from "../data/persist";
import { tr, uiLocale } from "../i18n";
import { Button, Empty } from "./shared";

export type OwnerMessagesApi = Pick<AgencyApi, "listOwnerMessages" | "markOwnerMessagesRead">;

function sourceLabel(source: string): string {
  if (source === "owner") return tr("скрипт или команда владельца");
  if (source.startsWith("digest:")) return tr(source === "digest:watchdog" ? "сторож" : "сводка");
  if (source.startsWith("employee")) return tr("сотрудник Агентства");
  return source;
}

/**
 * Messages sent with `bb agency notify-owner` and `bb agency digest`: newest first,
 * unread marked, the job they are about one click away.
 */
export function OwnerMessagesList({ api, openJob, notice, onUnread }: { api: OwnerMessagesApi; openJob: (key: string) => void; notice?: (text: string) => void; onUnread?: (count: number) => void }) {
  const [state, setState] = useState<{ messages: OwnerMessageView[]; unread: number } | null>(null);
  const load = useCallback(async () => {
    const result = await api.listOwnerMessages({ limit: 100 });
    if (result.ok) {
      setState(result.value);
      onUnread?.(result.value.unread);
    } else {
      setState({ messages: [], unread: 0 });
      notice?.(failureNotice(result.failure));
    }
  }, [api, notice, onUnread]);
  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("domain-changed", () => {
    void load();
  });
  const markRead = async (ids?: string[]) => {
    const result = await api.markOwnerMessagesRead(ids ? { ids } : {});
    if (!result.ok) notice?.(failureNotice(result.failure));
    void load();
  };
  if (!state) return <p className="text-xs text-muted-foreground">{tr("Читаем сообщения…")}</p>;
  if (!state.messages.length) {
    return <Empty title="Сообщений нет" description="Сюда пишут скрипты и сторожа через bb agency notify-owner и bb agency digest. Готовые шаблоны: bb agency scripts." />;
  }
  return (
    <div className="space-y-2" data-testid="owner-messages">
      <div className="flex items-center justify-end gap-3">
        <span className="text-xs text-muted-foreground">{tr("Непрочитанных: {count}", { count: state.unread })}</span>
        <Button size="sm" variant="ghost" disabled={!state.unread} onClick={() => void markRead()}>{tr("Прочитать все")}</Button>
      </div>
      <ul className="divide-y divide-border border-y border-border">
        {state.messages.map((message) => (
          <li key={message.id} className="flex items-start gap-3 py-3" data-unread={message.readAt ? undefined : true}>
            <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${message.readAt ? "bg-transparent" : message.level === "warning" ? "bg-amber-500" : "bg-foreground/60"}`} />
            <div className="min-w-0 flex-1">
              <p className={`whitespace-pre-wrap break-words text-sm ${message.level === "warning" ? "text-amber-800 dark:text-amber-300" : ""}`}>{message.text}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {[
                  new Date(message.createdAt).toLocaleString(uiLocale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
                  sourceLabel(message.source),
                  message.telegram === "queued" ? tr("отправлено в Telegram") : message.telegram.startsWith("failed") ? tr("Telegram: не отправлено") : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {message.jobKey && <Button size="sm" variant="ghost" onClick={() => { void markRead([message.id]); openJob(message.jobKey!); }}>{tr("Открыть {key}", { key: message.jobKey })}</Button>}
              {!message.readAt && <Button size="sm" variant="ghost" onClick={() => void markRead([message.id])}>{tr("Прочитано")}</Button>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
