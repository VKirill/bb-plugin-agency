import type { MutationFailure, MutationOutcome } from "./envelope";
import { clearFileDraft } from "./job-record-patch";

export function beginExclusiveSave(saving: boolean): boolean {
  return !saving;
}

export function shouldClearDraftAfterSave(submitted: string, latestDraft: string | undefined): boolean {
  return latestDraft === undefined || latestDraft === submitted;
}

export function canLeaveAfterSave(ok: boolean): boolean {
  return ok;
}

export function applyDraftsAfterSave(
  drafts: Record<string, string>,
  fileIds: readonly string[],
  submitted: string,
): Record<string, string> {
  const latest = fileIds.map((id) => drafts[id]).find((value): value is string => value !== undefined);
  if (!shouldClearDraftAfterSave(submitted, latest)) return drafts;
  return fileIds.reduce((current, id) => clearFileDraft(current, id), drafts);
}

export function saveThrownMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "Не удалось сохранить файл.";
}

export async function commitDocumentSave<T>(input: {
  savingRef: { current: boolean };
  persist: () => Promise<MutationOutcome<T>>;
  afterSuccess?: (value: T) => Promise<void>;
  failureMessage: (failure: MutationFailure) => string;
}): Promise<{ ok: true; value: T } | { ok: false; error: string | null }> {
  if (!beginExclusiveSave(input.savingRef.current)) return { ok: false, error: null };
  input.savingRef.current = true;
  try {
    const result = await input.persist();
    if (!result.ok) return { ok: false, error: input.failureMessage(result.failure) };
    if (input.afterSuccess) await input.afterSuccess(result.value);
    return { ok: true, value: result.value };
  } catch (error) {
    return { ok: false, error: saveThrownMessage(error) };
  } finally {
    input.savingRef.current = false;
  }
}
