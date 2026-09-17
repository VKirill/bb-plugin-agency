import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import type { DependencyLinkRecord, JobNextStepRecord, NextStepViewRecord } from "../../shared/rpc-contract";
import type { AgencyApi } from "../data/agency-api";
import { displayJobTitle } from "../data/job-board";
import { jobHierarchyRoot } from "../data/job-tree";
import { failureNotice } from "../data/persist";
import { tr } from "../i18n";
import { stateNames, states, type Job, type State } from "./data";
import { JobBriefFields } from "./job-fields";
import { Button, Choice, Field, InfoHint, Status, TextField } from "./shared";

export type JobFlowLinks = { waitsFor: DependencyLinkRecord[]; blocks: DependencyLinkRecord[] };

const ASSIGNMENT_OPTIONS = [
  { value: "lead", label: "Руководитель отдела" },
  { value: "executor", label: "Исполнитель с наименьшей загрузкой" },
  { value: "reviewer", label: "Проверяющий с наименьшей загрузкой" },
] as const;

function asState(value: string): State {
  return (states as readonly string[]).includes(value) ? (value as State) : "backlog";
}

function FlowRow({ link, openJob, meta }: { link: { key: string; title: string; state: string }; openJob: (id: string) => void; meta?: string }) {
  const state = asState(link.state);
  return (
    <li>
      <button type="button" className="agency-subtask-row" onClick={() => openJob(link.key)}>
        <Status state={state} iconOnly />
        <span className="agency-subtask-key">{link.key}</span>
        <span className="agency-subtask-title">{displayJobTitle({ id: link.key, title: link.title })}</span>
        <span className="agency-subtask-meta">{meta ?? tr(stateNames[state])}</span>
      </button>
    </li>
  );
}

/** What the card says about a next step: waiting, created, or why not. */
export function nextStepStatus(view: NextStepViewRecord, jobs: readonly Pick<Job, "id" | "recordId">[]): { text: string; key?: string; warn?: boolean } {
  if (!view.outcome) return { text: tr("создастся, когда задача будет готова") };
  if (view.outcome === "created") {
    const key = jobs.find((item) => item.recordId === view.createdJobId)?.id;
    return key ? { text: tr("создана {key}", { key }), key } : { text: tr("создана") };
  }
  if (view.outcome === "source_canceled") return { text: tr("не создана: задача отменена"), warn: true };
  return { text: tr("не создана: {reason}", { reason: view.outcome.replace(/^create_failed: /, "") }), warn: true };
}

/**
 * Order of work around a job: jobs that must be done before it launches, jobs that
 * wait for it, and the next step the Agency creates by itself once it is done.
 * Shown when there is something to show; changes go through the dialog.
 */
export function JobFlowSection({
  job,
  jobs,
  links,
  nextStep,
  departments,
  openJob,
  onEdit,
}: {
  job: Job;
  jobs: readonly Job[];
  links: JobFlowLinks;
  nextStep: NextStepViewRecord | null;
  departments: readonly { id: string; name: string }[];
  openJob: (id: string) => void;
  onEdit?: () => void;
}) {
  if (!links.waitsFor.length && !links.blocks.length && !nextStep) return null;
  const waiting = links.waitsFor.filter((link) => link.state !== "done");
  const status = nextStep ? nextStepStatus(nextStep, jobs) : null;
  const department = nextStep ? departments.find((item) => item.id === nextStep.step.departmentId)?.name ?? nextStep.step.departmentId : "";
  return (
    <section className="agency-subtasks" aria-label={tr("Порядок работы")} data-testid="job-flow">
      <div className="agency-subtasks-head">
        <h2 className="flex items-center gap-1 text-sm font-medium">
          {tr("Порядок работы")}
          <InfoHint title="Порядок работы">
            <p>{tr("«До запуска» — задачи, которые должны быть готовы раньше этой. Пока они не готовы, запуск откладывается; задача из очереди запуска стартует сама.")}</p>
            <p>{tr("«Следующий шаг» — задача другому отделу, которую Агентство создаст само, когда эта будет готова: приложит принятые версии и поставит в очередь запуска.")}</p>
          </InfoHint>
        </h2>
        {onEdit && <Button size="sm" variant="ghost" onClick={onEdit}>{tr("Изменить")}</Button>}
      </div>
      {links.waitsFor.length > 0 && (
        <>
          <p className="mt-2 text-xs text-muted-foreground">
            {waiting.length && job.state !== "done" && job.state !== "canceled"
              ? tr("До запуска должны быть готовы · ждёт {count}", { count: waiting.length })
              : tr("До запуска должны быть готовы")}
          </p>
          <ul className="agency-subtasks-list">{links.waitsFor.map((link) => <FlowRow key={link.jobId} link={link} openJob={openJob} />)}</ul>
        </>
      )}
      {(links.blocks.length > 0 || nextStep) && (
        <>
          <p className="mt-3 text-xs text-muted-foreground">{tr("После этой задачи")}</p>
          <ul className="agency-subtasks-list">
            {links.blocks.map((link) => <FlowRow key={link.jobId} link={link} openJob={openJob} />)}
            {nextStep && status && (
              <li>
                {(() => {
                  const cells = (
                    <>
                      <span aria-hidden className="text-muted-foreground">→</span>
                      <span className="agency-subtask-key">{status.key ?? tr("шаг")}</span>
                      <span className="agency-subtask-title">{tr("Следующий шаг: {title} · {department}", { title: nextStep.step.title, department })}</span>
                      <span className={`agency-subtask-meta ${status.warn ? "text-amber-700 dark:text-amber-400" : ""}`}>{status.text}</span>
                    </>
                  );
                  const key = status.key;
                  return key ? (
                    <button type="button" className="agency-subtask-row" data-testid="job-next-step" onClick={() => openJob(key)}>{cells}</button>
                  ) : (
                    <div className="agency-subtask-row" data-testid="job-next-step" style={{ cursor: "default" }}>{cells}</div>
                  );
                })()}
              </li>
            )}
          </ul>
        </>
      )}
    </section>
  );
}

