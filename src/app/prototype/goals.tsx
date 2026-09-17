import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import type { GoalViewRecord, rpcContract } from "../../shared/rpc-contract";
import { failureNotice } from "../data/persist";
import { createRpcAgencyApi, type RpcCaller } from "../data/rpc-agency-api";
import { dueAtFromDate, dueDate } from "../data/view-models";
import { tr, uiLocale } from "../i18n";
import type { Job } from "./data";
import { Button, Choice, Empty, Field, PageHead, Status, TextField } from "./shared";

type Draft = { id?: string; revision: number; title: string; description: string; status: GoalViewRecord["status"]; due: string };

const STATUS_OPTIONS = [
  { value: "active", label: "Активна" },
  { value: "done", label: "Достигнута" },
  { value: "dropped", label: "Отменена" },
];

/**
 * Goals above main jobs: what a set of jobs is for and how far it has got.
 * A main job serves at most one goal; its subtasks count through it.
 */
export function GoalsPage({ jobs, openJob, notice }: { jobs: Job[]; openJob: (id: string) => void; notice: (text: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const api = useMemo(() => createRpcAgencyApi(rpc as unknown as RpcCaller), [rpc]);
  const [goals, setGoals] = useState<GoalViewRecord[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [linking, setLinking] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const load = useCallback(async () => {
    const result = await api.listGoals();
    if (result.ok) setGoals(result.value);
    else notice(failureNotice(result.failure));
  }, [api, notice]);
  useEffect(() => {
    void load();
  }, [load, jobs]);

  const mainJobs = jobs.filter((job) => !job.parentId && job.recordId);
  const byRecord = new Map(mainJobs.map((job) => [job.recordId!, job]));
  const unlinked = mainJobs.filter((job) => !job.goalId && job.state !== "canceled");

  const save = async () => {
    if (!draft || pending) return;
    setPending(true);
    const result = await api.saveGoal({
      ...(draft.id ? { id: draft.id } : {}),
      expectedRevision: draft.revision,
      title: draft.title,
      description: draft.description,
      status: draft.status,
      dueAt: draft.due ? dueAtFromDate(draft.due) : null,
    });
    setPending(false);
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    setDraft(null);
    notice(tr("Цель сохранена."));
    void load();
  };

  const link = async (goalId: string, jobId: string | null, recordId: string) => {
    const result = await api.setJobGoal({ jobId: recordId, goalId: jobId === null ? null : goalId });
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    setLinking((current) => ({ ...current, [goalId]: "" }));
    void load();
  };

  return (
    <div className="space-y-5">
      <PageHead title="Цели" description="Зачем идут главные задачи и насколько продвинулись. Подзадачи учитываются через свою главную задачу.">
        <Button onClick={() => setDraft({ revision: 0, title: "", description: "", status: "active", due: "" })}>{tr("Новая цель")}</Button>
      </PageHead>
      {goals === null ? (
        <p className="text-sm text-muted-foreground">{tr("Загружаем цели…")}</p>
      ) : goals.length === 0 ? (
        <Empty title="Целей пока нет" description="Создайте цель и привяжите к ней главные задачи: здесь будет виден прогресс." />
      ) : (
        <div className="space-y-4">
          {goals.map((goal) => {
            const percent = goal.progress.total ? Math.round((goal.progress.done / goal.progress.total) * 100) : 0;
            const linked = goal.jobIds.map((id) => byRecord.get(id)).filter((job): job is Job => Boolean(job));
            return (
              <section key={goal.id} className="rounded-lg border border-border p-4" aria-label={goal.title}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold">{goal.title}</h2>
                    <p className="text-xs text-muted-foreground">
                      {[tr(STATUS_OPTIONS.find((item) => item.value === goal.status)!.label), goal.dueAt ? tr("до {date}", { date: new Date(goal.dueAt).toLocaleDateString(uiLocale()) }) : null].filter(Boolean).join(" · ")}
                    </p>
                    {goal.description && <p className="mt-1 max-w-prose text-sm">{goal.description}</p>}
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setDraft({ id: goal.id, revision: goal.revision, title: goal.title, description: goal.description, status: goal.status, due: goal.dueAt ? dueDate(goal.dueAt) : "" })}>{tr("Изменить")}</Button>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                    <span className="block h-full bg-emerald-500" style={{ width: `${percent}%` }} />
                  </span>
                  <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{tr("готово {done} из {total} · в работе {open}", { done: goal.progress.done, total: goal.progress.total, open: goal.progress.open })}</span>
                </div>
                <ul className="mt-3 divide-y divide-border rounded-md border border-border">
                  {linked.map((job) => (
                    <li key={job.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                      <button type="button" className="flex min-w-0 items-center gap-2 text-left hover:underline" onClick={() => openJob(job.id)}>
                        <Status state={job.state} iconOnly />
                        <span className="font-mono text-xs text-muted-foreground">{job.id}</span>
                        <span className="truncate">{job.title}</span>
                      </button>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => void link(goal.id, null, job.recordId!)}>{tr("Отвязать")}</Button>
                    </li>
                  ))}
                  {!linked.length && <li className="px-3 py-2 text-xs text-muted-foreground">{tr("Главных задач у цели пока нет.")}</li>}
                </ul>
                {unlinked.length > 0 && goal.status === "active" && (
                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    <div className="w-72">
                      <Field label="Привязать главную задачу">
                        <Choice
                          label="Главная задача для цели"
                          value={linking[goal.id] ?? ""}
                          onChange={(value) => setLinking((current) => ({ ...current, [goal.id]: value }))}
                          options={unlinked.map((job) => ({ value: job.recordId!, label: `${job.id} · ${job.title}` }))}
                        />
                      </Field>
                    </div>
                    <Button size="sm" disabled={!linking[goal.id]} onClick={() => void link(goal.id, goal.id, linking[goal.id]!)}>{tr("Привязать")}</Button>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
      <Dialog open={Boolean(draft)} onOpenChange={(open) => { if (!open && !pending) setDraft(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.id ? tr("Изменить цель") : tr("Новая цель")}</DialogTitle>
            <DialogDescription>{tr("Цель — результат для владельца, ради которого идут главные задачи. Сроки и статус цели задачи не меняют.")}</DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="space-y-3">
              <TextField label="Название цели" value={draft.title} maxLength={200} required onChange={(title) => setDraft({ ...draft, title })} />
              <TextField label="Что считается достигнутым" multiline rows={4} maxLength={4_000} value={draft.description} onChange={(description) => setDraft({ ...draft, description })} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Статус">
                  <Choice label="Статус цели" value={draft.status} onChange={(status) => setDraft({ ...draft, status: status as Draft["status"] })} options={STATUS_OPTIONS} />
                </Field>
                <TextField label="Срок" type="date" value={draft.due} onChange={(due) => setDraft({ ...draft, due })} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setDraft(null)}>{tr("Отмена")}</Button>
            <Button disabled={pending || !draft?.title.trim()} onClick={() => void save()}>{pending ? tr("Сохраняем…") : tr("Сохранить цель")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
