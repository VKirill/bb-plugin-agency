import { useCallback, useEffect, useState } from "react";
import { useBbContext, useComposerView, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../shared/rpc-contract";
import type { SessionEffectiveMode, SessionPolicyMode, SessionPolicyView } from "../shared/contracts/session-policy";
import { tr } from "./i18n";
import { composerModeLabel, effectiveModeLabel, SESSION_MODE_OPTIONS, userSessionChoice } from "./session-mode-copy";
import { Icon } from "../../components/ui/icon";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../../components/ui/select";

function newRequestId(): string {
  return crypto.randomUUID();
}

function connectedIds(scope: ReturnType<typeof useComposerView>["scope"]): { bbProjectId?: string; threadId?: string } {
  if (scope.kind === "thread" || scope.kind === "queued-message") {
    return { threadId: scope.threadId };
  }
  if (scope.kind === "side-chat") {
    return { bbProjectId: scope.projectId, threadId: scope.childThreadId ?? scope.parentThreadId };
  }
  return { bbProjectId: scope.projectId ?? undefined };
}

/** Session mode in the composer action row, left of MoA / voice / submit. */
export function ComposerSessionBanner() {
  const rpc = useRpc<typeof rpcContract>();
  const view = useComposerView();
  const bb = useBbContext();
  const scoped = connectedIds(view.scope);
  const ids = {
    bbProjectId: scoped.bbProjectId ?? bb.projectId ?? undefined,
    threadId: scoped.threadId ?? (view.scope.kind === "thread" ? view.scope.threadId : undefined) ?? bb.threadId ?? undefined,
  };
  const [policy, setPolicy] = useState<SessionPolicyView | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    if (!ids.bbProjectId && !ids.threadId) {
      setPolicy(null);
      return;
    }
    void rpc
      .call("getSessionPolicy", { bbProjectId: ids.bbProjectId, threadId: ids.threadId })
      .then((result) => {
        if (result.ok) setPolicy(result.value);
      })
      .catch(() => undefined);
  }, [rpc, ids.bbProjectId, ids.threadId]);
  useEffect(() => {
    load();
  }, [load]);
  useRealtime("domain-changed", load);
  const canOverride =
    (Boolean(ids.threadId) && view.scope.kind !== "new-thread") ||
    (view.scope.kind === "new-thread" && Boolean(ids.bbProjectId));
  const setMode = async (mode: SessionPolicyMode) => {
    const current = userSessionChoice(policy && policy.layers.thread !== "inherit" ? policy.layers.thread : (policy?.effective ?? "pm"));
    if (mode === current) return;
    setBusy(true);
    try {
      if (ids.threadId && view.scope.kind !== "new-thread") {
        await rpc.call("saveSessionPolicy", { requestId: newRequestId(), scope: "thread", scopeId: ids.threadId, mode });
      } else if (ids.bbProjectId) {
        await rpc.call("saveSessionPolicy", { requestId: newRequestId(), scope: "project", scopeId: ids.bbProjectId, mode });
      }
      load();
    } finally {
      setBusy(false);
    }
  };
  const effective = (policy?.effective ?? "pm") as SessionEffectiveMode;
  const shortLabel = tr(composerModeLabel(effective));
  const fullLabel = `${tr("Агентство")}: ${tr(effectiveModeLabel(effective))}`;
  return (
    <span className="inline-flex w-fit shrink-0">
      <Select
        value={userSessionChoice(effective)}
        onValueChange={(mode) => void setMode(mode as SessionPolicyMode)}
        disabled={busy || !canOverride}
      >
        <SelectTrigger
          data-testid="agency-session-banner"
          aria-label={tr("Режим чата Агентства")}
          title={
            view.scope.kind === "new-thread"
              ? fullLabel
              : canOverride
                ? fullLabel
                : tr("После отправки этот чат можно сменить на один раз.")
          }
          className="inline-flex h-7 w-fit max-w-fit shrink-0 flex-row items-center justify-center gap-1 border-0 bg-transparent px-1.5 text-xs font-normal text-muted-foreground shadow-none hover:bg-muted hover:text-foreground focus:ring-0 data-[state=open]:bg-muted data-[state=open]:text-foreground [&>span]:line-clamp-none [&>span]:inline [&>span]:max-w-none"
        >
          <Icon name="Bot" className="size-3.5 shrink-0" />
          <span className="whitespace-nowrap">{shortLabel}</span>
        </SelectTrigger>
        <SelectContent align="start" className="min-w-44">
          {SESSION_MODE_OPTIONS.map((choice) => (
            <SelectItem key={choice.value} value={choice.value}>
              {tr(choice.label)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </span>
  );
}