type StepDraft = { departmentId: string; assignment: JobNextStepRecord["assignment"]; title: string; brief: string; acceptance: string };

function draftFrom(view: NextStepViewRecord | null, departmentId: string): StepDraft {
  return view
    ? { ...view.step }
    : { departmentId, assignment: "lead", title: "", brief: "", acceptance: "" };
}

/** Jobs this one may wait for: the same folder or the same job tree, not itself and not canceled. */
export function dependencyCandidates(job: Job, jobs: readonly Job[], links: JobFlowLinks): Job[] {
  const root = jobHierarchyRoot(jobs, job).id;
  const taken = new Set(links.waitsFor.map((link) => link.jobId));
  return jobs.filter(
    (item) =>
      item.recordId &&
      item.id !== job.id &&
      item.state !== "canceled" &&
      !taken.has(item.recordId) &&
      (item.bindingId === job.bindingId || jobHierarchyRoot(jobs, item).id === root),
  );
}

export function JobFlowDialog({
  open,
  onOpenChange,
  job,
  jobs,
  links,
  nextStep,
  departments,
  api,
  notice,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: Job;
  jobs: readonly Job[];
  links: JobFlowLinks;
  nextStep: NextStepViewRecord | null;
  /** Departments available to the job's project: the next step is created there. */
  departments: readonly { id: string; name: string }[];
  api: Pick<AgencyApi, "addJobDependency" | "removeJobDependency" | "setJobNextStep">;
  notice: (text: string) => void;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [candidate, setCandidate] = useState("");
  // Mounted per opening: the form starts from what is saved.
  const [draft, setDraft] = useState<StepDraft>(() => draftFrom(nextStep, departments[0]?.id ?? ""));
  const jobId = job.recordId;
  const candidates = dependencyCandidates(job, jobs, links);
  const candidateId = candidates.some((item) => item.recordId === candidate) ? candidate : "";
  const closed = job.state === "done" || job.state === "canceled";
  const stepLocked = Boolean(nextStep?.outcome) || closed;
  const departmentId = departments.some((item) => item.id === draft.departmentId) ? draft.departmentId : departments[0]?.id ?? "";
  const canSaveStep = !pending && Boolean(departmentId && draft.title.trim() && draft.brief.trim() && draft.acceptance.trim());
  const patch = (next: Partial<StepDraft>) => setDraft((current) => ({ ...current, ...next }));

  const run = async <T,>(action: () => Promise<{ ok: true; value: T } | { ok: false; failure: Parameters<typeof failureNotice>[0] }>, done: string) => {
    if (!jobId || pending) return false;
    setPending(true);
    const result = await action();
    setPending(false);
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return false;
    }
    notice(tr(done));
    onChanged();
    return true;
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("Порядок работы")}</DialogTitle>
          <DialogDescription>{tr("Изменения сохраняются сразу, каждое своей кнопкой.")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[65dvh] space-y-5 overflow-y-auto pr-1">
          <section className="space-y-2" aria-label={tr("До запуска")}>
            <Field label="До запуска должны быть готовы" info={<p>{tr("Пока эти задачи не готовы, запуск откладывается. Задача из очереди запуска стартует сама, когда все будут готовы. Если одна из них отменена, задача снимается с очереди и ждёт решения.")}</p>}>
              {links.waitsFor.length ? (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {links.waitsFor.map((link) => (
                    <li key={link.jobId} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <Status state={asState(link.state)} iconOnly />
                      <span className="font-mono text-xs text-muted-foreground">{link.key}</span>
                      <span className="min-w-0 flex-1 truncate">{link.title}</span>
                      <Button size="sm" variant="ghost" disabled={pending} aria-label={tr("Убрать зависимость от {key}", { key: link.key })} onClick={() => void run(() => api.removeJobDependency({ jobId: jobId!, dependsOnJobId: link.jobId }), "Зависимость убрана.")}>
                        {tr("Убрать")}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">{tr("Задача ни от чего не зависит.")}</p>
              )}
            </Field>
            {candidates.length ? (
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <Choice label="Задача, которая должна быть готова" value={candidateId} onChange={setCandidate} options={candidates.map((item) => ({ value: item.recordId!, label: `${item.id} · ${displayJobTitle(item)}` }))} />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!candidateId || pending}
                  onClick={() =>
                    void run(() => api.addJobDependency({ requestId: crypto.randomUUID(), jobId: jobId!, dependsOnJobId: candidateId }), "Зависимость добавлена.").then((added) => {
                      if (added) setCandidate("");
                    })
                  }
                >
                  {tr("Добавить")}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{tr("Других задач в этой папке и в дереве задачи нет.")}</p>
            )}
          </section>
          <section className="space-y-3 border-t border-border pt-4" aria-label={tr("Следующий шаг")}>
            <Field label="Следующий шаг" info={<><p>{tr("Когда эта задача будет готова, Агентство само создаст задачу выбранному отделу рядом с ней: в той же папке и под той же главной задачей.")}</p><p>{tr("К новой задаче приложатся принятые версии результата, и она встанет в очередь запуска.")}</p></>}>
              {stepLocked ? (
                <p className="text-xs text-muted-foreground">
                  {nextStep?.outcome ? `${nextStep.step.title} · ${nextStepStatus(nextStep, jobs).text}` : tr("Задача закрыта: следующий шаг не задаётся.")}
                </p>
              ) : !departments.length ? (
                <p className="text-xs text-muted-foreground">{tr("Проекту задачи не доступен ни один отдел.")}</p>
              ) : (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Отдел" required>
                      <Choice label="Отдел следующего шага" value={departmentId} onChange={(value) => patch({ departmentId: value })} options={departments.map((item) => ({ value: item.id, label: item.name }))} />
                    </Field>
                    <Field label="Кто возьмёт">
                      <Choice label="Кто возьмёт следующий шаг" value={draft.assignment} onChange={(value) => patch({ assignment: value as StepDraft["assignment"] })} options={ASSIGNMENT_OPTIONS} />
                    </Field>
                  </div>
                  <TextField label="Название" value={draft.title} onChange={(value) => patch({ title: value })} maxLength={200} required />
                  <JobBriefFields brief={draft.brief} acceptance={draft.acceptance} onBrief={(value) => patch({ brief: value })} onAcceptance={(value) => patch({ acceptance: value })} />
                  <div className="flex flex-wrap justify-end gap-2">
                    {nextStep && (
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(() => api.setJobNextStep({ jobId: jobId!, step: null }), "Следующий шаг убран.")}>
                        {tr("Убрать шаг")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      disabled={!canSaveStep}
                      onClick={() =>
                        void run(
                          () => api.setJobNextStep({ jobId: jobId!, step: { departmentId, assignment: draft.assignment, title: draft.title.trim(), brief: draft.brief.trim(), acceptance: draft.acceptance.trim() } }),
                          "Следующий шаг сохранён.",
                        )
                      }
                    >
                      {tr("Сохранить шаг")}
                    </Button>
                  </div>
                </div>
              )}
            </Field>
          </section>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            {tr("Закрыть")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
