/** UI read of getJob.needsInput. Shared/server stay backend-owned. */

import { needsInputRecordSchema, type NeedsInputRecord } from "../../shared/contracts";

export type { NeedsInputRecord };

export const NEEDS_INPUT_SOURCE_LABEL: Record<string, string> = {
  process_acceptance: "Критерии процесса",
  process_instructions: "Инструкции процесса",
  job_acceptance: "Критерии задачи",
  job_brief: "Бриф задачи",
};

export const NEEDS_INPUT_COMMENT_HINT =
  "Комментарий пишется только в историю. Он не отвечает на вопросы исполнителя и не возвращает задачу в работу.";

export const NEEDS_INPUT_NO_ANSWER_ACTION =
  "Комментарий и смена статуса это не закрывают. Нужен ответ на все вопросы текущего waitId.";

/** After freeze: unknown/needs_reconciliation = reconcile only, not another send. */
export const ANSWER_UNKNOWN_NOTICE =
  "Состояние неизвестно. Нужна сверка той же команды, не повторная отправка и не новый запуск.";

export function answerSendIsActive(sendState: string | null | undefined, turnActive?: boolean): boolean {
  if (turnActive === false) return false;
  if (sendState === "queued" || sendState === "unknown" || sendState === "needs_reconciliation") return false;
  return sendState === "pending";
}

export function shouldClearNeedsInputAfterAnswer(sendState: string): boolean {
  return sendState === "confirmed";
}

export function needsInputSourceLabel(kind: string): string {
  return NEEDS_INPUT_SOURCE_LABEL[kind] ?? kind;
}

/** Keep every JobDetail.needsInput field; drop only invalid wire. */
export function parseNeedsInputRecord(value: unknown): NeedsInputRecord | null {
  if (value == null) return null;
  const parsed = needsInputRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Refetch getJob when list snapshot revision/state moves, not only job id. */
export function jobDetailRefreshKey(job: {
  recordId?: string;
  id: string;
  revision?: number;
  sourceState?: string;
  state: string;
}): string {
  return `${job.recordId || job.id}:${job.revision ?? ""}:${job.sourceState || job.state}`;
}

export function nextNeedsInputFromDetail(
  previous: NeedsInputRecord | null,
  incoming: NeedsInputRecord | null,
): { record: NeedsInputRecord | null; clearNotice: boolean } {
  const nextId = incoming?.waitId ?? null;
  const prevId = previous?.waitId ?? null;
  return {
    record: incoming,
    clearNotice: Boolean(nextId && nextId !== prevId),
  };
}
