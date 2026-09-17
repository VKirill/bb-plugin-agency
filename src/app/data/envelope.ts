import { tr } from "../i18n";
import type { RevisionConflict } from "../../shared/contracts";

export type DomainError = { code: string; message: string };

export type DomainResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DomainError };

export const UNKNOWN_CALLER_MESSAGE =
  "Сервер отклонил вызов: неизвестный вызывающий. Это ошибка доступа, не пустой каталог.";

export type MutationFailure =
  | { kind: "revision_conflict"; conflict: RevisionConflict }
  | { kind: "domain"; error: DomainError }
  | { kind: "gated"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "transport"; message: string };

export type MutationOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; failure: MutationFailure };

export function isUnknownRpcMethod(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unknown (rpc )?method|method .* not (found|registered)|invalid method|no such method/i.test(message);
}

export function parseDomainResult<T>(raw: unknown): MutationOutcome<T> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, failure: { kind: "transport", message: tr("Пустой ответ сервера.") } };
  }
  const record = raw as Record<string, unknown>;
  if (record.code === "revision_conflict" && typeof record.actualRevision === "number") {
    return {
      ok: false,
      failure: {
        kind: "revision_conflict",
        conflict: {
          code: "revision_conflict",
          expectedRevision: Number(record.expectedRevision),
          actualRevision: Number(record.actualRevision),
          requestId: String(record.requestId ?? ""),
        },
      },
    };
  }
  if (record.ok === true && "value" in record) {
    return { ok: true, value: record.value as T };
  }
  if (record.ok === false && record.error && typeof record.error === "object") {
    const error = record.error as DomainError;
    if (error.code === "revision_conflict") {
      return parseDomainResult({ ...error, code: "revision_conflict" });
    }
    if (error.code === "unknown_caller") {
      return { ok: false, failure: { kind: "gated", message: UNKNOWN_CALLER_MESSAGE } };
    }
    return { ok: false, failure: { kind: "domain", error: { code: error.code, message: error.message } } };
  }
  return {
    ok: false,
    failure: {
      kind: "transport",
      message: tr("Сервер вернул ответ без ok/value и без error — исход вызова неизвестен, не успех."),
    },
  };
}

export function isUnknownCaller(error: DomainError | MutationFailure): boolean {
  if ("kind" in error) {
    return error.kind === "gated" || (error.kind === "domain" && error.error.code === "unknown_caller");
  }
  return error.code === "unknown_caller";
}

export function conflictMessage(conflict: RevisionConflict): string {
  return tr("Запись уже изменена (ревизия {actual}, ожидали {expected}). Загрузите серверную версию или повторите правку.", {
    actual: conflict.actualRevision,
    expected: conflict.expectedRevision,
  });
}
