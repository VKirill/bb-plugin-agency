import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { SkillPinStatusView, rpcContract } from "../../shared/rpc-contract";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Button, InfoHint } from "./shared";
import { tr } from "../i18n";

const short = (hash: string | null) => (hash ? `${hash.slice(0, 8)}…` : "—");

type Envelope = { ok: true; value: SkillPinStatusView } | { ok: false; error: { code: string; message: string } };

/**
 * Agency skill versions: what launches check against and what the catalog has
 * now. After a skill update the owner pins the current package with a button.
 */
export function SkillPinsPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<SkillPinStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const load = useCallback(async () => {
    try {
      const result = (await rpc.call("getSkillPins", null)) as Envelope;
      if (result.ok) {
        setStatus(result.value);
        setError(null);
      } else setError(result.error.message);
    } catch {
      setError(tr("Не удалось прочитать версии навыков."));
    }
  }, [rpc]);
  useEffect(() => {
    void load();
  }, [load]);
  const pin = async () => {
    setPending(true);
    try {
      const result = (await rpc.call("pinSkills", null)) as Envelope;
      if (result.ok) {
        setStatus(result.value);
        setError(null);
      } else setError(result.error.message);
    } catch {
      setError(tr("Не удалось закрепить версии навыков."));
    } finally {
      setPending(false);
      setConfirm(false);
    }
  };
  return (
    <section className="overflow-hidden rounded-lg border border-border" aria-label={tr("Навыки Агентства")}>
      <header className="flex flex-wrap items-center justify-between gap-2 bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-1">
          <h3 className="text-sm font-medium">{tr("Навыки Агентства")}</h3>
          <InfoHint title="Навыки Агентства">
            <p>{tr("Запуск проверяет, что навыки сотрудника в каталоге BB — ровно та версия, что закреплена. Так агент не получит изменённый навык незаметно.")}</p>
            <p>{tr("После обновления навыка версии расходятся и запуски останавливаются с причиной. Проверьте изменения и закрепите текущую версию.")}</p>
          </InfoHint>
        </div>
        {status && (
          <span className={`text-xs ${status.inSync ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400"}`}>
            {tr(status.origin === "none" ? "закрепление не настроено" : status.inSync ? "версии совпадают" : "есть новые версии")}
          </span>
        )}
      </header>
      {error && <p role="alert" className="px-4 py-2 text-xs text-destructive">{error}</p>}
      {!status && !error && <p className="px-4 py-3 text-xs text-muted-foreground">{tr("Читаем каталог навыков…")}</p>}
      {status?.note && <p className="px-4 py-2 text-xs text-muted-foreground">{status.note}</p>}
      {status?.rows.map((row) => {
        const same = row.currentHash === row.pinnedHash;
        return (
          <div key={row.id} className="grid gap-1 border-t border-border px-4 py-2.5 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="min-w-0">
              <span className="font-medium">{row.name ?? row.id.slice(0, 18)}</span>
              <span className="ml-2 text-xs text-muted-foreground">{tr(row.role === "core" ? "основной" : "вспомогательный")} · {row.source}</span>
              {row.problem && <p className="text-xs text-muted-foreground">{row.problem}</p>}
            </div>
            <span className={`font-mono text-xs ${same ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400"}`}>
              {same ? tr("закреплён {hash}", { hash: short(row.pinnedHash) }) : tr("закреплён {pinned} → в каталоге {current}", { pinned: short(row.pinnedHash), current: short(row.currentHash) })}
            </span>
          </div>
        );
      })}
      {status && status.origin !== "none" && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
          <Button size="sm" disabled={pending || status.inSync || !status.editable || status.rows.some((row) => !row.currentHash)} onClick={() => setConfirm(true)}>
            {tr("Закрепить текущие версии")}
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => void load()}>{tr("Проверить снова")}</Button>
        </div>
      )}
      <Dialog open={confirm} onOpenChange={(open) => { if (!pending) setConfirm(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tr("Закрепить текущие версии навыков?")}</DialogTitle>
            <DialogDescription>{tr("Новые запуски будут проверять навыки по версиям из каталога BB. Прежняя конфигурация сохранится резервной копией рядом с файлом.")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setConfirm(false)}>{tr("Отмена")}</Button>
            <Button disabled={pending} onClick={() => void pin()}>{tr(pending ? "Закрепляем…" : "Закрепить")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
