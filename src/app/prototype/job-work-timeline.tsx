import { ThreadChat, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "./shared";
import { canOpenNativeThread } from "../data/job-work-thread";

/** Same public contained contract as MoA: bounded parent, host fills with h-full. */
export function JobWorkTimeline({ threadId }: { threadId: string | null }) {
  const navigate = useBbNavigate();
  if (!threadId) return null;
  const openSupported = canOpenNativeThread(navigate);
  return (
    <section aria-label="Подробности работы" className="space-y-2" data-testid="job-work-timeline">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {openSupported && (
          <Button size="sm" variant="ghost" onClick={() => navigate.toThread(threadId)}>
            Открыть тред
          </Button>
        )}
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-muted-foreground">Подробности работы</summary>
        <div
          className="mt-2 h-96 max-h-[24rem] min-h-0 overflow-hidden rounded-lg border border-border"
          data-testid="job-work-timeline-frame"
        >
          <ThreadChat key={threadId} threadId={threadId} variant="timeline" layout="contained" />
        </div>
      </details>
    </section>
  );
}
