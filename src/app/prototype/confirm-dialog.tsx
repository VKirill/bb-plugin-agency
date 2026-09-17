import { useCallback, useRef, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Button } from "./shared";
import { tr } from "../i18n";

type Question = { title: string; description: string; confirmLabel: string };

/**
 * BB-styled replacement for window.confirm: `ask` opens a dialog and resolves
 * with the person's answer. Render `dialog` once in the component.
 */
export function useConfirm(): { dialog: ReactNode; ask: (question: Question) => Promise<boolean> } {
  const [question, setQuestion] = useState<Question | null>(null);
  const resolver = useRef<((answer: boolean) => void) | null>(null);
  const answer = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setQuestion(null);
  };
  const ask = useCallback(
    (next: Question) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setQuestion(next);
      }),
    [],
  );
  const dialog = (
    <Dialog open={Boolean(question)} onOpenChange={(open) => { if (!open) answer(false); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{question?.title}</DialogTitle>
          <DialogDescription>{question?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => answer(false)}>{tr("Отмена")}</Button>
          <Button onClick={() => answer(true)}>{question?.confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { dialog, ask };
}
