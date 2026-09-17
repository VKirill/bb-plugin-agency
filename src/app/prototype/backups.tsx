import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { BackupFileView, rpcContract } from "../../shared/rpc-contract";
import { failureNotice } from "../data/persist";
import { createRpcAgencyApi, type RpcCaller } from "../data/rpc-agency-api";
import { tr, uiLocale } from "../i18n";
import { useConfirm } from "./confirm-dialog";
import { Button, InfoHint, Panel } from "./shared";

function size(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Backups of the Agency database: create a consistent copy and restore one.
 * Restore replaces all Agency data with the copy, after saving the current state.
 */
export function BackupsPanel({ notice }: { notice: (text: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const api = useMemo(() => createRpcAgencyApi(rpc as unknown as RpcCaller), [rpc]);
  const confirm = useConfirm();
  const [files, setFiles] = useState<BackupFileView[] | null>(null);
  const [pending, setPending] = useState(false);
  const load = useCallback(async () => {
    const result = await api.listBackups();
    if (result.ok) setFiles(result.value);
    else notice(failureNotice(result.failure));
  }, [api, notice]);
  useEffect(() => {
    void load();
  }, [load]);
  const create = async () => {
    setPending(true);
    const result = await api.createBackup();
    setPending(false);
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    notice(tr("Копия сохранена: {name}.", { name: result.value.name }));
    void load();
  };
  const restore = async (file: BackupFileView) => {
    const agreed = await confirm.ask({
      title: tr("Восстановить копию?"),
      description: tr("Все данные Агентства — задачи, отделы, сотрудники, правила, история — заменятся копией от {date}. Текущее состояние сначала сохранится отдельной копией. Идущие запуски не останавливаются: проверьте их после восстановления.", { date: new Date(file.createdAt).toLocaleString(uiLocale()) }),
      confirmLabel: tr("Восстановить"),
    });
    if (!agreed) return;
    setPending(true);
    const result = await api.restoreBackup({ name: file.name });
    setPending(false);
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    notice(tr("Копия восстановлена. Прежнее состояние сохранено: {name}.", { name: result.value.safetyBackup.name }));
    void load();
  };
  return (
    <Panel
      title="Резервные копии"
      info={
        <>
          <p>{tr("Копия базы Агентства: задачи, история, отделы, сотрудники, правила, знания, автоматизации. Снимок согласованный — делается на лету, без остановки работы.")}</p>
          <p>{tr("Секреты внешних адресов и закрепление навыков хранятся отдельно и в копию не входят.")}</p>
        </>
      }
    >
      {confirm.dialog}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={pending} onClick={() => void create()}>{pending ? tr("Выполняем…") : tr("Создать копию")}</Button>
          <InfoHint title="Восстановление">
            <p>{tr("Восстановление заменяет все данные Агентства данными копии. Перед этим текущее состояние сохраняется отдельной копией, так что шаг можно отменить, восстановив её.")}</p>
          </InfoHint>
        </div>
        {files === null ? (
          <p className="text-sm text-muted-foreground">{tr("Читаем список копий…")}</p>
        ) : files.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tr("Копий пока нет.")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {files.map((file) => (
              <li key={file.name} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate font-mono text-xs">{file.name}</span>
                  <span className="text-xs text-muted-foreground">{`${new Date(file.createdAt).toLocaleString(uiLocale())} · ${size(file.size)}`}</span>
                </span>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => void restore(file)}>{tr("Восстановить")}</Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
