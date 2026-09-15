/** UI answerNeedsInput: waitId + all question ids + live pins. Shared/server stay backend-owned. */

import type { AnswerNeedsInputCommand, AnswerNeedsInputRecord, NeedsInputAnswer, NeedsInputQuestion, NeedsInputRecord } from "../../shared/contracts";
import type { AgencyApi } from "./agency-api";
import { sha256Utf8 } from "./content-hash";
import type { MutationFailure } from "./envelope";
import { persistAnswerNeedsInput } from "./persist";

export const ANSWER_INCOMPLETE_NOTICE =
  "Ответьте на каждый вопрос этой паузы. Пропущенный или лишний id не принимается.";

export const ANSWER_STALE_WAIT_NOTICE =
  "Открыт новый запрос. Старый ответ его не закрывает — заполните вопросы заново.";

export const ANSWER_QUEUED_NOTICE =
  "Ответ стоит в очереди доставки. Ход исполнителя ещё не подтверждён. Повторно не отправляем.";

export const ANSWER_RECONCILE_NOTICE =
  "Состояние неизвестно. Нужна сверка той же команды, не повторная отправка и не новый запуск.";

export const ANSWER_PIN_NOTICE =
  "Нельзя ответить: нет версии процесса или digest снимка запуска.";

export const ANSWER_REJECTED_NOTICE =
  "Доставка отклонена. Тот же запрос повторно не шлём. Обновите карточку.";

export const ANSWER_NO_WAIT_NOTICE = "Нет открытого waitId. Отвечать не на что.";

export type AnswerUiAction = "send" | "wait" | "reconcile" | "refuse";

export function nextAnswerUiAction(input: {
  waitId?: string | null;
  sendState?: string | null;
  inFlight?: boolean;
}): AnswerUiAction {
  if (!input.waitId) return "refuse";
  if (input.sendState === "queued" || input.sendState === "pending") {
    return input.inFlight ? "wait" : "reconcile";
  }
  if (input.sendState === "unknown" || input.sendState === "needs_reconciliation") return "reconcile";
  if (input.sendState === "rejected") return "refuse";
  return "send";
}

export function noticeForAnswerAction(action: AnswerUiAction): string | null {
  if (action === "wait") return ANSWER_QUEUED_NOTICE;
  if (action === "reconcile") return ANSWER_RECONCILE_NOTICE;
  if (action === "refuse") return ANSWER_NO_WAIT_NOTICE;
  return null;
}

export type PersistedAnswerWait = {
  waitId: string;
  requestId: string;
  texts: Record<string, string>;
  sendState: string | null;
};

export function answerWaitStorageKey(waitId: string): string {
  return `agency.answer-wait.${waitId}`;
}

export function readPersistedAnswerWait(waitId: string, storage?: Storage | null): PersistedAnswerWait | null {
  try {
    const raw = (storage ?? globalThis.sessionStorage)?.getItem(answerWaitStorageKey(waitId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedAnswerWait;
    if (parsed.waitId !== waitId || !parsed.requestId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writePersistedAnswerWait(value: PersistedAnswerWait, storage?: Storage | null): void {
  try {
    (storage ?? globalThis.sessionStorage)?.setItem(answerWaitStorageKey(value.waitId), JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

export function bindRequestToWait(
  previous: { waitId: string; requestId: string } | null,
  waitId: string,
  createId: () => string,
  storage?: Storage | null,
): { waitId: string; requestId: string } {
  if (previous && previous.waitId === waitId) return previous;
  const stored = readPersistedAnswerWait(waitId, storage);
  if (stored) return { waitId: stored.waitId, requestId: stored.requestId };
  return { waitId, requestId: createId() };
}

export function collectAnswers(
  questions: readonly NeedsInputQuestion[],
  texts: Record<string, string>,
): { ok: true; answers: NeedsInputAnswer[] } | { ok: false; reason: string } {
  const expected = questions.map((item) => item.id);
  const answers: NeedsInputAnswer[] = [];
  for (const id of expected) {
    const text = texts[id]?.trim() ?? "";
    if (!text) return { ok: false, reason: ANSWER_INCOMPLETE_NOTICE };
    answers.push({ questionId: id, text });
  }
  const extra = Object.keys(texts).filter((id) => texts[id]?.trim() && !expected.includes(id));
  if (extra.length) return { ok: false, reason: ANSWER_INCOMPLETE_NOTICE };
  if (answers.length !== expected.length) return { ok: false, reason: ANSWER_INCOMPLETE_NOTICE };
  return { ok: true, answers };
}

export async function submitAnswerNeedsInput(
  api: AgencyApi,
  input: {
    record: NeedsInputRecord;
    requestId: string;
    answers: NeedsInputAnswer[];
  },
): Promise<{ ok: true; value: AnswerNeedsInputRecord } | { ok: false; failure?: MutationFailure; reason?: string }> {
  const covered = collectAnswers(input.record.questions, Object.fromEntries(input.answers.map((item) => [item.questionId, item.text])));
  if (!covered.ok) return { ok: false, reason: covered.reason };
  if (!input.record.waitId) return { ok: false, reason: ANSWER_NO_WAIT_NOTICE };

  const detail = await api.getJob({ jobId: input.record.jobId });
  if (!detail.ok) return { ok: false, failure: detail.failure };
  const live = detail.value.needsInput;
  if (!live?.waitId) return { ok: false, reason: ANSWER_STALE_WAIT_NOTICE };
  if (live.waitId !== input.record.waitId) return { ok: false, reason: ANSWER_STALE_WAIT_NOTICE };

  const departmentId = detail.value.job.departmentId;
  const department = await api.getDepartment({ departmentId });
  if (!department.ok) return { ok: false, failure: department.failure };
  const process = department.value.process;
  const processVersionId = department.value.department.processVersionId;
  if (!process || !processVersionId) return { ok: false, reason: ANSWER_PIN_NOTICE };

  const launch = await api.getLaunch({ launchId: input.record.launchId });
  if (!launch.ok) return { ok: false, failure: launch.failure };
  if (launch.value.attemptId !== input.record.attemptId || !launch.value.digest) {
    return { ok: false, reason: ANSWER_PIN_NOTICE };
  }

  const command: AnswerNeedsInputCommand = {
    requestId: input.requestId,
    expectedRevision: detail.value.job.revision,
    jobId: input.record.jobId,
    expectedAttemptRevision: live.attemptRevision,
    attemptId: input.record.attemptId,
    launchId: input.record.launchId,
    threadId: input.record.threadId,
    waitId: live.waitId,
    answers: covered.answers,
    expectedProcessVersionId: processVersionId,
    expectedSnapshotDigest: launch.value.digest,
    expectedProcessInstructionsHash: await sha256Utf8(process.instructions),
    expectedProcessAcceptanceHash: await sha256Utf8(process.acceptance),
    expectedJobBriefHash: await sha256Utf8(detail.value.job.brief),
    expectedJobAcceptanceHash: await sha256Utf8(detail.value.job.acceptance),
  };

  const sent = await persistAnswerNeedsInput(api, command);
  if (!sent.ok) return { ok: false, failure: sent.failure };
  return { ok: true, value: sent.value };
}
