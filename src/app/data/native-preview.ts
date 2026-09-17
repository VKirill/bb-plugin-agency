import { tr } from "../i18n";

/** Server preview after openArtifact hash check. UI never invents host or path. */
export type OpenedArtifactPreview = {
  hostId?: string;
  target?: { hostId?: string; path?: string };
  demo?: boolean;
};

export type NativePreviewTarget = { hostId: string; path: string };

export function nativePreviewFromOpen(
  opened: OpenedArtifactPreview,
): { ok: true; target: NativePreviewTarget } | { ok: false; message: string } {
  if (opened.demo === true) {
    return { ok: false, message: tr("Это демо-копия. Реальный файл так не открывается.") };
  }
  const hostId = opened.target?.hostId;
  const path = opened.target?.path;
  if (!hostId || !path) {
    return { ok: false, message: tr("Не удалось открыть документ в панели BB.") };
  }
  return { ok: true, target: { hostId, path } };
}
