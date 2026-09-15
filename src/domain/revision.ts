import type { ChangeCommand, RevisionConflict } from "../shared/contracts";
import { fail, ok, type DomainResult } from "./result";

export function nextRevision(current: number): number {
  return current + 1;
}

export function matchRevision(
  recordRevision: number,
  command: ChangeCommand,
): DomainResult<{ nextRevision: number }> {
  if (command.expectedRevision !== recordRevision) {
    const conflict: RevisionConflict = {
      code: "revision_conflict",
      expectedRevision: command.expectedRevision,
      actualRevision: recordRevision,
      requestId: command.requestId,
    };
    return fail(conflict.code, `revision ${conflict.expectedRevision} != ${conflict.actualRevision}`);
  }
  return ok({ nextRevision: nextRevision(recordRevision) });
}
