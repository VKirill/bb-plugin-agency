import { useEffect, useState } from "react";
import { Button } from "./shared";
import type { Job, TaskFile } from "./data";
import type { AgencyApi } from "../data/agency-api";
import {
  ACCEPT_NO_TARGET_NOTICE,
  ACCEPT_STALE_SELECTION_NOTICE,
  acceptSelectionKey,
  acceptSelectionStillLive,
  fileToAcceptTarget,
  provenAcceptFiles,
  resolveAcceptTarget,
} from "../data/job-lifecycle";
import { failureNotice, persistAcceptThenDone } from "../data/persist";

const NONE = "none";

export function JobAcceptControls({
  job,
  files,
  api,
  demoMode,
  notice,
  onAccepted,
}: {
  job: Job;
  files: TaskFile[];
  api: AgencyApi;
  demoMode: boolean;
  notice: (text: string) => void;
  onAccepted: (text: string) => void;
}) {
  const proven = provenAcceptFiles(files);
  const [selectedKey, setSelectedKey] = useState(NONE);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (selectedKey === NONE) return;
    if (acceptSelectionStillLive(files, selectedKey)) return;
    setSelectedKey(NONE);
    notice(ACCEPT_STALE_SELECTION_NOTICE);
  }, [files, selectedKey, notice]);

  const accept = async () => {
    if (pending) return;
    if (demoMode) {
      onAccepted("Вы приняли результат в примере.");
      return;
    }
    const resolved = resolveAcceptTarget(files, selectedKey === NONE ? "" : selectedKey);
    if (!resolved.ok) {
      if (selectedKey !== NONE && !acceptSelectionStillLive(files, selectedKey)) {
        setSelectedKey(NONE);
      }
      notice(resolved.reason);
      return;
    }
    if (!job.recordId || job.revision == null) {
      notice(ACCEPT_NO_TARGET_NOTICE);
      return;
    }
    setPending(true);
    const result = await persistAcceptThenDone(api, {
      expectedRevision: job.revision,
      jobId: job.recordId,
      artifactId: resolved.target.artifactId,
      version: resolved.target.version,
      hash: resolved.target.hash,
    });
    setPending(false);
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    onAccepted(`Вы приняли версию ${resolved.target.version}.`);
  };

  return (
    <div className="mt-4 space-y-2" data-testid="job-accept-controls">
      {proven.length > 0 && !demoMode && (
        <div className="flex flex-wrap gap-2" data-testid="accept-version-list" role="group" aria-label="Версия для приёмки">
          {proven.map((file) => {
            const target = fileToAcceptTarget(file);
            if (!target) return null;
            const key = acceptSelectionKey(target);
            return (
              <Button
                key={key}
                size="sm"
                variant={selectedKey === key ? "default" : "outline"}
                data-testid={`accept-opt-${target.version}`}
                aria-pressed={selectedKey === key}
                onClick={() => setSelectedKey(key)}
              >
                {file.name} · v{target.version} · {target.hash.slice(0, 8)}
              </Button>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          data-testid="accept-result"
          disabled={pending}
          onClick={() => void accept()}
        >
          {pending ? "Принимаем…" : "Принять результат"}
        </Button>
      </div>
    </div>
  );
}
