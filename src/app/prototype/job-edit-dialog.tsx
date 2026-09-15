import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Button, TextField } from "./shared";

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
}: {
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
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
      <DialogContent data-testid="job-edit-dialog" className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Редактировать задачу</DialogTitle>
          <DialogDescription>Изменения применяются по кнопке «Сохранить». Проект, отдел и состав команды сохраняются отдельно, сразу.</DialogDescription>
        </DialogHeader>
        <TextField label="Название" value={title} onChange={onTitle}/>
        <TextField label="Описание и критерии" value={description} onChange={onDescription} multiline/>
        {children}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button data-testid="job-edit-save" disabled={!title.trim() || pending} onClick={() => void onSave()}>
            {pending ? "Сохраняем…" : "Сохранить"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
