import { tr } from "../i18n";
import type { TaskFile } from "../prototype/data";
import type { AgencyApi } from "./agency-api";
import { decodeArtifactBytes } from "./content-hash";
import { shouldClearDraftAfterSave } from "./document-save";
import { nativePreviewFromOpen } from "./native-preview";
import { failureNotice, openPersistedArtifact, persistArtifactUpload } from "./persist";
import type { MutationOutcome } from "./envelope";
import type { ResolvedArtifactPreview } from "./store-commands";

export type RestoredDocument = {
  file: TaskFile;
  jobId: string;
  bindingId: string;
};

export function openerHostId(source: { experimental_hostId?: string }): string | null {
  const hostId = source.experimental_hostId?.trim();
  return hostId || null;
}

export function fileFromResolvedPreview(
  resolved: ResolvedArtifactPreview,
  bytesBase64: string,
): TaskFile {
  const name = resolved.relativePath.split("/").filter(Boolean).at(-1) || resolved.relativePath;
  const kind = resolved.mime.startsWith("image/") ? "image" : "text";
  return {
    id: resolved.artifactId,
    name,
    size: resolved.size,
    content: decodeArtifactBytes(bytesBase64, kind, name),
    kind,
    version: resolved.version,
    hash: resolved.hash,
    mime: resolved.mime,
  };
}

/** Identity from resolver; bytes only from openArtifact. Path is not a file grant. */
export async function restoreDocumentFromPreview(
  api: AgencyApi,
  input: { hostId: string; path: string },
): Promise<MutationOutcome<RestoredDocument>> {
  const resolved = await api.resolveArtifactPreview({ hostId: input.hostId, path: input.path });
  if (!resolved.ok) return resolved;
  const opened = await openPersistedArtifact(api, {
    artifactId: resolved.value.artifactId,
    jobId: resolved.value.jobId,
    version: resolved.value.version,
    expectedHash: resolved.value.hash,
  });
  if (!opened.ok) return opened;
  if (
    opened.value.target.hostId !== resolved.value.target.hostId ||
    opened.value.target.path !== resolved.value.target.path
  ) {
    return {
      ok: false,
      failure: {
        kind: "domain",
        error: { code: "preview_mismatch", message: tr("Цель превью не совпала с открытой версией.") },
      },
    };
  }
  return {
    ok: true,
    value: {
      file: fileFromResolvedPreview(resolved.value, opened.value.bytesBase64),
      jobId: resolved.value.jobId,
      bindingId: resolved.value.bindingId,
    },
  };
}

/** Ordinary files and tabs without host stay on BB Original. Agency identity errors stay in the panel. */
export function shouldUseHostOriginal(hostId: string | null, failureCode?: string): boolean {
  if (!hostId) return true;
  return failureCode === "preview_unresolved";
}

export async function saveRestoredDocument(
  api: AgencyApi,
  jobId: string,
  file: TaskFile,
  content: string,
): Promise<MutationOutcome<TaskFile>> {
  const next = {
    ...file,
    content,
    size: new TextEncoder().encode(content).length,
    version: (file.version || 1) + 1,
  };
  const published = await persistArtifactUpload(api, jobId, next);
  if (!published.ok) return published;
  return {
    ok: true,
    value: {
      ...next,
      id: published.value.artifactId,
      version: published.value.version,
      hash: published.value.hash,
      size: published.value.size,
    },
  };
}

export type RestoredSaveOk = RestoredDocument & {
  target: { hostId: string; path: string };
};

export type RestoredPanelState = {
  document: RestoredDocument;
  draft: string;
  saveError: string | null;
  saving: boolean;
};

export function startRestoredSave(state: RestoredPanelState): RestoredPanelState | null {
  if (state.saving) return null;
  return { ...state, saving: true, saveError: null };
}

export function applyRestoredSaveResult(
  state: RestoredPanelState,
  outcome: MutationOutcome<RestoredSaveOk>,
): RestoredPanelState {
  if (!outcome.ok) {
    return { ...state, saving: false, saveError: restoreFailureMessage(outcome) };
  }
  const saved = outcome.value.file.content;
  return {
    document: {
      file: outcome.value.file,
      jobId: outcome.value.jobId,
      bindingId: outcome.value.bindingId,
    },
    draft: shouldClearDraftAfterSave(saved, state.draft) ? saved : state.draft,
    saveError: null,
    saving: false,
  };
}

export async function commitRestoredDocumentSave(
  api: AgencyApi,
  input: { jobId: string; bindingId: string; file: TaskFile; content: string },
): Promise<MutationOutcome<RestoredSaveOk>> {
  const published = await saveRestoredDocument(api, input.jobId, input.file, input.content);
  if (!published.ok) return published;
  const opened = await openPersistedArtifact(api, {
    artifactId: published.value.id,
    jobId: input.jobId,
    version: published.value.version || 1,
    expectedHash: published.value.hash,
  });
  if (!opened.ok) return opened;
  const preview = nativePreviewFromOpen(opened.value);
  if (!preview.ok) {
    return { ok: false, failure: { kind: "domain", error: { code: "preview_mismatch", message: preview.message } } };
  }
  return {
    ok: true,
    value: {
      file: published.value,
      jobId: input.jobId,
      bindingId: input.bindingId,
      target: preview.target,
    },
  };
}

export function restoreFailureMessage(outcome: MutationOutcome<unknown>): string {
  if (outcome.ok) return "";
  if (outcome.failure.kind === "domain") {
    const code = outcome.failure.error.code;
    if (code === "preview_unresolved") return tr("Этот файл не является документом агентства. Откройте его из задачи.");
    if (code === "preview_mismatch" || code === "preview_ambiguous" || code === "not_found") {
      return tr("Не удалось восстановить документ. Откройте его снова из задачи.");
    }
  }
  return failureNotice(outcome.failure);
}
