import { useState, type ReactNode } from "react";
import type { ActionIntentRecord, DispatcherApi, ListedActionIntent } from "../data/dispatcher";
import {
  DISPATCHER_EMPTY,
  INTENT_APPROVE_HINT,
  INTENT_CLAIM_HINT,
  INTENT_LAUNCH_UNAVAILABLE,
  INTENT_STATE_LABEL,
  intentCatalogHeading,
  intentCatalogSubline,
  intentLaunchBlocked,
  intentTechnicalSummary,
  nextIntentUiAction,
} from "../data/dispatcher";
import { failureNotice } from "../data/persist";
import { Button } from "./shared";

export function TechnicalDetails({ children }: { children: ReactNode }) {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">Технические подробности</summary>
      <div className="mt-2 space-y-1 font-mono">{children}</div>
    </details>
  );
}

export function DispatcherIntentList({
  intents,
  api,
  notice,
  onChanged,
  allowClaim,
}: {
  intents: readonly ListedActionIntent[];
  api: Pick<DispatcherApi, "approveActionIntent" | "claimActionIntent">;
  notice: (text: string) => void;
  onChanged: () => void;
  allowClaim: boolean;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  if (!intents.length) {
    return <p className="text-sm text-muted-foreground" data-testid="dispatcher-intents-empty">{DISPATCHER_EMPTY}</p>;
  }
  return (
    <ul className="divide-y divide-border border-y border-border" data-testid="dispatcher-intent-list" aria-label="Согласование правил">
      {intents.map((intent) => {
        const action = nextIntentUiAction(intent);
        const blocked = intentLaunchBlocked(intent);
        return (
          <li key={intent.id} className="flex flex-wrap items-center justify-between gap-2 py-3" data-testid={`dispatcher-intent-${intent.id}`}>
            <div className="min-w-0">
              <p className="text-sm font-medium">{intentCatalogHeading(intent)}</p>
              <p className="mt-1 text-xs text-muted-foreground">{intentCatalogSubline(intent)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {action === "approve" && (
                <Button
                  size="sm"
                  data-testid={`dispatcher-approve-${intent.id}`}
                  disabled={pendingId === intent.id}
                  onClick={() => void runApprove(api, intent, notice, onChanged, setPendingId)}
                >
                  Согласовать
                </Button>
              )}
              {allowClaim && action === "claim" && (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`dispatcher-claim-${intent.id}`}
                  disabled={pendingId === intent.id}
                  onClick={() => void runClaim(api, intent.id, notice, onChanged, setPendingId)}
                >
                  Взять в работу
                </Button>
              )}
            </div>
            {blocked && (
              <p className="w-full text-xs text-muted-foreground" data-testid={`dispatcher-unavailable-${intent.id}`}>
                {INTENT_LAUNCH_UNAVAILABLE}
              </p>
            )}
            <div className="w-full">
              <TechnicalDetails>
                <p>{intentTechnicalSummary(intent)}</p>
              </TechnicalDetails>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

async function runApprove(
  api: Pick<DispatcherApi, "approveActionIntent">,
  intent: ActionIntentRecord,
  notice: (text: string) => void,
  onChanged: () => void,
  setPendingId: (id: string | null) => void,
) {
  setPendingId(intent.id);
  const result = await api.approveActionIntent({
    requestId: crypto.randomUUID(),
    expectedRevision: intent.revision,
    intentId: intent.id,
  });
  setPendingId(null);
  if (!result.ok) {
    notice(failureNotice(result.failure));
    return;
  }
  notice(`${INTENT_APPROVE_HINT} Сейчас: ${INTENT_STATE_LABEL[result.value.state]}.`);
  onChanged();
}

async function runClaim(
  api: Pick<DispatcherApi, "claimActionIntent">,
  intentId: string,
  notice: (text: string) => void,
  onChanged: () => void,
  setPendingId: (id: string | null) => void,
) {
  setPendingId(intentId);
  const result = await api.claimActionIntent({
    requestId: crypto.randomUUID(),
    intentId,
    live: false,
    leaseOwner: "agency-ui",
    leaseMs: 60_000,
  });
  setPendingId(null);
  if (!result.ok) {
    notice(failureNotice(result.failure));
    return;
  }
  notice(INTENT_CLAIM_HINT);
  onChanged();
}
