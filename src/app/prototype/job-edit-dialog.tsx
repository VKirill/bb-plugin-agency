import { useEffect, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { splitDescription } from "../data/view-models";
import type { JobContract } from "../../shared/contracts/job";
import { JobBriefFields, JobContractFields, composeJobDescription } from "./job-fields";
import { Button, TextField } from "./shared";
import { tr } from "../i18n";

/**
 * Single place where a job is edited. The task rail only states facts, so the
 * dialog carries the name, the brief and, through `children`, the remaining
 * properties (status, assignee, priority, due date, placement, team).
 */
export function JobEditDialog({
  open,
  title,
  description,
  pending = false,
  children,
  onOpenChange,
  onTitle,
  onDescription,
  onSave,
  contract,
  onContract,
}: {
  contract?: JobContract;
  onContract?: (next: JobContract | undefined) => void;
  open: boolean;
  title: string;
  description: string;
  pending?: boolean;
  children?: ReactNode;
  onOpenChange: (open: boolean) => void;
  onTitle: (value: string) => void;
  onDescription: (value: string) => void;
  onSave: () => void | Promise<void>;
}) {
  // Brief and criteria are two fields; the stored description joins them with a marker the user never edits.
  // They are read once on open, so typing a trailing space or new line is not trimmed away.
  const [parts, setParts] = useState(() => splitDescription(description));
  useEffect(() => {
    if (open) setParts(splitDescription(description));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const change = (next: { brief: string; acceptance: string | null }) => {
    setParts(next);
    onDescription(composeJobDescription(next.brief, next.acceptance ?? ""));
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
      <DialogContent data-testid="job-edit-dialog" className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tr("Редактировать задачу")}</DialogTitle>
          <DialogDescription>{tr("Изменения применяются по кнопке «Сохранить». Проект, отдел и состав команды меняются отдельно и сохраняются сразу.")}</DialogDescription>
        </DialogHeader>
        <TextField label="Название" value={title} onChange={onTitle} maxLength={200} required/>
        <JobBriefFields
          brief={parts.brief}
          acceptance={parts.acceptance ?? ""}
          onBrief={(brief) => change({ ...parts, brief })}
          onAcceptance={(acceptance) => change({ ...parts, acceptance })}
        />
        {onContract && open && <JobContractFields value={contract} onChange={onContract} />}
        {children}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>{tr("Отмена")}</Button>
          <Button data-testid="job-edit-save" disabled={!title.trim() || !parts.brief.trim() || !(parts.acceptance ?? "").trim() || pending} onClick={() => void onSave()}>
            {pending ? tr("Сохраняем…") : tr("Сохранить")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
