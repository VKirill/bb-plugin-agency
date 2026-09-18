import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, SkillGrantView } from "../../shared/rpc-contract";
import { tr, uiLocale } from "../i18n";
import { Button, HintHeading, SearchInput } from "./shared";
import { CapabilityChecks } from "./capability-checks";
import { mergeCapabilityChoices } from "../data/capability-catalog";

/**
 * Библиотека навыков отдела: что отдел вправе поднять под задание, даже если этого нет в профиле
 * сотрудника. Оценщик открывает отсюда только подходящее по ТЗ и на один запуск, а журнал ниже
 * показывает, кому и что открыли. Так права остаются решением человека, а выбор — быстрым.
 */

type Result<T> = { ok: true; value: T } | { ok: false; error?: { message?: string } };
type PoolView = { departmentId: string; skillIds: string[]; grants: SkillGrantView[] };

const DECIDER: Record<SkillGrantView["decidedBy"], string> = {
  "decision-model": "Оценщик",
  lead: "Руководитель",
  owner: "Владелец",
};

export function SkillPoolPanel({
  departmentId,
  catalogSkills,
  notice,
}: {
  departmentId: string;
  catalogSkills: readonly { id: string; label: string; source: string }[];
  notice: (text: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const call = useMemo(
    () => async <T,>(method: string, input?: unknown): Promise<Result<T>> => {
      try {
        return (await rpc.call(method as never, input as never)) as Result<T>;
      } catch {
        return { ok: false };
      }
    },
    [rpc],
  );
  const [view, setView] = useState<PoolView | null>(null);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [q, setQ] = useState("");
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    const result = await call<PoolView>("getSkillPool", { departmentId });
    if (!result.ok) {
      notice(tr("Не удалось прочитать библиотеку навыков отдела."));
      return;
    }
    setView(result.value);
    setDraft([...result.value.skillIds]);
  }, [call, departmentId, notice]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft || pending) return;
    setPending(true);
    const result = await call<unknown>("setSkillPool", { departmentId, skillIds: draft });
    setPending(false);
    if (!result.ok) {
      notice(result.error?.message ?? tr("Не удалось сохранить библиотеку навыков."));
      return;
    }
    notice(tr("Библиотека отдела сохранена. Оценщик будет открывать отсюда то, что подходит по заданию."));
    void load();
  };

  if (!view || !draft) return <p className="text-sm text-muted-foreground">{tr("Загружаем библиотеку навыков…")}</p>;

  const dirty = JSON.stringify([...view.skillIds].sort()) !== JSON.stringify([...draft].sort());

  return (
    <div className="max-w-3xl space-y-5" data-testid="skill-pool">
      <HintHeading
        title="Библиотека навыков отдела"
        hint={
          <>
            <p>{tr("Навыки в профиле сотрудника едут в каждый его запуск. Библиотека — то, что отдел вправе поднять под конкретное задание.")}</p>
            <p>{tr("Оценщик читает задание и открывает отсюда только то, без чего работа будет заметно хуже: на один запуск и с записью в журнал.")}</p>
            <p>{tr("Правит библиотеку владелец или руководитель этого отдела. Пусто — работают только профили сотрудников.")}</p>
          </>
        }
      />
      <SearchInput aria-label={tr("Поиск навыков")} placeholder={tr("Найти навык…")} value={q} onChange={(event) => setQ(event.target.value)} />
      <CapabilityChecks options={mergeCapabilityChoices(catalogSkills, draft, q)} selected={draft} onChange={setDraft} />
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={!dirty || pending} onClick={() => void save()}>{pending ? tr("Сохраняем…") : tr("Сохранить библиотеку")}</Button>
        <span className="text-xs text-muted-foreground">{tr("В библиотеке: {count}", { count: draft.length })}</span>
      </div>

      <div className="space-y-2">
        <HintHeading
          level={3}
          title="Журнал выдач"
          hint={<p>{tr("Кому и какой навык открыли под задачу, кто решил и насколько был уверен. По журналу видно, чего отделу не хватает постоянно: такой навык стоит добавить сотруднику в профиль.")}</p>}
        />
        {view.grants.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tr("Пока ничего не открывали.")}</p>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border text-sm">
            {view.grants.map((grant) => (
              <div key={grant.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
                <span className="font-medium">{grant.skillName}</span>
                <span className="text-xs text-muted-foreground">{grant.jobKey}</span>
                <span className="text-xs text-muted-foreground">{grant.agentId}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {`${tr(DECIDER[grant.decidedBy])}${grant.confidence === null ? "" : ` · ${Math.round(grant.confidence * 100)}%`} · ${new Date(grant.createdAt).toLocaleDateString(uiLocale())}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
