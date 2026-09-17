import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import type { StarterKitViewRecord, rpcContract } from "../../shared/rpc-contract";
import type { AgencyApi } from "../data/agency-api";
import { failureNotice } from "../data/persist";
import { createRpcAgencyApi, type RpcCaller } from "../data/rpc-agency-api";
import { tr, uiLanguage } from "../i18n";
import { useConfirm } from "./confirm-dialog";
import { ROLE_TYPE_LABELS } from "./data";
import { Button, Panel } from "./shared";

function useAgencyApi(): AgencyApi {
  const rpc = useRpc<typeof rpcContract>();
  return useMemo(() => createRpcAgencyApi(rpc as unknown as RpcCaller), [rpc]);
}

/**
 * Starter departments with their employees, in the interface language. Nothing is
 * installed by default: the owner picks departments here or builds their own.
 */
export function StarterKitDialog({ open, onOpenChange, notice, onChanged }: { open: boolean; onOpenChange: (open: boolean) => void; notice: (text: string) => void; onChanged?: () => void }) {
  const api = useAgencyApi();
  const [view, setView] = useState<StarterKitViewRecord | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  // The notice callback is not a reason to reload: a new function each render would drop every answer.
  const noticeRef = useRef(notice);
  noticeRef.current = notice;
  useEffect(() => {
    if (!open) return;
    let live = true;
    setView(null);
    setChosen([]);
    void api.starterKit({ language: uiLanguage() }).then((result) => {
      if (!live) return;
      if (result.ok) setView(result.value);
      else noticeRef.current(failureNotice(result.failure));
    });
    return () => {
      live = false;
    };
  }, [api, open]);
  const install = async () => {
    if (!chosen.length || pending) return;
    setPending(true);
    const result = await api.installStarterKit({ keys: chosen, language: uiLanguage() });
    setPending(false);
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    const added = result.value.installed.length;
    const skipped = result.value.skipped.map((row) => `${view?.departments.find((item) => item.key === row.key)?.name ?? row.key}: ${row.reason}`);
    notice([tr("Добавлено отделов: {count}. Сотрудники созданы с моделями по умолчанию из «Правил работы».", { count: added }), ...skipped].join(" "));
    onChanged?.();
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("Стартовые отделы")}</DialogTitle>
          <DialogDescription>
            {tr("Готовые отделы с руководителем, исполнителями и проверяющими, регламентом и должностными инструкциями. Отметьте нужные — или закройте окно и создайте свой отдел. Всё добавленное можно менять, отправлять в архив и удалять.")}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60dvh] space-y-2 overflow-y-auto pr-1" data-testid="starter-kit">
          {!view && <p className="text-sm text-muted-foreground">{tr("Читаем стартовый набор…")}</p>}
          {view?.departments.map((department) => {
            const installed = Boolean(department.installed);
            const checked = chosen.includes(department.key);
            return (
              <label key={department.key} className={`flex items-start gap-3 rounded-lg border border-border p-3 ${installed ? "opacity-70" : "cursor-pointer hover:bg-muted/40"}`}>
                <Checkbox
                  className="mt-0.5"
                  aria-label={department.name}
                  disabled={installed}
                  checked={installed || checked}
                  onCheckedChange={(value) => setChosen(value ? [...chosen, department.key] : chosen.filter((key) => key !== department.key))}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    {department.name}
                    {installed && <span className="ml-2 text-xs font-normal text-muted-foreground">{tr("уже есть")}</span>}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{department.purpose}</span>
                  <span className="mt-1.5 block text-xs text-muted-foreground">
                    {department.agents.map((agent) => `${agent.name} · ${tr(ROLE_TYPE_LABELS[agent.roleType]).toLowerCase()}`).join("; ")}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>{tr("Закрыть")}</Button>
          <Button disabled={!chosen.length || pending} onClick={() => void install()}>
            {pending ? tr("Добавляем…") : tr("Добавить отмеченные · {count}", { count: chosen.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Offers to switch starter departments and employees to the interface language. */
export function StarterKitTranslateCard({ notice }: { notice: (text: string) => void }) {
  const api = useAgencyApi();
  const [view, setView] = useState<StarterKitViewRecord | null>(null);
  const [pending, setPending] = useState(false);
  const load = useCallback(() => {
    void api.starterKit({ language: uiLanguage() }).then((result) => {
      if (result.ok) setView(result.value);
    });
  }, [api]);
  useEffect(() => load(), [load]);
  if (!view || (!view.translatable && !view.edited)) return null;
  const translate = async () => {
    setPending(true);
    const result = await api.translateStarterKit({ language: uiLanguage() });
    setPending(false);
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    const edited = result.value.edited.map((row) => row.name);
    notice(
      [
        tr("Переведено отделов и сотрудников: {count}.", { count: result.value.translated }),
        ...(edited.length ? [tr("Вы меняли их тексты, они остались как есть: {names}.", { names: edited.join(", ") })] : []),
      ].join(" "),
    );
    load();
  };
  return (
    <Panel title="Стартовые отделы на языке Агентства">
      <p className="text-sm text-muted-foreground">
        {view.translatable
          ? tr("Отделов и сотрудников из стартового набора на другом языке: {count}. Их названия, регламенты и должностные инструкции можно перевести; каждая правка — новая версия, история остаётся.", { count: view.translatable })
          : tr("Все стартовые отделы и сотрудники уже на этом языке.")}
        {view.edited > 0 && ` ${tr("Изменённые вами тексты не переводятся: {count}.", { count: view.edited })}`}
      </p>
      {view.translatable > 0 && (
        <Button className="mt-3" size="sm" disabled={pending} onClick={() => void translate()}>
          {pending ? tr("Переводим…") : tr("Перевести стартовые отделы и сотрудников")}
        </Button>
      )}
    </Panel>
  );
}

/**
 * Archive and delete for a department or an employee. Archive keeps history and takes
 * the record out of new work; delete is offered only when there is no history at all.
 */
export function RecordLifecyclePanel({
  kind,
  id,
  name,
  archived,
  notice,
  onArchive,
  onRestore,
  onDeleted,
}: {
  kind: "department" | "agent";
  id: string;
  name: string;
  archived: boolean;
  notice: (text: string) => void;
  onArchive: () => Promise<boolean>;
  onRestore: () => Promise<boolean>;
  onDeleted: () => void;
}) {
  const api = useAgencyApi();
  const { dialog, ask } = useConfirm();
  const [state, setState] = useState<{ deletable: boolean; reason: string | null } | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let live = true;
    void api.recordLifecycle({ kind, id }).then((result) => {
      if (live && result.ok) setState({ deletable: result.value.deletable, reason: result.value.reason });
    });
    return () => {
      live = false;
    };
  }, [api, kind, id, archived]);
  const department = kind === "department";
  const archive = async () => {
    const yes = await ask({
      title: tr(department ? "Отправить отдел в архив?" : "Отправить сотрудника в архив?"),
      description: tr(
        department
          ? "«{name}» уйдёт из маршрута в чатах, форм и списков выбора. Задачи и история останутся, вернуть отдел можно в любой момент."
          : "«{name}» нельзя будет назначить и запустить. Задачи и история останутся, вернуть сотрудника можно в любой момент.",
        { name },
      ),
      confirmLabel: tr("В архив"),
    });
    if (!yes) return;
    setPending(true);
    await onArchive();
    setPending(false);
  };
  const remove = async () => {
    const yes = await ask({
      title: tr(department ? "Удалить отдел?" : "Удалить сотрудника?"),
      description: tr(
        department
          ? "«{name}» удаляется вместе с регламентом и составом. Сотрудники остаются. Отменить удаление нельзя."
          : "«{name}» удаляется вместе с версиями профиля. Отменить удаление нельзя.",
        { name },
      ),
      confirmLabel: tr("Удалить"),
    });
    if (!yes) return;
    setPending(true);
    const result = department ? await api.deleteDepartment({ departmentId: id }) : await api.deleteAgent({ agentId: id });
    setPending(false);
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    notice(tr(department ? "Отдел «{name}» удалён." : "Сотрудник «{name}» удалён.", { name }));
    onDeleted();
  };
  return (
    <Panel title="Архив и удаление">
      <p className="text-sm text-muted-foreground">
        {archived
          ? tr(department ? "Отдел в архиве: в маршрут, формы и списки выбора не попадает." : "Сотрудник в архиве: его нельзя назначить и запустить.")
          : tr(department ? "Не нужен отдел — отправьте его в архив: история останется. Удалить можно только отдел, у которого не было задач." : "Не нужен сотрудник — отправьте его в архив: история останется. Удалить можно только сотрудника, который ещё не работал.")}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {archived ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void (async () => { setPending(true); await onRestore(); setPending(false); })()}>
            {tr("Вернуть из архива")}
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void archive()}>{tr("Отправить в архив")}</Button>
        )}
        <Button size="sm" variant="outline" className="text-destructive" disabled={pending || !state?.deletable} onClick={() => void remove()}>
          {tr("Удалить")}
        </Button>
        {state && !state.deletable && state.reason && <span className="text-xs text-muted-foreground">{state.reason}</span>}
      </div>
      {dialog}
    </Panel>
  );
}
