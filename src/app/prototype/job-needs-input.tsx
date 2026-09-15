import { useEffect, useState } from "react";
import type { NeedsInputRecord } from "../../shared/contracts";
import type { AgencyApi } from "../data/agency-api";
import {
  ANSWER_QUEUED_NOTICE,
  ANSWER_RECONCILE_NOTICE,
  ANSWER_REJECTED_NOTICE,
  ANSWER_STALE_WAIT_NOTICE,
  bindRequestToWait,
  collectAnswers,
  nextAnswerUiAction,
  readPersistedAnswerWait,
  submitAnswerNeedsInput,
  writePersistedAnswerWait,
} from "../data/answer-needs-input";
import { NEEDS_INPUT_COMMENT_HINT, needsInputSourceLabel, shouldClearNeedsInputAfterAnswer } from "../data/needs-input";
import { failureNotice } from "../data/persist";
import { Button } from "./shared";

export function JobNeedsInputPanel({
  record,
  api,
  notice,
  onChanged,
}: {
  record: NeedsInputRecord;
  api: AgencyApi;
  notice: (text: string) => void;
  onChanged: () => void;
}) {
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [bound, setBound] = useState<{ waitId: string; requestId: string } | null>(null);
  const [sendState, setSendState] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const stored = readPersistedAnswerWait(record.waitId);
    const request = bindRequestToWait(stored, record.waitId, () => crypto.randomUUID());
    setTexts(stored?.texts ?? {});
    setSendState(stored?.sendState ?? null);
    setBound(request);
    writePersistedAnswerWait({
      waitId: record.waitId,
      requestId: request.requestId,
      texts: stored?.texts ?? {},
      sendState: stored?.sendState ?? null,
    });
  }, [record.waitId]);

  useEffect(() => {
    if (!bound) return;
    writePersistedAnswerWait({
      waitId: record.waitId,
      requestId: bound.requestId,
      texts,
      sendState,
    });
  }, [bound, record.waitId, sendState, texts]);

  const action = nextAnswerUiAction({ waitId: record.waitId, sendState, inFlight: pending });
  const canSend = action === "send" && !pending;
  const canReconcile = action === "reconcile" && !pending;

  const submit = async (mode: "send" | "reconcile") => {
    if (action === "wait") {
      notice(ANSWER_QUEUED_NOTICE);
      return;
    }
    if (action === "refuse") {
      notice(sendState === "rejected" ? ANSWER_REJECTED_NOTICE : ANSWER_STALE_WAIT_NOTICE);
      return;
    }
    if (mode === "send" && !canSend) return;
    if (mode === "reconcile" && !canReconcile) return;
    const collected = collectAnswers(record.questions, texts);
    if (!collected.ok) {
      notice(collected.reason);
      return;
    }
    const request = bindRequestToWait(bound, record.waitId, () => crypto.randomUUID());
    setBound(request);
    writePersistedAnswerWait({
      waitId: record.waitId,
      requestId: request.requestId,
      texts,
      sendState: sendState ?? (mode === "reconcile" ? "needs_reconciliation" : "pending"),
    });
    setPending(true);
    const result = await submitAnswerNeedsInput(api, {
      record,
      requestId: request.requestId,
      answers: collected.answers,
    });
    setPending(false);
    if (!result.ok) {
      notice(result.reason ?? (result.failure ? failureNotice(result.failure) : ANSWER_STALE_WAIT_NOTICE));
      return;
    }
    setSendState(result.value.sendState);
    writePersistedAnswerWait({
      waitId: record.waitId,
      requestId: request.requestId,
      texts,
      sendState: result.value.sendState,
    });
    if (result.value.sendState === "queued") {
      notice(ANSWER_QUEUED_NOTICE);
      return;
    }
    if (result.value.sendState === "unknown" || result.value.sendState === "needs_reconciliation") {
      notice(ANSWER_RECONCILE_NOTICE);
      return;
    }
    if (result.value.sendState === "rejected") {
      notice(ANSWER_REJECTED_NOTICE);
      return;
    }
    if (shouldClearNeedsInputAfterAnswer(result.value.sendState)) {
      notice(mode === "reconcile"
        ? "Сверка нашла доставку. Исполнитель продолжает ту же работу."
        : "Ответ принят. Исполнитель продолжает ту же работу.");
      onChanged();
    }
  };

  return (
    <section aria-label="Вопрос исполнителя" className="mb-6 rounded-xl border border-foreground/20 bg-muted/60 p-5" data-testid="needs-input-panel">
      <h2 className="text-base font-semibold">Нужен ответ, чтобы продолжить</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        wait {record.waitId} · попытка {record.attemptId} · thread {record.threadId}
      </p>
      <ol className="mt-3 list-decimal space-y-3 pl-5 text-sm">
        {record.questions.map((item) => (
          <li key={item.id}>
            <p>{item.text}</p>
            <ul className="mt-1 list-none space-y-0.5 text-xs text-muted-foreground">
              {item.sourceRefs.map((ref) => (
                <li key={`${ref.kind}:${ref.id}`}>
                  {needsInputSourceLabel(ref.kind)}: <span className="font-mono">{ref.id}</span>
                </li>
              ))}
            </ul>
            <label className="mt-2 block text-xs text-muted-foreground" htmlFor={`needs-input-answer-${item.id}`}>
              Ответ на {item.id}
            </label>
            <textarea
              id={`needs-input-answer-${item.id}`}
              data-testid={`needs-input-answer-${item.id}`}
              rows={3}
              disabled={pending || action === "wait" || action === "refuse"}
              value={texts[item.id] ?? ""}
              onChange={(event) => setTexts((current) => ({ ...current, [item.id]: event.target.value }))}
              className="mt-1 w-full resize-y rounded-md border border-border bg-background p-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </li>
        ))}
      </ol>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          data-testid="needs-input-send"
          disabled={!canSend}
          onClick={() => void submit("send")}
        >
          {pending ? "Отправляем…" : "Ответить исполнителю"}
        </Button>
        {canReconcile && (
          <Button
            size="sm"
            variant="outline"
            data-testid="needs-input-reconcile"
            disabled={pending}
            onClick={() => void submit("reconcile")}
          >
            Сверить доставку
          </Button>
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground" data-testid="needs-input-comment-hint">
        {NEEDS_INPUT_COMMENT_HINT}
      </p>
    </section>
  );
}
