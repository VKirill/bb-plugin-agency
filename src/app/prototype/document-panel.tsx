import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useBbNavigate, useRpc, type PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import { FileWorkspace } from "./file-workspace";
import "./job-detail.css";
import type { TaskFile } from "./data";
import { rpcContract } from "../../shared/rpc-contract";
import { createRpcAgencyApi, type RpcCaller } from "../data";
import {
  applyRestoredSaveResult,
  commitRestoredDocumentSave,
  openerHostId,
  restoreDocumentFromPreview,
  restoreFailureMessage,
  shouldUseHostOriginal,
  startRestoredSave,
  type RestoredDocument,
  type RestoredPanelState,
} from "../data/document-restore";
import {
  claimDocumentPanel,
  isDocumentPanelVisible,
  releaseDocumentPanel,
  subscribeDocumentVisibility,
} from "../data/document-visibility";

export const documentSessionId = crypto.randomUUID();
const targets = new Map<string, { jobId: string; fileId: string }>();
export const registerDocumentTarget = (path: string, jobId: string, fileId: string) => targets.set(path, { jobId, fileId });
type Document = {
  jobId: string;
  file: TaskFile;
  draft: string;
  onDraft: (s: string) => void;
  onSave: (content?: string) => void;
  close: () => void;
  select: (f: TaskFile) => void;
  files: TaskFile[];
  persisted?: boolean;
  saving?: boolean;
  error?: string | null;
};
let document: Document | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const emit = () => listeners.forEach((l) => l());
export const publishDocument = (value: Document | null) => {
  document = value;
  emit();
};
export const useDocumentVisible = (jobId: string) =>
  useSyncExternalStore(
    subscribeDocumentVisibility,
    () => isDocumentPanelVisible(jobId),
    () => false,
  );

export function DocumentPanel({ path, source, Original }: PluginFileOpenerProps) {
  const target = targets.get(path);
  const doc = useSyncExternalStore(subscribe, () => document, () => null);
  const matches = Boolean(doc && target?.jobId === doc.jobId && target.fileId === doc.file.id);
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const api = useMemo(() => createRpcAgencyApi(rpc as unknown as RpcCaller), [rpc]);
  const hostId = openerHostId(source);
  const [allowRestore, setAllowRestore] = useState(() => !targets.has(path));
  const [restored, setRestored] = useState<RestoredDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [useOriginal, setUseOriginal] = useState(() => shouldUseHostOriginal(hostId));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const railJobId = matches && doc ? doc.jobId : restored && !loading && !useOriginal ? restored.jobId : null;
  useEffect(() => {
    if (railJobId) claimDocumentPanel(path, railJobId);
    else releaseDocumentPanel(path);
    return () => releaseDocumentPanel(path);
  }, [path, railJobId]);

  useEffect(() => {
    if (matches) {
      setAllowRestore(false);
      setRestored(null);
      setLoadError(null);
      setSaveError(null);
      setUseOriginal(false);
      return;
    }
    if (!targets.has(path)) {
      setAllowRestore(true);
      return;
    }
    const timer = window.setTimeout(() => setAllowRestore(true), 0);
    return () => window.clearTimeout(timer);
  }, [path, matches]);

  useEffect(() => {
    if (matches || !allowRestore) return;
    if (shouldUseHostOriginal(hostId)) {
      setUseOriginal(true);
      setLoading(false);
      setRestored(null);
      setLoadError(null);
      return;
    }
    let live = true;
    setLoading(true);
    setUseOriginal(false);
    setLoadError(null);
    void restoreDocumentFromPreview(api, { hostId: hostId!, path }).then((outcome) => {
      if (!live) return;
      setLoading(false);
      if (!outcome.ok) {
        const code = outcome.failure.kind === "domain" ? outcome.failure.error.code : undefined;
        if (shouldUseHostOriginal(hostId, code)) {
          setUseOriginal(true);
          return;
        }
        setUseOriginal(false);
        setRestored(null);
        setLoadError(restoreFailureMessage(outcome));
        return;
      }
      registerDocumentTarget(path, outcome.value.jobId, outcome.value.file.id);
      setRestored(outcome.value);
      setDraft(outcome.value.file.content);
    });
    return () => {
      live = false;
    };
  }, [allowRestore, api, hostId, matches, path]);

  const saveRestored = (content?: string) => {
    if (!restored || savingRef.current) return;
    const current: RestoredPanelState = { document: restored, draft, saveError, saving };
    const started = startRestoredSave(current);
    if (!started) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    const text = content ?? draft;
    void commitRestoredDocumentSave(api, {
      jobId: restored.jobId,
      bindingId: restored.bindingId,
      file: restored.file,
      content: text,
    }).then((outcome) => {
      savingRef.current = false;
      const next = applyRestoredSaveResult({ ...started, draft: draftRef.current }, outcome);
      setSaving(next.saving);
      setSaveError(next.saveError);
      if (!outcome.ok) return;
      setRestored(next.document);
      setDraft(next.draft);
      registerDocumentTarget(outcome.value.target.path, outcome.value.jobId, outcome.value.file.id);
      navigate.experimental_openFilePreview({
        target: { kind: "host", hostId: outcome.value.target.hostId, path: outcome.value.target.path },
        location: null,
      });
    });
  };

  if (matches && doc) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden p-3">
        <FileWorkspace
          key={doc.file.id}
          file={doc.file}
          draft={doc.draft}
          onDraft={doc.onDraft}
          onSave={doc.onSave}
          close={doc.close}
          nativePanel
          persisted={Boolean(doc.persisted)}
          saving={Boolean(doc.saving)}
          error={doc.error}
        />
      </div>
    );
  }

  if (loading) {
    return <p className="p-4 text-sm text-muted-foreground">Восстанавливаем документ…</p>;
  }
  if (loadError) {
    return <p className="p-4 text-sm text-muted-foreground">{loadError}</p>;
  }
  if (useOriginal || !restored) return <Original />;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-3">
      <FileWorkspace
        key={restored.file.id}
        file={restored.file}
        draft={draft}
        onDraft={setDraft}
        onSave={saveRestored}
        close={() => undefined}
        nativePanel
        persisted
        saving={saving}
        error={saveError}
      />
    </div>
  );
}
